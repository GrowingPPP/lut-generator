"""pytest 全局配置:**强制把测试指向独立数据库**。

## 为什么必须有这个文件

测试套件里多个文件用 `autouse` fixture 调用 `db.clear_users()` /
`db.clear_all()` / `db.clear_sessions()`(即 `DELETE FROM users` 等)。
而 `storage/db.py` 默认读 `.env` 的 `MYSQL_DATABASE` —— 也就是**开发库**。

结果:`make check`(README 推荐的提交前命令)会把开发者自己的账号、
LUT、会话全部删光。这不是假设,是实测复现过的:

    跑测试前  用户: ['admin']
    pytest tests/test_auth.py
    跑测试后  用户: ⚠ 表已空

## 做法

**在任何 storage.db 导入之前**把 `MYSQL_DATABASE` 覆盖成 `chroma_test`。
`storage/db.py` 在模块导入时就把配置读进 `_CONFIG`,所以这里的赋值必须
发生在它被 import 之前 —— pytest 保证 conftest.py 早于测试模块加载,
顶层语句(不是 fixture)因此是唯一可靠的时机。

`load_dotenv()` 默认**不覆盖**已存在的环境变量,所以 `.env` 里的
`MYSQL_DATABASE=chroma` 不会把这里的值改回去。

## 兜底

（另有一道闸门在 storage/db.py 的 `_assert_not_dev_database`:它拦住的是**调用**
本身,因此临时脚本、REPL 这些不经过 pytest 的路径同样受保护。这里拦的是**配置**
错误 —— 库名被配成开发库时,连测试都不该启动。）

万一上面的机制失效(例如将来有人改了 db.py 的加载方式),模块末尾会做一次
断言:确认 db 实际连的库名不是开发库。宁可让测试**响亮地失败**,也不能悄悄
删掉用户数据。
"""
import os

# ---- 1. 必须在导入 storage.db 之前设置 ----
TEST_DATABASE = os.environ.get("CHROMA_TEST_DATABASE", "chroma_test")
DEV_DATABASE = "chroma"

if TEST_DATABASE == DEV_DATABASE:
    raise RuntimeError(
        f"测试库名不能与开发库相同({DEV_DATABASE})—— 测试会清空该库的全部数据"
    )

os.environ["MYSQL_DATABASE"] = TEST_DATABASE


# ---- 2. 确保测试库存在(它可能从未被创建过)----
def _ensure_database() -> None:
    import pymysql

    conn = pymysql.connect(
        host=os.environ.get("MYSQL_HOST", "localhost"),
        port=int(os.environ.get("MYSQL_PORT", "3306")),
        user=os.environ.get("MYSQL_USER", "root"),
        password=os.environ.get("MYSQL_PASSWORD", "123456"),
        charset="utf8mb4",
    )
    try:
        with conn.cursor() as cur:
            cur.execute(
                f"CREATE DATABASE IF NOT EXISTS `{TEST_DATABASE}` "
                "CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
            )
        conn.commit()
    finally:
        conn.close()


_ensure_database()


# ---- 3. 现在才可以安全导入 db ----
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from storage import db as _db  # noqa: E402

_db.init_db()


# ---- 4. 兜底断言:确认真的连到了测试库 ----
if _db._CONFIG["database"] != TEST_DATABASE:
    raise RuntimeError(
        f"数据库隔离失效:db 实际连的是 {_db._CONFIG['database']!r},"
        f"期望 {TEST_DATABASE!r}。拒绝继续 —— 测试会清空该库。"
    )
if _db._CONFIG["database"] == DEV_DATABASE:
    raise RuntimeError("数据库隔离失效:测试正指向开发库,拒绝继续")
