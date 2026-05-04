"""SQLite SessionDB mixin 패키지.

5개 도메인 mixin:
- SqliteSessionCRUDMixin: 세션 CRUD + 읽음 상태 + 셧다운
- SqliteEventMixin: 이벤트 CRUD
- SqliteViewportMixin: 뷰포트 API (NotImplementedError 스텁)
- SqliteFolderMixin: 폴더 CRUD + 카탈로그
- SqliteSearchMixin: 경량 세션 목록 + 전문검색 (FTS5)
"""

from soul_common.db.sqlite.session_crud import SqliteSessionCRUDMixin
from soul_common.db.sqlite.events import SqliteEventMixin
from soul_common.db.sqlite.viewport import SqliteViewportMixin
from soul_common.db.sqlite.folders import SqliteFolderMixin
from soul_common.db.sqlite.search import SqliteSearchMixin

__all__ = [
    "SqliteSessionCRUDMixin",
    "SqliteEventMixin",
    "SqliteViewportMixin",
    "SqliteFolderMixin",
    "SqliteSearchMixin",
]
