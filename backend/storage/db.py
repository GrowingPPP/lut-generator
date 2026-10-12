"""LUT 元数据存储(MySQL)。连接信息从环境变量或 .env 读取,缺省用本地默认值。"""
import os
import json
from uuid import uuid4
import time
from datetime import datetime, timezone
from pathlib import Path

import pymysql
from dotenv import load_dotenv
from pymysql.cursors import DictCursor
from .library_metadata import CONTENT_COLUMNS, ORGANIZATION_COLUMNS, normalized_text, query_parts, values_equal

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


class WorkspaceMissingError(ValueError):
    """需要有效调色项目的写入不能落到不存在的项目。"""


class WorkspaceDeletedError(WorkspaceMissingError):
    """退休的项目标识不能被旧草稿重新创建。"""


def _require_workspace_row(cur, workspace_id, user_id):
    cur.execute("SELECT * FROM workspaces WHERE id=%s AND user_id=%s FOR UPDATE",
                (workspace_id, user_id))
    row = cur.fetchone()
    if row:
        return row
    cur.execute("SELECT id FROM workspace_tombstones WHERE id=%s AND user_id=%s",
                (workspace_id, user_id))
    if cur.fetchone():
        raise WorkspaceDeletedError("调色项目已删除，请打开其他项目")
    raise WorkspaceMissingError("调色项目不存在")


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
            for ddl in (
                "ALTER TABLE luts ADD COLUMN kind VARCHAR(32) NOT NULL DEFAULT 'full_snapshot'",
                "ALTER TABLE luts ADD COLUMN recipe_json MEDIUMTEXT",
                "ALTER TABLE luts ADD COLUMN input_contract_json TEXT",
                "ALTER TABLE luts ADD COLUMN source_json MEDIUMTEXT",
                "ALTER TABLE luts ADD COLUMN workspace_id CHAR(36)",
                "ALTER TABLE luts ADD COLUMN revision_id BIGINT",
                "ALTER TABLE luts ADD COLUMN tags_json TEXT",
                "ALTER TABLE luts ADD COLUMN group_name VARCHAR(48)",
                "ALTER TABLE luts ADD COLUMN favorite TINYINT NOT NULL DEFAULT 0",
                "ALTER TABLE luts ADD COLUMN cover_id VARCHAR(32) NOT NULL DEFAULT 'engine'",
                "ALTER TABLE luts ADD COLUMN updated_at VARCHAR(64) NOT NULL DEFAULT ''",
            ):
                try:
                    cur.execute(ddl)
                except pymysql.err.OperationalError as exc:
                    if exc.args[0] != 1060:
                        raise
            cur.execute("UPDATE luts SET updated_at=created_at WHERE updated_at=''")
            cur.execute("""CREATE TABLE IF NOT EXISTS imported_luts (
                id CHAR(36) PRIMARY KEY,user_id INT NOT NULL,name VARCHAR(255) NOT NULL,
                title VARCHAR(255) NOT NULL,size INT NOT NULL,digest CHAR(64) NOT NULL,
                input_encoding VARCHAR(16) NOT NULL,output_encoding VARCHAR(16) NOT NULL,
                mode VARCHAR(16) NOT NULL,domain_min_json TEXT NOT NULL,domain_max_json TEXT NOT NULL,
                grid_blob MEDIUMBLOB NOT NULL,byte_size INT NOT NULL,created_at VARCHAR(64) NOT NULL,
                UNIQUE KEY idx_import_digest(user_id,digest,input_encoding,output_encoding),
                INDEX idx_import_owner(user_id)
            ) CHARACTER SET utf8mb4""")
            cur.execute("""CREATE TABLE IF NOT EXISTS workspaces (
                id CHAR(36) PRIMARY KEY, user_id INT NOT NULL, session_id INT,
                name VARCHAR(255) NOT NULL, created_at VARCHAR(64) NOT NULL,
                updated_at VARCHAR(64) NOT NULL, INDEX idx_workspace_user (user_id),
                INDEX idx_workspace_session (session_id)
            ) CHARACTER SET utf8mb4""")
            cur.execute("""CREATE TABLE IF NOT EXISTS workspace_versions (
                id CHAR(36) PRIMARY KEY, user_id INT NOT NULL, workspace_id CHAR(36) NOT NULL,
                name VARCHAR(255) NOT NULL, snapshot_json MEDIUMTEXT NOT NULL,
                created_at VARCHAR(64) NOT NULL, INDEX idx_version_workspace (workspace_id, user_id)
            ) CHARACTER SET utf8mb4""")
            cur.execute("""CREATE TABLE IF NOT EXISTS lut_revisions (
                id BIGINT AUTO_INCREMENT PRIMARY KEY, user_id INT NOT NULL, lut_id INT NOT NULL,
                revision_number INT NOT NULL, snapshot_json MEDIUMTEXT NOT NULL,
                created_at VARCHAR(64) NOT NULL, UNIQUE KEY idx_lut_revision (lut_id, revision_number),
                INDEX idx_revision_user (user_id)
            ) CHARACTER SET utf8mb4""")
            cur.execute("""CREATE TABLE IF NOT EXISTS workspace_reports (
                id BIGINT AUTO_INCREMENT PRIMARY KEY, user_id INT NOT NULL, workspace_id CHAR(36) NOT NULL,
                kind VARCHAR(32) NOT NULL, payload_json MEDIUMTEXT NOT NULL,
                created_at VARCHAR(64) NOT NULL, INDEX idx_report_workspace (workspace_id, user_id, kind)
            ) CHARACTER SET utf8mb4""")
            cur.execute("""CREATE TABLE IF NOT EXISTS workspace_tombstones (
                id CHAR(36) PRIMARY KEY, user_id INT NOT NULL, deleted_at VARCHAR(64) NOT NULL,
                INDEX idx_deleted_workspace_user (user_id)
            ) CHARACTER SET utf8mb4""")
            cur.execute(
                "UPDATE messages m JOIN sessions s ON m.session_id = s.id "
                "SET m.user_id = s.user_id WHERE m.user_id = 0"
            )
        conn.commit()


