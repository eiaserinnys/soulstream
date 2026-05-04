"""PostgreSQL SessionDB mixin 패키지.

5개 도메인 mixin:
- PostgresSessionCRUDMixin: 세션 CRUD + 읽음 상태 + 셧다운
- PostgresEventMixin: 이벤트 CRUD
- PostgresViewportMixin: 뷰포트 API
- PostgresFolderMixin: 폴더 CRUD + 카탈로그
- PostgresSearchMixin: 경량 세션 목록 + 전문검색
"""

from soul_common.db.postgres.session_crud import PostgresSessionCRUDMixin
from soul_common.db.postgres.events import PostgresEventMixin, _event_to_dict
from soul_common.db.postgres.viewport import PostgresViewportMixin
from soul_common.db.postgres.folders import PostgresFolderMixin
from soul_common.db.postgres.search import PostgresSearchMixin

__all__ = [
    "PostgresSessionCRUDMixin",
    "PostgresEventMixin",
    "PostgresViewportMixin",
    "PostgresFolderMixin",
    "PostgresSearchMixin",
    "_event_to_dict",
]
