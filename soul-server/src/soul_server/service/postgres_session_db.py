"""
SessionDB 팩토리 — soul-common re-export 래퍼

본체는 soul_common.db에 위치한다.
DI 함수(init/get)는 soul-server 내부 전용이므로 여기에 유지한다.
"""

import soul_common.db as _soul_common_db
from pathlib import Path
from typing import Optional, Union

from soul_common.db.session_db import PostgresSessionDB  # noqa: F401
from soul_common.db.sqlite_session_db import SqliteSessionDB  # noqa: F401

# soul-server 전용: PostgreSQL schema.sql 경로
_PG_SCHEMA_PATH = Path(__file__).resolve().parent.parent.parent.parent / "sql" / "schema.sql"

# soul_common.db.__file__ 이 db/__init__.py 이므로 parent가 db/ 디렉토리
# → 올바른 경로: .../soul_common/db/sqlite_schema.sql
_SQLITE_SCHEMA_PATH = Path(_soul_common_db.__file__).parent / "sqlite_schema.sql"

AnySessionDB = Union[PostgresSessionDB, SqliteSessionDB]


def create_soul_server_session_db(database_url: str, node_id: str) -> PostgresSessionDB:
    """soul-server용 PostgresSessionDB를 생성한다.

    schema_path를 soul-server/sql/schema.sql로 자동 설정한다.
    """
    return PostgresSessionDB(
        database_url=database_url,
        node_id=node_id,
        schema_path=_PG_SCHEMA_PATH,
    )


def create_soul_server_sqlite_db(sqlite_path: str, node_id: str) -> SqliteSessionDB:
    """soul-server용 SqliteSessionDB를 생성한다. (로컬 모드)

    schema_path를 soul-common 패키지의 sqlite_schema.sql로 자동 설정한다.
    """
    return SqliteSessionDB(
        db_path=sqlite_path,
        node_id=node_id,
        schema_path=_SQLITE_SCHEMA_PATH,
    )


# === 싱글턴 인스턴스 관리 ===

_session_db: Optional[AnySessionDB] = None


def init_session_db(db: AnySessionDB) -> None:
    """SessionDB 전역 인스턴스 설정"""
    global _session_db
    _session_db = db


def get_session_db() -> AnySessionDB:
    """SessionDB 전역 인스턴스 반환"""
    if _session_db is None:
        raise RuntimeError("SessionDB not initialized.")
    return _session_db