def _lut_snapshot(record):
    return {"name": record["name"], "description": record["description"],
            "params": json.loads(record["params_json"]),
            "kind": record.get("kind") or "full_snapshot",
            "recipe": json.loads(record["recipe_json"]) if record.get("recipe_json") else None,
            "input_contract": json.loads(record["input_contract_json"]) if record.get("input_contract_json") else None,
            "source": json.loads(record["source_json"]) if record.get("source_json") else None,
            "workspace_id":record.get("workspace_id"),
            "tags":json.loads(record["tags_json"]) if record.get("tags_json") else [],
            "group":record.get("group_name"),"favorite":bool(record.get("favorite",False)),
            "cover_id":record.get("cover_id") or "engine","updated_at":record.get("updated_at") or record["created_at"]}


def _append_lut_revision(cur, record, number):
    cur.execute("INSERT INTO lut_revisions (user_id,lut_id,revision_number,snapshot_json,created_at) "
                "VALUES (%s,%s,%s,%s,%s)",
                (record["user_id"], record["id"], number,
                 json.dumps(_lut_snapshot(record), ensure_ascii=False, allow_nan=False),
                 datetime.now(timezone.utc).isoformat()))
    return cur.lastrowid


def create_lut(user_id: int, name: str, description: str, params_json: str, *,
               kind="full_snapshot", recipe_json=None, input_contract_json=None,
               source_json=None,workspace_id=None,tags_json=None,group_name=None,
               favorite=False,cover_id="engine") -> int:
    created_at = datetime.now(timezone.utc).isoformat()
    with _connect() as conn:
        with conn.cursor() as cur:
            if workspace_id:
                cur.execute("SELECT id FROM users WHERE id=%s FOR UPDATE", (user_id,))
                _require_workspace_row(cur, workspace_id, user_id)
            cur.execute("INSERT INTO luts (user_id,name,description,params_json,created_at,kind,recipe_json,"
                        "input_contract_json,source_json,workspace_id,tags_json,group_name,favorite,cover_id,updated_at) "
                        "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
                        (user_id,name,description,params_json,created_at,kind,recipe_json,
                         input_contract_json,source_json,workspace_id,tags_json or "[]",group_name,
                         favorite,cover_id,created_at))
            last_id = cur.lastrowid
            cur.execute("SELECT * FROM luts WHERE id=%s", (last_id,))
            revision_id = _append_lut_revision(cur, cur.fetchone(), 1)
            cur.execute("UPDATE luts SET revision_id=%s WHERE id=%s", (revision_id,last_id))
        conn.commit()
    return last_id


