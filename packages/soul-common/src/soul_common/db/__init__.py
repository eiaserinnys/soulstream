"""soul_common.db: PostgreSQL 세션 저장소."""

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

__all__ = [
    "SessionDBBase",
    "extract_searchable_text",
    "PostgresSessionDB",
    # 도메인 Protocol
    "SessionCRUDProtocol",
    "EventProtocol",
    "FolderProtocol",
    "SearchProtocol",
    "ViewportProtocol",
]
