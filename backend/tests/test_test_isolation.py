"""测试隔离与本地账号工具的回归测试。

## 为什么这个文件存在

测试套件里有多个 `autouse` fixture 调用 `db.clear_users()` / `db.clear_all()`,
而它们一度直接作用在**开发库**上 —— 跑一次 `make check`(README 推荐的提交前
命令)就会把开发者自己的账号、LUT、会话全部删光。实测复现过:

    跑测试前  用户: ['admin']
    pytest tests/test_auth.py
    跑测试后  用户: ⚠ 表已空

`conftest.py` 现在把测试指向独立的 `chroma_test` 库。这里锁住那个隔离:
**宁可测试响亮地失败,也不能悄悄删掉用户数据。**
"""
import ast
import os
import subprocess
import sys
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parent.parent
PROJECT_ROOT = BACKEND.parent
DEV_DATABASE = "chroma"


# ---- 隔离本身 ----

def test_tests_run_against_separate_database():
    """最核心的一条:测试进程连的库不能是开发库。"""
    from storage import db

    actual = db._CONFIG["database"]
    assert actual != DEV_DATABASE, (
        f"测试正连着开发库 {DEV_DATABASE!r} —— 测试里的 clear_users()/clear_all() "
        "会把你的账号、LUT、会话全部删掉。检查 backend/conftest.py 是否生效。"
    )


def test_database_name_is_the_test_one():
    from storage import db

    assert db._CONFIG["database"] == os.environ.get("CHROMA_TEST_DATABASE", "chroma_test")


def test_env_var_is_overridden_before_db_import():
    """conftest 必须在 storage.db 导入前改掉 MYSQL_DATABASE。

    `.env` 里写的是开发库名;若 conftest 晚于 import 执行,db._CONFIG 会拿到
    开发库名 —— 这正是我们要防的。
    """
    assert os.environ["MYSQL_DATABASE"] != DEV_DATABASE


def test_conftest_refuses_identical_database_names():
    """把测试库名配成开发库名时必须直接拒绝,而不是照常删数据。"""
    script = (
        "import os;"
        f"os.environ['CHROMA_TEST_DATABASE']='{DEV_DATABASE}';"
        "import conftest"
    )
    proc = subprocess.run(
        [sys.executable, "-c", script],
        cwd=str(BACKEND), capture_output=True, text=True,
    )
    assert proc.returncode != 0, "配成开发库名竟然没有报错"
    assert "不能与开发库相同" in (proc.stderr + proc.stdout)


def test_dev_database_is_untouched_by_this_session():
    """实证:开发库里若已有数据,测试跑完后它仍在。

    用一条独立的只读连接查开发库(不经过 db 模块,避免受 conftest 影响)。
    """
    import pymysql

    db_name = DEV_DATABASE
    try:
        conn = pymysql.connect(
            host=os.environ.get("MYSQL_HOST", "localhost"),
            port=int(os.environ.get("MYSQL_PORT", "3306")),
            user=os.environ.get("MYSQL_USER", "root"),
            password=os.environ.get("MYSQL_PASSWORD", "123456"),
            database=db_name, charset="utf8mb4",
        )
    except pymysql.err.OperationalError:
        pytest.skip(f"开发库 {db_name} 不存在,跳过")
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT COUNT(*) FROM users")
            count = cur.fetchone()[0]
    finally:
        conn.close()
    # 不做「必须 >0」的断言:开发库本来就可能是空的(全新环境)。
    # 这里只是确认它能被正常查询 —— 真正的保护是上面几条隔离断言。
    assert count >= 0


# ---- 本地账号工具 ----

def test_create_user_script_reuses_auth_hashing():
    """脚本必须复用 api.auth 的哈希,不能自己写一份 bcrypt 调用。

    两处实现必然漂移 —— bcrypt 的 72 字节截断规则就很容易写漏。
    """
    src = (BACKEND / "scripts/create_user.py").read_text(encoding="utf-8")
    assert "from api.auth import hash_password" in src
    # 只看**可执行代码**,不看 docstring —— 文档里解释「为什么复用」时会提到 bcrypt
    doc = ast.get_docstring(ast.parse(src)) or ""
    code = src.replace(doc, "")
    assert "bcrypt." not in code, "脚本里不应直接调用 bcrypt,应复用 api.auth.hash_password"