def list_luts(user_id: int,**query):
    filters,values,order = query_parts(**query)
    with _connect() as conn:
        with conn.cursor() as cur:
            sql = "SELECT * FROM luts WHERE user_id=%s"
            if filters:
                sql += " AND " + " AND ".join(filters)
            cur.execute(sql+" ORDER BY "+order,(user_id,*values))
            return cur.fetchall()


def library_summary(user_id):
    with _connect() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT COUNT(*) AS total FROM luts WHERE user_id=%s",(user_id,))
            total = cur.fetchone()["total"]
            cur.execute("SELECT DISTINCT group_name FROM luts WHERE user_id=%s AND group_name IS NOT NULL ORDER BY group_name",(user_id,))
            return {"total":total,"groups":[row["group_name"] for row in cur.fetchall()]}


def get_lut(lut_id: int, user_id: int):
    with _connect() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT * FROM luts WHERE id = %s AND user_id = %s", (lut_id, user_id))
            return cur.fetchone()


class RevisionConflictError(ValueError):
    def __init__(self,current_revision_id):
        super().__init__("资产已被更新,请重新读取当前修订")
        self.current_revision_id = current_revision_id


def update_lut(lut_id: int,user_id: int,name=None,description=None,params_json=None,*,
               build_content=None,expected_revision_id=None,**metadata):
    """行锁内合并缺省字段并生成不可变修订,返回本事务的快照。"""
    with _connect() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT id FROM users WHERE id=%s FOR UPDATE", (user_id,))
            cur.execute("SELECT * FROM luts WHERE id=%s AND user_id=%s FOR UPDATE",(lut_id,user_id))
            record = cur.fetchone()
            if not record:
                return None
            if expected_revision_id is not None and record["revision_id"] != expected_revision_id:
                raise RevisionConflictError(record["revision_id"])
            if build_content is not None:
                params_json,metadata = build_content(dict(record))
            if metadata.get("workspace_id"):
                _require_workspace_row(cur, metadata["workspace_id"], user_id)
            changes = {key:value for key,value in {"name":name,"description":description,
                       "params_json":params_json}.items() if value is not None}
            changes.update({key:value for key,value in metadata.items()
                            if key in CONTENT_COLUMNS | ORGANIZATION_COLUMNS})
            changes = {key:value for key,value in changes.items() if not values_equal(key,record.get(key),value)}
            if not changes:
                return record
            new_revision = bool(set(changes) & CONTENT_COLUMNS)
            number = 0
            if new_revision:
                cur.execute("SELECT MAX(revision_number) AS n FROM lut_revisions WHERE lut_id=%s",(lut_id,))
                number = cur.fetchone()["n"] or 0
                if not number:
                    _append_lut_revision(cur,record,1)
                    number = 1
            record.update(changes)
            record["updated_at"] = datetime.now(timezone.utc).isoformat()
            cur.execute("UPDATE luts SET name=%s,description=%s,params_json=%s,kind=%s,recipe_json=%s,"
                        "input_contract_json=%s,source_json=%s,workspace_id=%s,tags_json=%s,group_name=%s,"
                        "favorite=%s,cover_id=%s,updated_at=%s WHERE id=%s AND user_id=%s",
                        (record["name"],record["description"],record["params_json"],record["kind"],record["recipe_json"],
                         record["input_contract_json"],record["source_json"],record["workspace_id"],record["tags_json"],
                         record["group_name"],record["favorite"],record["cover_id"],record["updated_at"],lut_id,user_id))
            if new_revision:
                revision_id = _append_lut_revision(cur,record,number+1)
                cur.execute("UPDATE luts SET revision_id=%s WHERE id=%s",(revision_id,lut_id))
                record["revision_id"] = revision_id
        conn.commit()
    return record


