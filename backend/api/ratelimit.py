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
