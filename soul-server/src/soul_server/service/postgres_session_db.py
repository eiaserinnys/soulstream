"""
PostgresSessionDB — soul-common re-export 래퍼

본체는 soul_common.db.session_db에 위치한다.
DI 함수(init/get)는 soul-server 내부 전용이므로 여기에 유지한다.
"""

from pathlib import Path
from typing import Optional

from soul_common.db.session_db import PostgresSessionDB  # noqa: F401

# soul-server 전용: schema.sql 경로를 하드코딩하여 호환성 유지
_SCHEMA_PATH = Path(__file__).resolve().parent.parent.parent.parent / "sql" / "schema.sql"


def create_soul_server_session_db(database_url: str, node_id: str) -> PostgresSessionDB:
    """soul-server용 PostgresSessionDB를 생성한다.

    schema_path를 soul-server/sql/schema.sql로 자동 설정한다.
    """
    return PostgresSessionDB(
        database_url=database_url,
        node_id=node_id,
        schema_path=_SCHEMA_PATH,
    )


# === 싱글턴 인스턴스 관리 ===

_session_db: Optional[PostgresSessionDB] = None


def init_session_db(db: PostgresSessionDB) -> None:
    """PostgresSessionDB 전역 인스턴스 설정"""
    global _session_db
    _session_db = db


def get_session_db() -> PostgresSessionDB:
    """PostgresSessionDB 전역 인스턴스 반환"""
    if _session_db is None:
        raise RuntimeError("PostgresSessionDB not initialized.")
    return _session_db