def list_lut_revisions(lut_id, user_id):
    with _connect() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT * FROM lut_revisions WHERE lut_id=%s AND user_id=%s ORDER BY revision_number DESC",
                        (lut_id,user_id))
            return cur.fetchall()


def get_lut_revision(lut_id, revision_id, user_id):
    with _connect() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT * FROM lut_revisions WHERE lut_id=%s AND id=%s AND user_id=%s",
                        (lut_id,revision_id,user_id))
            return cur.fetchone()


def delete_lut(lut_id: int, user_id: int) -> bool:
    with _connect() as conn:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM luts WHERE id = %s AND user_id = %s", (lut_id, user_id))
            deleted = cur.rowcount
            if deleted:
                cur.execute("DELETE FROM lut_revisions WHERE lut_id=%s AND user_id=%s", (lut_id,user_id))
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
            cur.execute("DELETE FROM lut_revisions")
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
            cur.execute("DELETE FROM workspace_reports")
            cur.execute("DELETE FROM imported_luts")
            cur.execute("DELETE FROM workspace_versions")
            cur.execute("DELETE FROM workspaces")
            cur.execute("DELETE FROM workspace_tombstones")
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


def delete_session(session_id: int, user_id: int, *, delete_workspace_versions=False) -> bool:
    with _connect() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT id FROM users WHERE id=%s FOR UPDATE", (user_id,))
            cur.execute("DELETE FROM sessions WHERE id = %s AND user_id = %s", (session_id, user_id))
            deleted = cur.rowcount
            if deleted:
                cur.execute("DELETE FROM messages WHERE session_id = %s", (session_id,))
                if delete_workspace_versions:
                    cur.execute("DELETE v FROM workspace_versions v JOIN workspaces w ON v.workspace_id=w.id "
                                "WHERE w.session_id=%s AND w.user_id=%s", (session_id,user_id))
                cur.execute("UPDATE workspaces SET session_id=NULL WHERE session_id=%s AND user_id=%s",
                            (session_id,user_id))
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


def persist_workspace_chat(user_id, workspace_id, session_id, user_content, agent_content,
                           params_json, cube_text, payload_json, *, kind="chat"):
    """项目消息及报告在有效项目的行锁内共同提交。"""
    now = datetime.now(timezone.utc).isoformat()
    with _connect() as conn:
        try:
            with conn.cursor() as cur:
                cur.execute("SELECT id FROM users WHERE id=%s FOR UPDATE", (user_id,))
                row = _require_workspace_row(cur, workspace_id, user_id)
                if row["session_id"] != session_id:
                    raise WorkspaceMissingError("调色项目对话已改变，请重新打开项目")
                cur.execute("SELECT id FROM sessions WHERE id=%s AND user_id=%s FOR UPDATE",
                            (session_id, user_id))
                if not cur.fetchone():
                    raise WorkspaceMissingError("调色项目对话不存在")
                for role, content, params, cube, payload in (
                    ("user", user_content, None, None, None),
                    ("agent", agent_content, params_json, cube_text, payload_json),
                ):
                    if content is None:
                        continue
                    cur.execute("INSERT INTO messages (user_id,session_id,role,content,params_json,cube_text,payload_json,created_at) "
                                "VALUES (%s,%s,%s,%s,%s,%s,%s,%s)",
                                (user_id, session_id, role, content, params, cube, payload, now))
                cur.execute("INSERT INTO workspace_reports (user_id,workspace_id,kind,payload_json,created_at) "
                            "VALUES (%s,%s,%s,%s,%s)", (user_id, workspace_id, kind, payload_json, now))
                _trim_workspace_reports(cur, workspace_id, user_id, kind)
            conn.commit()
        except BaseException:
            conn.rollback()
            raise


