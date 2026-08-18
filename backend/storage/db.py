"""LUT 元数据存储(MySQL)。连接信息从环境变量读取,缺省用本地默认值。"""
import os
from datetime import datetime, timezone

import pymysql
from pymysql.cursors import DictCursor

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
            # 迁移:旧表补 user_id 列(旧数据归 user_id=0,登录用户不可见)
            try:
                cur.execute("ALTER TABLE luts ADD COLUMN user_id INT NOT NULL DEFAULT 0")
            except pymysql.err.OperationalError:
                pass
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS users (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    username VARCHAR(64) NOT NULL UNIQUE,
                    password_hash VARCHAR(255) NOT NULL,
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
                    session_id INT NOT NULL,
                    role VARCHAR(16) NOT NULL,
                    content TEXT NOT NULL,
                    params_json TEXT,
                    created_at VARCHAR(64) NOT NULL,
                    INDEX idx_session (session_id)
                ) CHARACTER SET utf8mb4
                """
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


def add_message(session_id: int, role: str, content: str, params_json: str | None) -> int:
    created_at = datetime.now(timezone.utc).isoformat()
    with _connect() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO messages (session_id, role, content, params_json, created_at) VALUES (%s, %s, %s, %s, %s)",
                (session_id, role, content, params_json, created_at),
            )
            last_id = cur.lastrowid
        conn.commit()
        return last_id


def list_messages(session_id: int):
    with _connect() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT * FROM messages WHERE session_id = %s ORDER BY id ASC", (session_id,))
            return cur.fetchall()


def clear_sessions():
    """清空会话与消息表(测试用)。"""
    with _connect() as conn:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM messages")
            cur.execute("DELETE FROM sessions")
        conn.commit()
