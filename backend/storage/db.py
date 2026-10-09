"""LUT 元数据存储(MySQL)。连接信息从环境变量或 .env 读取,缺省用本地默认值。"""
import os
import time
from datetime import datetime, timezone
from pathlib import Path

import pymysql
from dotenv import load_dotenv
from pymysql.cursors import DictCursor

load_dotenv(Path(__file__).resolve().parent.parent.parent / ".env")

_CONFIG = {
    "host": os.environ.get("MYSQL_HOST", "localhost"),
    "port": int(os.environ.get("MYSQL_PORT", "3306")),
    "user": os.environ.get("MYSQL_USER", "root"),
    "password": os.environ.get("MYSQL_PASSWORD", "123456"),
    "database": os.environ.get("MYSQL_DATABASE", "chroma"),
    "charset": "utf8mb4",
}


def _connect():
    return pymysql.connect(**_CONFIG, cursorclass=DictCursor)


def init_db():
    with _connect() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS luts (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    user_id INT NOT NULL,
                    name VARCHAR(255) NOT NULL,
                    description TEXT NOT NULL,
                    params_json TEXT NOT NULL,
                    created_at VARCHAR(64) NOT NULL,
                    INDEX idx_user (user_id)
                ) CHARACTER SET utf8mb4
                """
            )
            # 迁移:旧表补 user_id 列与索引(1060=列已存在,1061=索引已存在)
            for ddl in (
                "ALTER TABLE luts ADD COLUMN user_id INT NOT NULL DEFAULT 0",
                "ALTER TABLE luts ADD INDEX idx_user (user_id)",
            ):
                try:
                    cur.execute(ddl)
                except pymysql.err.OperationalError as e:
                    if e.args[0] not in (1060, 1061):
                        raise
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS users (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    username VARCHAR(64) NOT NULL UNIQUE,
                    password_hash VARCHAR(255) NOT NULL,
                    token_version INT NOT NULL DEFAULT 0,
                    created_at VARCHAR(64) NOT NULL
                ) CHARACTER SET utf8mb4
                """
            )
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS sessions (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    user_id INT NOT NULL,
                    title VARCHAR(255) NOT NULL,
                    is_auto TINYINT NOT NULL DEFAULT 0,
                    created_at VARCHAR(64) NOT NULL,
                    INDEX idx_user (user_id)
                ) CHARACTER SET utf8mb4
                """
            )
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS messages (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    user_id INT NOT NULL,
                    session_id INT NOT NULL,
                    role VARCHAR(16) NOT NULL,
                    content TEXT NOT NULL,
                    params_json TEXT,
                    cube_text MEDIUMTEXT,
                    payload_json MEDIUMTEXT,
                    created_at VARCHAR(64) NOT NULL,
                    INDEX idx_user (user_id),
                    INDEX idx_session (session_id)
                ) CHARACTER SET utf8mb4
                """
            )
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS auto_grade_calls (
                    id BIGINT AUTO_INCREMENT PRIMARY KEY,
                    user_id INT NOT NULL,
                    called_at BIGINT NOT NULL,
                    INDEX idx_user_time (user_id, called_at)
                ) CHARACTER SET utf8mb4
                """
            )
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS auth_rate_keys (
                    rate_key VARCHAR(255) PRIMARY KEY
                ) CHARACTER SET utf8mb4
                """
            )
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS auth_rate_events (
                    id BIGINT AUTO_INCREMENT PRIMARY KEY,
                    rate_key VARCHAR(255) NOT NULL,
                    called_at BIGINT NOT NULL,
                    INDEX idx_key_time (rate_key, called_at)
                ) CHARACTER SET utf8mb4
                """
            )
            # users 迁移:旧表补 token_version 列
            try:
                cur.execute("ALTER TABLE users ADD COLUMN token_version INT NOT NULL DEFAULT 0")
            except pymysql.err.OperationalError as e:
                if e.args[0] not in (1060,):
                    raise
            # messages 迁移:旧表补 user_id 列并从 sessions 补齐存量
            try:
                cur.execute("ALTER TABLE messages ADD COLUMN user_id INT NOT NULL DEFAULT 0")
            except pymysql.err.OperationalError as e:
                if e.args[0] not in (1060,):
                    raise
            # messages 迁移:旧表补 cube_text 列(生成结果留档,单条约 0.9MB 故用 MEDIUMTEXT)
            try:
                cur.execute("ALTER TABLE messages ADD COLUMN cube_text MEDIUMTEXT")
            except pymysql.err.OperationalError as e:
                if e.args[0] not in (1060,):
                    raise
            # sessions 迁移:标记「自动修图」会话。
            # 用显式标记而不是按标题查:标题是展示文案,用户改了就失效。
            try:
                cur.execute("ALTER TABLE sessions ADD COLUMN is_auto TINYINT NOT NULL DEFAULT 0")
            except pymysql.err.OperationalError as e:
                if e.args[0] not in (1060,):
                    raise
            # messages 迁移:结构化结果留档(自动修图的完整 AutoGradeOut,供刷新后重建报告)。
            # 不复用 content —— 那是给人看的可读摘要,混入 JSON 会污染会话展示。
            try:
                cur.execute("ALTER TABLE messages ADD COLUMN payload_json MEDIUMTEXT")
            except pymysql.err.OperationalError as e:
                if e.args[0] not in (1060,):
                    raise
            cur.execute(
                "UPDATE messages m JOIN sessions s ON m.session_id = s.id "
                "SET m.user_id = s.user_id WHERE m.user_id = 0"
            )
        conn.commit()


def create_lut(user_id: int, name: str, description: str, params_json: str) -> int:
    created_at = datetime.now(timezone.utc).isoformat()
    with _connect() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO luts (user_id, name, description, params_json, created_at) VALUES (%s, %s, %s, %s, %s)",
                (user_id, name, description, params_json, created_at),
            )
            last_id = cur.lastrowid
        conn.commit()
        return last_id


def list_luts(user_id: int):
    with _connect() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT * FROM luts WHERE user_id = %s ORDER BY created_at DESC", (user_id,))
            return cur.fetchall()


def get_lut(lut_id: int, user_id: int):
    with _connect() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT * FROM luts WHERE id = %s AND user_id = %s", (lut_id, user_id))
            return cur.fetchone()


def update_lut(lut_id: int, user_id: int, name: str, description: str, params_json: str):
    with _connect() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE luts SET name = %s, description = %s, params_json = %s WHERE id = %s AND user_id = %s",
                (name, description, params_json, lut_id, user_id),
            )
        conn.commit()
    return get_lut(lut_id, user_id)


def delete_lut(lut_id: int, user_id: int) -> bool:
    with _connect() as conn:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM luts WHERE id = %s AND user_id = %s", (lut_id, user_id))
            deleted = cur.rowcount
        conn.commit()
        return deleted > 0


# 破坏性操作(仅供测试使用)。这些函数会**无条件清表**,因此必须挡住「不小心
# 作用在开发库上」的情况 —— 只需写个临时脚本调一次,开发者自己的账号、LUT、
# 会话就全没了。
#
# 为什么防护放在这一层而不是只放 conftest:pytest 有 conftest 兜底,但**临时
# 脚本、REPL、一次性验证代码都不经过 pytest** —— 本项目开发中这两种用法都很
# 常见(实测就因为探针脚本把开发库的用户删掉过)。把闸门放在真正执行删除的
# 地方,才不依赖「你恰好是用 pytest 跑的」。
DEV_DATABASE = "chroma"
_ENV_OVERRIDE = "CHROMA_ALLOW_CLEAR_DEV_DB"


def _assert_not_dev_database(what: str) -> None:
    name = _CONFIG["database"]
    if name != DEV_DATABASE:
        return
    if os.environ.get(_ENV_OVERRIDE) == "1":
        return
    raise RuntimeError(
        f"拒绝在开发库 {DEV_DATABASE!r} 上执行 {what} —— 它会清空该表。\n"
        f"  如果这确实是你要的(例如在重置本地环境),显式设置:\n"
        f"      {_ENV_OVERRIDE}=1 <你的命令>\n"
        f"  跑测试不需要这个:测试会自动使用独立的 chroma_test 库(见 conftest.py)。"
    )


def clear_all():
    """清空表(测试用)。在开发库上调用会被拒绝,见 _assert_not_dev_database。"""
    _assert_not_dev_database("clear_all()")
    with _connect() as conn:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM luts")
        conn.commit()


def clear_users():
    """清空用户表(测试用)。在开发库上调用会被拒绝。"""
    _assert_not_dev_database("clear_users()")
    with _connect() as conn:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM auto_grade_calls")
            cur.execute("DELETE FROM auth_rate_events")
            cur.execute("DELETE FROM auth_rate_keys")
            cur.execute("DELETE FROM users")
        conn.commit()


def create_user(username: str, password_hash: str) -> int:
    created_at = datetime.now(timezone.utc).isoformat()
    with _connect() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO users (username, password_hash, created_at) VALUES (%s, %s, %s)",
                (username, password_hash, created_at),
            )
            last_id = cur.lastrowid
        conn.commit()
        return last_id


def set_user_password(user_id: int, password_hash: str) -> None:
    """改密码,并递增 token_version 让该用户已签发的 token 全部失效。

    只改哈希不递增版本的话,改完密码旧 token 仍然有效 —— 那正是「改了密码
    却还是被登出/或被冒用」这类问题的来源。
    """
    with _connect() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE users SET password_hash = %s, token_version = token_version + 1"
                " WHERE id = %s",
                (password_hash, user_id),
            )
        conn.commit()


def get_user_by_username(username: str):
    with _connect() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT * FROM users WHERE username = %s", (username,))
            return cur.fetchone()


def get_user(user_id: int):
    with _connect() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT * FROM users WHERE id = %s", (user_id,))
            return cur.fetchone()


def bump_token_version(user_id: int):
    """使该用户已签发的 token 全部失效(退出登录/改密)。"""
    with _connect() as conn:
        with conn.cursor() as cur:
            cur.execute("UPDATE users SET token_version = token_version + 1 WHERE id = %s", (user_id,))
        conn.commit()


def create_session(user_id: int, title: str, is_auto: bool = False) -> int:
    created_at = datetime.now(timezone.utc).isoformat()
    with _connect() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO sessions (user_id, title, is_auto, created_at) VALUES (%s, %s, %s, %s)",
                (user_id, title, 1 if is_auto else 0, created_at),
            )
            last_id = cur.lastrowid
        conn.commit()
        return last_id


def get_or_create_auto_session(user_id: int, title: str = "自动修图") -> int:
    """取该用户的自动修图会话,不存在则创建。

    自动修图结果全部落进这**一个**会话 —— 否则每次点一下都会新建一个同名会话,
    把用户真正的创作会话挤出列表。按 is_auto 标记查而不是按标题查:
    标题是展示文案,用户改了就失效。
    """
    with _connect() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT id FROM users WHERE id = %s FOR UPDATE", (user_id,))
            cur.execute(
                "SELECT id FROM sessions WHERE user_id = %s AND is_auto = 1 ORDER BY id ASC LIMIT 1",
                (user_id,),
            )
            row = cur.fetchone()
            if row:
                sid = row["id"]
            else:
                cur.execute(
                    "INSERT INTO sessions (user_id, title, is_auto, created_at) VALUES (%s, %s, 1, %s)",
                    (user_id, title, datetime.now(timezone.utc).isoformat()),
                )
                sid = cur.lastrowid
        conn.commit()
        return sid


def find_auto_session(user_id: int):
    """只读查询；打开报告不能凭空创建一个空会话。"""
    with _connect() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT id FROM sessions WHERE user_id = %s AND is_auto = 1 ORDER BY id ASC LIMIT 1",
                (user_id,),
            )
            row = cur.fetchone()
            return row["id"] if row else None


def reserve_auto_grade_call(user_id: int, max_calls: int, window_seconds: int) -> int:
    """跨 worker 原子预留一次配额。返回 0 表示成功，否则返回重试秒数。"""
    now = int(time.time())
    with _connect() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT id FROM users WHERE id = %s FOR UPDATE", (user_id,))
            cur.execute(
                "DELETE FROM auto_grade_calls WHERE user_id = %s AND called_at <= %s",
                (user_id, now - window_seconds),
            )
            cur.execute(
                "SELECT COUNT(*) AS n, MIN(called_at) AS oldest FROM auto_grade_calls WHERE user_id = %s",
                (user_id,),
            )
            row = cur.fetchone()
            if row["n"] >= max_calls:
                retry = max(1, int(row["oldest"] + window_seconds - now))
            else:
                cur.execute(
                    "INSERT INTO auto_grade_calls (user_id, called_at) VALUES (%s, %s)",
                    (user_id, now),
                )
                retry = 0
        conn.commit()
    return retry


def reserve_auth_event(key: str, max_calls: int, window_seconds: int) -> tuple[int | None, int]:
    """原子预留注册或登录尝试。返回 (事件 ID, 0) 或 (None, 重试秒数)。"""
    now = int(time.time())
    key = key[:255]
    with _connect() as conn:
        with conn.cursor() as cur:
            cur.execute("INSERT IGNORE INTO auth_rate_keys (rate_key) VALUES (%s)", (key,))
            cur.execute("SELECT rate_key FROM auth_rate_keys WHERE rate_key = %s FOR UPDATE", (key,))
            cur.execute("DELETE FROM auth_rate_events WHERE rate_key = %s AND called_at <= %s",
                        (key, now - window_seconds))
            cur.execute("SELECT COUNT(*) AS n, MIN(called_at) AS oldest FROM auth_rate_events WHERE rate_key = %s",
                        (key,))
            row = cur.fetchone()
            if row["n"] >= max_calls:
                event_id = None
                retry = max(1, int(row["oldest"] + window_seconds - now))
            else:
                cur.execute("INSERT INTO auth_rate_events (rate_key, called_at) VALUES (%s, %s)",
                            (key, now))
                event_id = cur.lastrowid
                retry = 0
        conn.commit()
    return event_id, retry


def release_auth_event(event_id: int) -> None:
    """登录成功后只撤销本次尝试，不清除其他账号的失败记录。"""
    with _connect() as conn:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM auth_rate_events WHERE id = %s", (event_id,))
        conn.commit()


def get_latest_payload_message(session_id: int, user_id: int):
    """取该会话最近一条带结构化 payload 的消息(用于刷新后重建报告)。"""
    with _connect() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT id, role, content, params_json, payload_json, created_at FROM messages"
                " WHERE session_id = %s AND user_id = %s AND payload_json IS NOT NULL"
                " ORDER BY id DESC LIMIT 1",
                (session_id, user_id),
            )
            return cur.fetchone()


def list_sessions(user_id: int):
    with _connect() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT * FROM sessions WHERE user_id = %s ORDER BY created_at DESC", (user_id,))
            return cur.fetchall()


def get_session(session_id: int, user_id: int):
    with _connect() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT * FROM sessions WHERE id = %s AND user_id = %s", (session_id, user_id))
            return cur.fetchone()


def delete_session(session_id: int, user_id: int) -> bool:
    with _connect() as conn:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM sessions WHERE id = %s AND user_id = %s", (session_id, user_id))
            deleted = cur.rowcount
            if deleted:
                cur.execute("DELETE FROM messages WHERE session_id = %s", (session_id,))
        conn.commit()
        return deleted > 0


def update_session(session_id: int, user_id: int, title: str):
    with _connect() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE sessions SET title = %s WHERE id = %s AND user_id = %s",
                (title, session_id, user_id),
            )
        conn.commit()
    return get_session(session_id, user_id)


def add_message(
    user_id: int,
    session_id: int,
    role: str,
    content: str,
    params_json: str | None,
    cube_text: str | None = None,
    payload_json: str | None = None,
) -> int:
    created_at = datetime.now(timezone.utc).isoformat()
    with _connect() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO messages"
                " (user_id, session_id, role, content, params_json, cube_text, payload_json, created_at)"
                " VALUES (%s, %s, %s, %s, %s, %s, %s, %s)",
                (user_id, session_id, role, content, params_json, cube_text, payload_json, created_at),
            )
            last_id = cur.lastrowid
        conn.commit()
        return last_id


def list_messages(session_id: int, user_id: int):
    """列出会话消息。

    默认不取 cube_text:单条约 0.9MB,历史里每轮生成都有一条,全量拉取会让
    「打开会话」白等几 MB。需要下载 LUT 时用 get_latest_generated_message 单独取。
    """
    with _connect() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT id, user_id, session_id, role, content, params_json, created_at"
                " FROM messages WHERE session_id = %s AND user_id = %s ORDER BY id ASC",
                (session_id, user_id),
            )
            return cur.fetchall()


def get_latest_generated_message(session_id: int, user_id: int):
    """取该会话最近一条生成了 LUT 的消息(含 cube_text)。无则返回 None。

    用 id 而非 created_at 排序:created_at 是字符串时间戳,同秒内不保证有序。
    """
    with _connect() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT id, role, content, params_json, cube_text FROM messages"
                " WHERE session_id = %s AND user_id = %s AND cube_text IS NOT NULL"
                " ORDER BY id DESC LIMIT 1",
                (session_id, user_id),
            )
            return cur.fetchone()


def clear_sessions():
    """清空会话与消息表(测试用)。在开发库上调用会被拒绝。"""
    _assert_not_dev_database("clear_sessions()")
    with _connect() as conn:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM messages")
            cur.execute("DELETE FROM sessions")
        conn.commit()