def persist_auto_grade(user_id, workspace_id, content, params_json, payload):
    """报告、消息及新会话关联共同提交；失败不留下可恢复的候选。"""
    now = datetime.now(timezone.utc).isoformat()
    with _connect() as conn:
        try:
            with conn.cursor() as cur:
                cur.execute("SELECT id FROM users WHERE id=%s FOR UPDATE", (user_id,))
                if not cur.fetchone():
                    raise ValueError("user_not_found")
                if workspace_id:
                    workspace = _require_workspace_row(cur, workspace_id, user_id)
                    sid = workspace["session_id"]
                    if sid:
                        cur.execute("SELECT id FROM sessions WHERE id=%s AND user_id=%s FOR UPDATE",
                                    (sid, user_id))
                        if not cur.fetchone():
                            sid = None
                    if not sid:
                        cur.execute("INSERT INTO sessions (user_id,title,is_auto,created_at) VALUES (%s,%s,0,%s)",
                                    (user_id, workspace["name"], now))
                        sid = cur.lastrowid
                        cur.execute("UPDATE workspaces SET session_id=%s WHERE id=%s AND user_id=%s",
                                    (sid, workspace_id, user_id))
                else:
                    cur.execute("SELECT id FROM sessions WHERE user_id=%s AND is_auto=1 ORDER BY id ASC LIMIT 1 FOR UPDATE",
                                (user_id,))
                    session = cur.fetchone()
                    if session:
                        sid = session["id"]
                    else:
                        cur.execute("INSERT INTO sessions (user_id,title,is_auto,created_at) VALUES (%s,%s,1,%s)",
                                    (user_id, "自动修图", now))
                        sid = cur.lastrowid
                payload_json = json.dumps({**payload, "session_id": sid}, ensure_ascii=False, allow_nan=False)
                cur.execute("INSERT INTO messages (user_id,session_id,role,content,params_json,cube_text,payload_json,created_at) "
                            "VALUES (%s,%s,%s,%s,%s,%s,%s,%s)",
                            (user_id, sid, "agent", content, params_json, None, payload_json, now))
                if workspace_id:
                    cur.execute("INSERT INTO workspace_reports (user_id,workspace_id,kind,payload_json,created_at) "
                                "VALUES (%s,%s,%s,%s,%s)", (user_id, workspace_id, "auto", payload_json, now))
                    _trim_workspace_reports(cur, workspace_id, user_id, "auto")
            conn.commit()
            return sid
        except BaseException:
            conn.rollback()
            raise


def find_auto_job_report(user_id, job_id, workspace_id=None):
    """按账号与作业身份恢复已共同提交的正式报告。"""
    with _connect() as conn:
        with conn.cursor() as cur:
            where = "user_id=%s AND kind='auto' AND JSON_UNQUOTE(JSON_EXTRACT(payload_json,'$.job_id'))=%s"
            values = [user_id, job_id]
            if workspace_id is not None:
                where += " AND workspace_id=%s"
                values.append(workspace_id)
            cur.execute("SELECT payload_json FROM workspace_reports WHERE " + where + " ORDER BY id DESC LIMIT 1", values)
            record = cur.fetchone()
            if record is None:
                cur.execute("SELECT payload_json FROM messages WHERE user_id=%s AND role='agent' "
                            "AND JSON_UNQUOTE(JSON_EXTRACT(payload_json,'$.job_id'))=%s ORDER BY id DESC LIMIT 1",
                            (user_id, job_id))
                record = cur.fetchone()
            if not record:
                return None
            payload = json.loads(record['payload_json'])
            if payload.get('undone'):
                return None
            if workspace_id is not None and payload.get('workspace_id') != workspace_id:
                return None
            if payload.get("workspace_id"):
                cur.execute("SELECT id FROM workspaces WHERE id=%s AND user_id=%s",
                            (payload["workspace_id"], user_id))
                if not cur.fetchone():
                    return None
            return payload


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
            cur.execute("UPDATE workspaces SET session_id=NULL")
            cur.execute("DELETE FROM sessions")
        conn.commit()


