"""认证:密码哈希(bcrypt)、JWT 签发/校验、当前用户依赖。"""
import os
import secrets
import stat
import warnings
from datetime import datetime, timedelta, timezone
from pathlib import Path

import bcrypt
import jwt
from dotenv import load_dotenv
from fastapi import Cookie, Header, HTTPException

from storage import db

_PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
load_dotenv(_PROJECT_ROOT / ".env")

_ALGO = "HS256"
_TOKEN_TTL = timedelta(hours=24)
_MIN_SECRET_LEN = 32
# 模板里给的占位值,误用等于没有密钥
_PLACEHOLDER_SECRETS = {
    "change-me-to-a-long-random-string",
    "change-me",
    "secret",
    "changeme",
}
# 开发兜底密钥的落盘位置(不入库)。不落盘的话每次重启都换密钥,
# 且多 worker 时每个进程各持一份,互相签发的 token 都验不过。
_DEV_SECRET_FILE = _PROJECT_ROOT / ".jwt_secret"


def _validate_secret(secret: str) -> str:
    if secret in _PLACEHOLDER_SECRETS:
        raise RuntimeError(
            "CHROMA_JWT_SECRET 仍是 .env.example 里的占位值,请换成随机串:"
            "\n  python3 -c \"import secrets; print(secrets.token_urlsafe(48))\""
        )
    if len(secret) < _MIN_SECRET_LEN:
        raise RuntimeError(
            f"CHROMA_JWT_SECRET 太短({len(secret)} 字符),至少需要 {_MIN_SECRET_LEN} 字符"
        )
    return secret


def _load_dev_secret() -> str:
    """未配置密钥时生成一份并落盘复用,保证重启/多 worker 之间登录态不失效。"""
    try:
        existing = _DEV_SECRET_FILE.read_text(encoding="utf-8").strip()
        if len(existing) >= _MIN_SECRET_LEN:
            return existing
    except FileNotFoundError:
        pass
    secret = secrets.token_urlsafe(48)
    try:
        # 先以 0600 创建再写入,避免密钥在权限收紧前可被同机其他用户读到
        fd = os.open(_DEV_SECRET_FILE, os.O_WRONLY | os.O_CREAT | os.O_EXCL, stat.S_IRUSR | stat.S_IWUSR)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(secret)
        return secret
    except FileExistsError:
        # 并发启动时另一个 worker 已写入,用它的
        return _DEV_SECRET_FILE.read_text(encoding="utf-8").strip()


def _resolve_secret() -> str:
    configured = os.environ.get("CHROMA_JWT_SECRET", "").strip()
    if configured:
        return _validate_secret(configured)
    if os.environ.get("CHROMA_ENV", "").strip().lower() in ("production", "prod"):
        raise RuntimeError(
            "生产环境(CHROMA_ENV=production)必须显式配置 CHROMA_JWT_SECRET,"
            "不能用随机兜底密钥"
        )
    warnings.warn(
        f"未配置 CHROMA_JWT_SECRET,已生成开发用密钥并写入 {_DEV_SECRET_FILE.name}"
        "(已加入 .gitignore)。生产环境请显式配置。",
        stacklevel=2,
    )
    return _load_dev_secret()


_SECRET = _resolve_secret()


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
