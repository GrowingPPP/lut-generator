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
                    name VARCHAR(255) NOT NULL,
                    description TEXT NOT NULL,
                    params_json TEXT NOT NULL,
                    created_at VARCHAR(64) NOT NULL
                ) CHARACTER SET utf8mb4
                """
            )
        conn.commit()


def create_lut(name: str, description: str, params_json: str) -> int:
    created_at = datetime.now(timezone.utc).isoformat()
    with _connect() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO luts (name, description, params_json, created_at) VALUES (%s, %s, %s, %s)",
                (name, description, params_json, created_at),
            )
            last_id = cur.lastrowid
        conn.commit()
        return last_id


def list_luts():
    with _connect() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT * FROM luts ORDER BY created_at DESC")
            return cur.fetchall()


def get_lut(lut_id: int):
    with _connect() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT * FROM luts WHERE id = %s", (lut_id,))
            return cur.fetchone()


def update_lut(lut_id: int, name: str, description: str, params_json: str):
    with _connect() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE luts SET name = %s, description = %s, params_json = %s WHERE id = %s",
                (name, description, params_json, lut_id),
            )
        conn.commit()
    return get_lut(lut_id)


def delete_lut(lut_id: int) -> bool:
    with _connect() as conn:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM luts WHERE id = %s", (lut_id,))
            deleted = cur.rowcount
        conn.commit()
        return deleted > 0


def clear_all():
    """清空表(测试用)。"""
    with _connect() as conn:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM luts")
        conn.commit()