def create_workspace(user_id, workspace_id=None, session_id=None, name="调色项目"):
    workspace_id = workspace_id or str(uuid4())
    name = normalized_text(name, 160)
    now = datetime.now(timezone.utc).isoformat()
    with _connect() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT id FROM users WHERE id=%s FOR UPDATE", (user_id,))
            cur.execute("SELECT user_id FROM workspace_tombstones WHERE id=%s", (workspace_id,))
            retired = cur.fetchone()
            if retired:
                if retired["user_id"] == user_id:
                    raise WorkspaceDeletedError("调色项目已删除，请创建新的项目")
                raise pymysql.err.IntegrityError(1062, "调色项目标识已使用")
            cur.execute("SELECT * FROM workspaces WHERE id=%s AND user_id=%s FOR UPDATE", (workspace_id, user_id))
            existing = cur.fetchone()
            if existing:
                return existing
            if session_id is not None:
                cur.execute("SELECT id FROM sessions WHERE id=%s AND user_id=%s FOR UPDATE", (session_id, user_id))
                if not cur.fetchone():
                    raise WorkspaceMissingError("调色项目对话不存在")
            cur.execute("INSERT INTO workspaces (id,user_id,session_id,name,created_at,updated_at) "
                        "VALUES (%s,%s,%s,%s,%s,%s)", (workspace_id,user_id,session_id,name,now,now))
            cur.execute("SELECT * FROM workspaces WHERE id=%s AND user_id=%s", (workspace_id, user_id))
            record = cur.fetchone()
        conn.commit()
    return record


def get_workspace(workspace_id, user_id):
    with _connect() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT * FROM workspaces WHERE id=%s AND user_id=%s", (workspace_id,user_id))
            return cur.fetchone()


def is_workspace_deleted(workspace_id, user_id):
    with _connect() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT id FROM workspace_tombstones WHERE id=%s AND user_id=%s", (workspace_id, user_id))
            return cur.fetchone() is not None


def list_workspaces(user_id):
    with _connect() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT * FROM workspaces WHERE user_id=%s ORDER BY updated_at DESC", (user_id,))
            return cur.fetchall()


def update_workspace(workspace_id,user_id,**fields):
    allowed = {key:value for key,value in fields.items() if key in {"name","session_id"}}
    if "name" in allowed:
        allowed["name"] = normalized_text(allowed["name"], 160)
    allowed["updated_at"] = datetime.now(timezone.utc).isoformat()
    with _connect() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT id FROM users WHERE id=%s FOR UPDATE", (user_id,))
            _require_workspace_row(cur, workspace_id, user_id)
            if allowed.get("session_id") is not None:
                cur.execute("SELECT id FROM sessions WHERE id=%s AND user_id=%s FOR UPDATE", (allowed["session_id"], user_id))
                if not cur.fetchone():
                    raise WorkspaceMissingError("调色项目对话不存在")
            cur.execute("UPDATE workspaces SET " + ",".join(key+"=%s" for key in allowed) +
                        " WHERE id=%s AND user_id=%s", (*allowed.values(),workspace_id,user_id))
            cur.execute("SELECT * FROM workspaces WHERE id=%s AND user_id=%s", (workspace_id, user_id))
            record = cur.fetchone()
        conn.commit()
    return record


def workspace_session(workspace_id,user_id):
    """在项目行锁内创建独立会话,避免并发请求分裂链接。"""
    with _connect() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT id FROM users WHERE id=%s FOR UPDATE", (user_id,))
            row = _require_workspace_row(cur, workspace_id, user_id)
            sid = row["session_id"]
            if sid:
                cur.execute("SELECT id FROM sessions WHERE id=%s AND user_id=%s", (sid,user_id))
                if not cur.fetchone():
                    sid = None
            if not sid:
                cur.execute("INSERT INTO sessions (user_id,title,is_auto,created_at) VALUES (%s,%s,0,%s)",
                            (user_id,row["name"],datetime.now(timezone.utc).isoformat()))
                sid = cur.lastrowid
                cur.execute("UPDATE workspaces SET session_id=%s WHERE id=%s", (sid,workspace_id))
        conn.commit()
    return sid


