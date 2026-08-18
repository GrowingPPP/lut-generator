"""LUT 元数据存储(MySQL)。连接信息从环境变量或 .env 读取,缺省用本地默认值。"""
import os
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
                    created_at VARCHAR(64) NOT NULL,
                    INDEX idx_user (user_id),
                    INDEX idx_session (session_id)
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


def clear_all():
    """清空表(测试用)。"""
    with _connect() as conn:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM luts")
        conn.commit()


def clear_users():
    """清空用户表(测试用)。"""
    with _connect() as conn:
        with conn.cursor() as cur:
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


def create_session(user_id: int, title: str) -> int:
    created_at = datetime.now(timezone.utc).isoformat()
    with _connect() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO sessions (user_id, title, created_at) VALUES (%s, %s, %s)",
                (user_id, title, created_at),
            )
            last_id = cur.lastrowid
        conn.commit()
        return last_id


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


def add_message(user_id: int, session_id: int, role: str, content: str, params_json: str | None) -> int:
    created_at = datetime.now(timezone.utc).isoformat()
    with _connect() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO messages (user_id, session_id, role, content, params_json, created_at) VALUES (%s, %s, %s, %s, %s, %s)",
                (user_id, session_id, role, content, params_json, created_at),
            )
            last_id = cur.lastrowid
        conn.commit()
        return last_id


def list_messages(session_id: int, user_id: int):
    with _connect() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT * FROM messages WHERE session_id = %s AND user_id = %s ORDER BY id ASC",
                (session_id, user_id),
            )
            return cur.fetchall()


def clear_sessions():
    """清空会话与消息表(测试用)。"""
    with _connect() as conn:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM messages")
            cur.execute("DELETE FROM sessions")
        conn.commit()
