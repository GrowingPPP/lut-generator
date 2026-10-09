"""创建或重置一个本地账号。

用法:
    cd backend && ../.venv/bin/python scripts/create_user.py [用户名] [密码]
    # 或走 Makefile
    make admin                       # 默认 admin / 12345678
    make admin USER=me PASS=secret123

已有同名用户时**重置密码**而非报错 —— 这个脚本的主要用途就是找回本地账号
(测试套件曾把开发库的用户删掉,见 backend/conftest.py 的说明)。

密码哈希复用 `api/auth.py` 的 `hash_password`,不在脚本里另写一份 bcrypt 调用:
两处实现必然漂移(bcrypt 的 72 字节截断规则就很容易写漏)。
"""
import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND))

from api.auth import hash_password  # noqa: E402
from storage import db  # noqa: E402

DEFAULT_USER = "admin"
DEFAULT_PASS = "12345678"
MIN_LEN, MAX_LEN = 8, 72          # 与 api/main.py 的注册校验保持一致


def main(argv: list) -> int:
    # Make 传空串(`$(NAME)` 未指定时)要落回默认值,不能被当成空用户名/空密码
    username = (argv[0] if len(argv) > 0 and argv[0].strip() else DEFAULT_USER).strip()
    password = argv[1] if len(argv) > 1 and argv[1] else DEFAULT_PASS

    if not username:
        print("用户名不能为空", file=sys.stderr)
        return 2
    if not (MIN_LEN <= len(password) <= MAX_LEN):
        print(f"密码长度需在 {MIN_LEN}~{MAX_LEN} 之间(注册接口同样的限制)", file=sys.stderr)
        return 2

    db.init_db()
    existing = db.get_user_by_username(username)
    if existing:
        db.set_user_password(existing["id"], hash_password(password))
        print(f"已重置密码:{username}(id={existing['id']})")
        print("该用户已签发的 token 已全部失效(改密码会递增 token_version)。")
    else:
        uid = db.create_user(username, hash_password(password))
        print(f"已创建账号:{username}(id={uid})")

    print(f"现在可以用 {username} / {password} 登录。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