def delete_workspace(workspace_id,user_id):
    with _connect() as conn:
        try:
            with conn.cursor() as cur:
                cur.execute("SELECT id FROM users WHERE id=%s FOR UPDATE", (user_id,))
                cur.execute("SELECT * FROM workspaces WHERE id=%s AND user_id=%s FOR UPDATE", (workspace_id, user_id))
                workspace = cur.fetchone()
                if not workspace:
                    cur.execute("SELECT id FROM workspace_tombstones WHERE id=%s AND user_id=%s", (workspace_id, user_id))
                    return cur.fetchone() is not None
                cur.execute("INSERT INTO workspace_tombstones (id,user_id,deleted_at) VALUES (%s,%s,%s)",
                            (workspace_id, user_id, datetime.now(timezone.utc).isoformat()))
                cur.execute("DELETE FROM workspace_versions WHERE workspace_id=%s AND user_id=%s", (workspace_id,user_id))
                cur.execute("DELETE FROM workspace_reports WHERE workspace_id=%s AND user_id=%s", (workspace_id,user_id))
                cur.execute("UPDATE luts SET workspace_id=NULL WHERE workspace_id=%s AND user_id=%s", (workspace_id,user_id))
                cur.execute("DELETE FROM workspaces WHERE id=%s AND user_id=%s", (workspace_id, user_id))
                sid = workspace["session_id"]
                if sid is not None:
                    cur.execute("SELECT id FROM workspaces WHERE session_id=%s LIMIT 1", (sid,))
                    if not cur.fetchone():
                        cur.execute("DELETE FROM sessions WHERE id=%s AND user_id=%s AND is_auto=0", (sid, user_id))
                        if cur.rowcount:
                            cur.execute("DELETE FROM messages WHERE session_id=%s AND user_id=%s", (sid, user_id))
            conn.commit()
            return True
        except BaseException:
            conn.rollback()
            raise


def create_workspace_version(workspace_id,user_id,name,snapshot_json):
    version_id = str(uuid4())
    with _connect() as conn:
        with conn.cursor() as cur:
            _require_workspace_row(cur, workspace_id, user_id)
            cur.execute("SELECT COUNT(*) AS n FROM workspace_versions WHERE workspace_id=%s AND user_id=%s", (workspace_id,user_id))
            if cur.fetchone()["n"] >= 20:
                raise ValueError("version_limit")
            cur.execute("INSERT INTO workspace_versions (id,user_id,workspace_id,name,snapshot_json,created_at) "
                        "VALUES (%s,%s,%s,%s,%s,%s)",
                        (version_id,user_id,workspace_id,name,snapshot_json,datetime.now(timezone.utc).isoformat()))
            cur.execute("SELECT * FROM workspace_versions WHERE id=%s AND workspace_id=%s AND user_id=%s",
                        (version_id, workspace_id, user_id))
            record = cur.fetchone()
        conn.commit()
    return record


def list_workspace_versions(workspace_id,user_id):
    with _connect() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT * FROM workspace_versions WHERE workspace_id=%s AND user_id=%s ORDER BY created_at DESC",
                        (workspace_id,user_id))
            return cur.fetchall()


def get_workspace_version(workspace_id,version_id,user_id):
    with _connect() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT * FROM workspace_versions WHERE id=%s AND workspace_id=%s AND user_id=%s",
                        (version_id,workspace_id,user_id))
            return cur.fetchone()


def rename_workspace_version(workspace_id,version_id,user_id,name):
    with _connect() as conn:
        with conn.cursor() as cur:
            _require_workspace_row(cur, workspace_id, user_id)
            cur.execute("UPDATE workspace_versions SET name=%s WHERE id=%s AND workspace_id=%s AND user_id=%s",
                        (name,version_id,workspace_id,user_id))
            cur.execute("SELECT * FROM workspace_versions WHERE id=%s AND workspace_id=%s AND user_id=%s",
                        (version_id, workspace_id, user_id))
            record = cur.fetchone()
        conn.commit()
    return record


