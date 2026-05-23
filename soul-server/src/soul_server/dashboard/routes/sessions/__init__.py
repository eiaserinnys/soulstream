"""세션 라우트 패키지 — 책임 단위로 분할된 핸들러를 단일 라우터로 모은다.

분할 기준:
- `_models`     — 요청 body Pydantic 모델
- `_status`     — `/api/status` (노드 가동 상태)
- `_query`      — GET 엔드포인트 (목록·SSE·뷰포트·메시지·이벤트 스트림)
- `_lifecycle`  — POST 엔드포인트 (생성·인터벤션·응답)
- `_state`      — PUT/PATCH 엔드포인트 (읽음 위치·표시 이름)

라우터 include 순서 (중요):
- `_query.router`가 `/api/sessions/folder-counts`·`/stream`(고정 경로)을
  `{session_id}/events`(파라미터화 경로)보다 먼저 등록한다.
- 다른 서브 라우터는 메서드 또는 path가 달라 충돌하지 않는다.

테스트가 본 패키지에서 직접 import하던 심볼은 호환성 보존을 위해 본 모듈에서 재노출한다.
다만 `patch("soul_server.dashboard.routes.sessions.<symbol>")` 같은 mock은 *서브 모듈*
(`._query`, `._lifecycle` 등)을 가리키도록 갱신해야 한다 — 핸들러가 실제로 사용하는
바인딩이 서브 모듈 namespace에 있기 때문.
"""

from fastapi import APIRouter

from . import _lifecycle, _query, _state, _status

# 테스트 import 호환성 — `from soul_server.dashboard.routes.sessions import RespondBody`
# 같은 사용 패턴을 보존한다.
from ._lifecycle import api_create_session, api_intervene, api_message, api_respond
from ._models import (
    CreateSessionBody,
    InterveneBody,
    ReadPositionBody,
    RenameSessionRequest,
    RespondBody,
)
from ._query import (
    api_get_sessions,
    api_session_events,
    api_session_events_viewport,
    api_session_folder_counts,
    api_session_messages,
    api_session_timeline,
    api_sessions_stream,
)
from ._state import api_rename_session, api_update_read_position
from ._status import api_status

router = APIRouter()
router.include_router(_status.router)
router.include_router(_query.router)
router.include_router(_lifecycle.router)
router.include_router(_state.router)

__all__ = [
    "router",
    # 모델
    "CreateSessionBody",
    "InterveneBody",
    "RespondBody",
    "ReadPositionBody",
    "RenameSessionRequest",
    # 핸들러 (테스트 import 호환)
    "api_status",
    "api_get_sessions",
    "api_session_folder_counts",
    "api_sessions_stream",
    "api_session_events_viewport",
    "api_session_messages",
    "api_session_timeline",
    "api_session_events",
    "api_create_session",
    "api_intervene",
    "api_message",
    "api_respond",
    "api_update_read_position",
    "api_rename_session",
]
