"""登录/注册限流:按 IP 计数,失败超阈值返回 429。进程内内存实现。"""
import time
from collections import defaultdict

_MAX_FAILURES = 5
_WINDOW_SECONDS = 300

_failures = defaultdict(list)  # ip -> [timestamp, ...]


def _prune(ip: str, now: float):
    _failures[ip] = [t for t in _failures[ip] if now - t < _WINDOW_SECONDS]


def is_blocked(ip: str) -> bool:
    now = time.time()
    _prune(ip, now)
    return len(_failures[ip]) >= _MAX_FAILURES


def record_failure(ip: str):
    _failures[ip].append(time.time())


def reset(ip: str):
    _failures.pop(ip, None)
