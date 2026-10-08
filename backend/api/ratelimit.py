"""登录/注册限流:按 IP 计数,失败超阈值返回 429。

进程内内存实现。**已知局限**:状态不跨进程共享,多 worker(uvicorn --workers N)
或多实例部署时,每个进程各自计数,实际阈值会被放大 N 倍。生产多 worker 部署
需要换成 Redis 或数据库等共享存储。
"""
import threading
import time
from collections import OrderedDict

_MAX_FAILURES = 5
_WINDOW_SECONDS = 300

# 自动修图:每用户每窗口的次数上限。
# 每次调用都会打一次 LLM(实测约 11.6s / 5000+ token),是整套接口里最贵的一个,
# 而登录限流是按 IP 的 —— 登录用户换 IP 不该成为绕过手段,所以这里按 user_id 计数。
AUTO_MAX_PER_WINDOW = 20
AUTO_WINDOW_SECONDS = 3600
# 单进程最多记多少个 IP,超过则淘汰最久未使用的,避免被大量来源 IP 撑爆内存
_MAX_TRACKED_IPS = 10000

_lock = threading.Lock()
_failures: OrderedDict[str, list] = OrderedDict()  # ip -> [timestamp, ...]


def _prune(ip: str, now: float) -> list:
    """丢掉窗口外的失败记录,返回剩下的。"""
    kept = [t for t in _failures.get(ip, ()) if now - t < _WINDOW_SECONDS]
    if kept:
        _failures[ip] = kept
        _failures.move_to_end(ip)
    else:
        _failures.pop(ip, None)
    return kept


def _evict_if_needed():
    while len(_failures) > _MAX_TRACKED_IPS:
        _failures.popitem(last=False)


def is_blocked(ip: str) -> bool:
    now = time.time()
    with _lock:
        return len(_prune(ip, now)) >= _MAX_FAILURES


def record_failure(ip: str):
    now = time.time()
    with _lock:
        kept = _prune(ip, now)
        kept.append(now)
        _failures[ip] = kept
        _failures.move_to_end(ip)
        _evict_if_needed()


def reset(ip: str):
    with _lock:
        _failures.pop(ip, None)


# ---- 自动修图限流(按用户,与登录的按 IP 分开) ----

_auto_calls: "OrderedDict[int, list]" = OrderedDict()
_auto_lock = threading.Lock()


def _prune_key(store, key, now: float, window: float) -> list:
    kept = [t for t in store.get(key, ()) if now - t < window]
    if kept:
        store[key] = kept
        store.move_to_end(key)
    else:
        store.pop(key, None)
    return kept


def auto_quota_exceeded(user_id: int) -> bool:
    """该用户是否已用尽自动修图配额。"""
    now = time.time()
    with _auto_lock:
        return len(_prune_key(_auto_calls, user_id, now, AUTO_WINDOW_SECONDS)) >= AUTO_MAX_PER_WINDOW


def record_auto_call(user_id: int) -> None:
    now = time.time()
    with _auto_lock:
        kept = _prune_key(_auto_calls, user_id, now, AUTO_WINDOW_SECONDS)
        kept.append(now)
        _auto_calls[user_id] = kept
        _auto_calls.move_to_end(user_id)
        while len(_auto_calls) > _MAX_TRACKED_IPS:
            _auto_calls.popitem(last=False)


def reset_auto(user_id: int) -> None:
    with _auto_lock:
        _auto_calls.pop(user_id, None)


def auto_retry_after(user_id: int) -> int:
    """距离下一次可用还有多少秒(用于 Retry-After 头)。"""
    now = time.time()
    with _auto_lock:
        kept = _prune_key(_auto_calls, user_id, now, AUTO_WINDOW_SECONDS)
    if not kept:
        return 0
    return max(1, int(AUTO_WINDOW_SECONDS - (now - min(kept))))