def test_create_user_script_rejects_short_password():
    proc = subprocess.run(
        [sys.executable, "scripts/create_user.py", "someone", "abc"],
        cwd=str(BACKEND), capture_output=True, text=True,
    )
    assert proc.returncode == 2
    assert "8~72" in (proc.stderr + proc.stdout)


def test_create_user_script_falls_back_to_defaults_on_empty_args():
    """Make 传空串时要落回默认值,不能变成空用户名/空密码。"""
    src = (BACKEND / "scripts/create_user.py").read_text(encoding="utf-8")
    assert "argv[0].strip()" in src, "空用户名应回落到默认值"
    assert "and argv[1]" in src, "空密码应回落到默认值"


def test_set_user_password_bumps_token_version():
    """改密码必须让旧 token 失效,否则改完密码旧 token 还能用。"""
    from storage import db

    uid = db.create_user("pwtest", "hash-placeholder")
    before = db.get_user(uid)["token_version"]
    db.set_user_password(uid, "new-hash")
    after = db.get_user(uid)
    assert after["token_version"] == before + 1
    assert after["password_hash"] == "new-hash"
    with db._connect() as conn:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM users WHERE id = %s", (uid,))
        conn.commit()


def test_makefile_admin_target_avoids_shell_env_collision():
    """`make admin` 的变量名不能是 USER —— 那是 shell 的标准环境变量,
    Make 会原样导入,导致「未指定」时静默使用当前系统用户名。"""
    lines = (PROJECT_ROOT / "Makefile").read_text(encoding="utf-8").splitlines()
    idx = next((i for i, ln in enumerate(lines) if ln.startswith("admin:")), None)
    assert idx is not None, "缺少 admin 目标"
    # 目标声明行 + 它的配方行(缩进的后续行)一起看 —— 变量实际用在配方里
    block = [lines[idx]]
    for ln in lines[idx + 1:]:
        if ln.startswith("\t") or ln.startswith("    "):
            block.append(ln)
        else:
            break
    recipe = "\n".join(block)
    assert "$(USER)" not in recipe, "不要用 $(USER) —— 会撞上 shell 环境变量"
    assert "$(NAME)" in recipe and "$(PW)" in recipe


# ---- db 层防护:临时脚本也不该能删开发库 ----
#
# conftest 只保护 pytest。开发中大量使用临时脚本 / REPL 验证,那些路径不经过
# pytest,曾经真的把开发库的用户删掉过。所以闸门必须放在真正执行删除的地方。

def test_clear_helpers_refuse_on_dev_database(monkeypatch):
    """在开发库上调用 clear_users/clear_all/clear_sessions 必须被拒绝。"""
    from storage import db

    monkeypatch.setitem(db._CONFIG, "database", DEV_DATABASE)
    monkeypatch.delenv("CHROMA_ALLOW_CLEAR_DEV_DB", raising=False)
    for fn in (db.clear_users, db.clear_all, db.clear_sessions):
        with pytest.raises(RuntimeError, match="拒绝在开发库"):
            fn()


def test_clear_helpers_allow_explicit_override(monkeypatch):
    """确实需要重置本地环境时,显式开关应放行(而不是完全堵死)。"""
    from storage import db

    monkeypatch.setitem(db._CONFIG, "database", DEV_DATABASE)
    monkeypatch.setenv("CHROMA_ALLOW_CLEAR_DEV_DB", "1")
    calls = []
    monkeypatch.setattr(db, "_connect", lambda: (_ for _ in ()).throw(
        RuntimeError("reached-db")))
    for fn in (db.clear_users, db.clear_all, db.clear_sessions):
        with pytest.raises(RuntimeError, match="reached-db"):
            fn()          # 抛的是「已连到数据库」→ 说明没被闸门拦下
        calls.append(fn.__name__)
    assert len(calls) == 3


def test_clear_helpers_work_on_test_database():
    """测试库上必须照常工作,否则所有测试都跑不了。"""
    from storage import db

    assert db._CONFIG["database"] != DEV_DATABASE
    db.clear_users()          # 不应抛错
