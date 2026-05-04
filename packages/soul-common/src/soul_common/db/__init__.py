"""soul_common.db: 세션 저장소 (PostgreSQL / SQLite)"""

from soul_common.db.session_db_base import (
    SessionDBBase,
    extract_searchable_text,
    # 도메인 Protocol
    SessionCRUDProtocol,
    EventProtocol,
    FolderProtocol,
    SearchProtocol,
    ViewportProtocol,
)
from soul_common.db.session_db import PostgresSessionDB
from soul_common.db.sqlite_session_db import SqliteSessionDB

__all__ = [
    "SessionDBBase",
    "extract_searchable_text",
    "PostgresSessionDB",
    "SqliteSessionDB",
    # 도메인 Protocol
    "SessionCRUDProtocol",
    "EventProtocol",
    "FolderProtocol",
    "SearchProtocol",
    "ViewportProtocol",
]