def delete_workspace_version(workspace_id,version_id,user_id):
    with _connect() as conn:
        with conn.cursor() as cur:
            _require_workspace_row(cur, workspace_id, user_id)
            cur.execute("DELETE FROM workspace_versions WHERE id=%s AND workspace_id=%s AND user_id=%s",
                        (version_id,workspace_id,user_id))
            deleted = cur.rowcount
        conn.commit()
    return bool(deleted)


def add_workspace_report(workspace_id,user_id,kind,payload_json):
    with _connect() as conn:
        with conn.cursor() as cur:
            _require_workspace_row(cur, workspace_id, user_id)
            cur.execute("INSERT INTO workspace_reports (user_id,workspace_id,kind,payload_json,created_at) VALUES (%s,%s,%s,%s,%s)",
                        (user_id,workspace_id,kind,payload_json,datetime.now(timezone.utc).isoformat()))
            report_id = cur.lastrowid
            _trim_workspace_reports(cur, workspace_id, user_id, kind)
        conn.commit()
    return report_id


def _trim_workspace_reports(cur, workspace_id, user_id, kind):
    cur.execute("SELECT id FROM workspace_reports WHERE user_id=%s AND workspace_id=%s AND kind=%s "
                "ORDER BY id DESC LIMIT 50,1000", (user_id, workspace_id, kind))
    old = [row["id"] for row in cur.fetchall()]
    if old:
        cur.execute("DELETE FROM workspace_reports WHERE id IN (" + ",".join(["%s"] * len(old)) + ")", old)


def latest_workspace_report(workspace_id,user_id,kind="auto"):
    with _connect() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT * FROM workspace_reports WHERE user_id=%s AND workspace_id=%s AND kind=%s "
                        "ORDER BY id DESC LIMIT 1", (user_id,workspace_id,kind))
            return cur.fetchone()


class ImportCapacityError(ValueError):
    pass


def create_imported_lut(user_id, name, title, size, digest, input_encoding, output_encoding,
                        mode, domain_min, domain_max, grid_blob):
    """不可变账号引用；同一内容及信号声明去重,容量校验与创建共享账号行锁。"""
    with _connect() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT id FROM users WHERE id=%s FOR UPDATE",(user_id,))
            if not cur.fetchone():
                raise ValueError("账号不存在")
            cur.execute("SELECT * FROM imported_luts WHERE user_id=%s AND digest=%s AND input_encoding=%s AND output_encoding=%s",
                        (user_id,digest,input_encoding,output_encoding))
            existing = cur.fetchone()
            if existing:
                return existing
            cur.execute("SELECT COUNT(*) AS n,COALESCE(SUM(byte_size),0) AS bytes FROM imported_luts WHERE user_id=%s",(user_id,))
            usage = cur.fetchone()
            if usage["n"] >= 50 or usage["bytes"]+len(grid_blob) > 100*1024*1024:
                raise ImportCapacityError("每账号最多50个导入LUT,解析数据总量最多100MB")
            identifier = str(uuid4())
            cur.execute("INSERT INTO imported_luts (id,user_id,name,title,size,digest,input_encoding,output_encoding,mode,domain_min_json,domain_max_json,grid_blob,byte_size,created_at) "
                        "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
                        (identifier,user_id,name,title,size,digest,input_encoding,output_encoding,mode,
                         json.dumps(domain_min),json.dumps(domain_max),grid_blob,len(grid_blob),datetime.now(timezone.utc).isoformat()))
            cur.execute("SELECT * FROM imported_luts WHERE id=%s",(identifier,))
            created = cur.fetchone()
        conn.commit()
    return created


def get_imported_lut(identifier,user_id):
    with _connect() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT * FROM imported_luts WHERE id=%s AND user_id=%s",(identifier,user_id))
            return cur.fetchone()


def list_imported_luts(user_id):
    with _connect() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT id,name,title,size,digest,input_encoding,output_encoding,mode,domain_min_json,domain_max_json,byte_size,created_at "
                        "FROM imported_luts WHERE user_id=%s ORDER BY created_at DESC,id DESC",(user_id,))
            return cur.fetchall()
