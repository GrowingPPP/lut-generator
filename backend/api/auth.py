"""认证:密码哈希(bcrypt)、JWT 签发/校验、当前用户依赖。"""
import os
import secrets
import warnings
from datetime import datetime, timedelta, timezone
from pathlib import Path

import bcrypt
import jwt
from dotenv import load_dotenv
from fastapi import Cookie, Header, HTTPException

from storage import db

load_dotenv(Path(__file__).resolve().parent.parent.parent / ".env")

_SECRET = os.environ.get("CHROMA_JWT_SECRET")
if not _SECRET:
    _SECRET = secrets.token_urlsafe(32)
    warnings.warn("未配置 CHROMA_JWT_SECRET,已使用随机密钥(重启后需重新登录)", stacklevel=2)
_ALGO = "HS256"
_TOKEN_TTL = timedelta(hours=24)


def _to_bcrypt_bytes(password: str) -> bytes:
    # bcrypt 仅处理前 72 字节,超长截断避免 ValueError
    return password.encode("utf-8")[:72]


def hash_password(password: str) -> str:
    return bcrypt.hashpw(_to_bcrypt_bytes(password), bcrypt.gensalt()).decode("utf-8")


def verify_password(password: str, password_hash: str) -> bool:
    try:
        return bcrypt.checkpw(_to_bcrypt_bytes(password), password_hash.encode("utf-8"))
    except ValueError:
        return False


# login 对不存在用户也做一次 dummy 校验,抹平时序防用户名枚举
DUMMY_HASH = bcrypt.hashpw(b"dummy-password-for-timing", bcrypt.gensalt()).decode("utf-8")


def create_token(user_id: int, token_version: int = 0) -> str:
    payload = {
        "sub": str(user_id),
        "ver": token_version,
        "exp": datetime.now(timezone.utc) + _TOKEN_TTL,
    }
    return jwt.encode(payload, _SECRET, algorithm=_ALGO)


def get_current_user(
    authorization: str = Header(default=""),
    chroma_token: str = Cookie(default=""),
) -> dict:
    """从 httpOnly cookie 或 Authorization header 解析当前用户。失败抛 401。"""
    token = ""
    if authorization.startswith("Bearer "):
        token = authorization[7:]
    elif chroma_token:
        token = chroma_token
    if not token:
        raise HTTPException(status_code=401, detail="未登录")
    try:
        payload = jwt.decode(token, _SECRET, algorithms=[_ALGO])
    except jwt.PyJWTError:
        raise HTTPException(status_code=401, detail="登录已过期,请重新登录")
    sub = payload.get("sub")
    if sub is None:
        raise HTTPException(status_code=401, detail="登录已过期,请重新登录")
    try:
        user_id = int(sub)
    except (TypeError, ValueError):
        raise HTTPException(status_code=401, detail="登录已过期,请重新登录")
    user = db.get_user(user_id)
    if not user:
        raise HTTPException(status_code=401, detail="用户不存在")
    if int(payload.get("ver", 0)) != int(user.get("token_version", 0)):
        raise HTTPException(status_code=401, detail="登录已过期,请重新登录")
    return user
