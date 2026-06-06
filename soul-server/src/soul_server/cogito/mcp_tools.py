"""Cogito MCP tool orchestrator.

FastMCP 서버 인스턴스를 소유하고, 도메인별 하위 모듈을 import하여 도구를 등록한다.
도구 구현은 각 하위 모듈에 있다:

- mcp_cogito       : 서비스 리플렉션 (reflect_service, reflect_brief, reflect_refresh)
- mcp_session_query: 세션 읽기 (list_sessions, list_session_events, …)
- mcp_session_mgmt : 세션 쓰기 (create_agent_session, send_message_to_session, …)
- mcp_catalog      : 카탈로그 관리 (list_folders, create_folder, …)
- mcp_multi_node   : 멀티노드 (list_nodes, create_remote_agent_session, …)
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from fastapi import APIRouter, Query
from fastmcp import FastMCP

if TYPE_CHECKING:
    from soul_server.cogito.brief_composer import BriefComposer

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# FastMCP server instance — 하위 모듈이 import하여 @cogito_mcp.tool()로 등록
# ---------------------------------------------------------------------------

cogito_mcp = FastMCP("soulstream")

# ---------------------------------------------------------------------------
# 하위 모듈 import → @cogito_mcp.tool() 데코레이터가 실행되어 도구 등록
# ---------------------------------------------------------------------------

from soul_server.cogito import mcp_cogito         # noqa: E402, F401
from soul_server.cogito import mcp_session_query   # noqa: E402, F401
from soul_server.cogito import mcp_session_mgmt    # noqa: E402, F401
from soul_server.cogito import mcp_catalog         # noqa: E402, F401
from soul_server.cogito import mcp_multi_node      # noqa: E402, F401

# ---------------------------------------------------------------------------
# 하위 모듈 도구 함수 · 헬퍼 재노출 (기존 import/patch 경로 호환)
# ---------------------------------------------------------------------------

# mcp_cogito
from soul_server.cogito.mcp_cogito import (  # noqa: E402
    reflect_service, reflect_brief, reflect_refresh,
    _load_manifest, _find_service, _http_get,
)

# mcp_session_query
from soul_server.cogito.mcp_session_query import (  # noqa: E402
    list_sessions, list_session_events, get_session_event,
    download_session_history, search_session_history, get_session_summary,
    _omit_tool_content, _truncate_tool_event,
)

# mcp_session_mgmt
from soul_server.cogito.mcp_session_mgmt import (  # noqa: E402
    list_local_agents, create_agent_session, send_message_to_session,
    get_session_name, set_session_name,
)

# mcp_catalog
from soul_server.cogito.mcp_catalog import (  # noqa: E402
    list_folders, list_child_folders, create_folder, move_folder, rename_folder, delete_folder,
    move_sessions_to_folder, get_folder_system_prompt, set_folder_system_prompt,
    delete_session,
)

# ---------------------------------------------------------------------------
# Runtime state — 하위 모듈의 상태를 여기서도 노출 (테스트 호환)
#
# 테스트 fixture가 mcp_tools._xxx = None 으로 리셋할 때
# 하위 모듈의 상태도 동기화해야 한다.
# init() / init_multi_node_tools()는 하위 모듈과 이 변수를 모두 설정한다.
# ---------------------------------------------------------------------------

_brief_composer: BriefComposer | None = None
_manifest_path: str | None = None
_orch_base: str | None = None


def init(brief_composer: BriefComposer, manifest_path: str) -> None:
    """Inject runtime dependencies from the app lifespan."""
    global _brief_composer, _manifest_path
    _brief_composer = brief_composer
    _manifest_path = manifest_path
    mcp_cogito.init(brief_composer, manifest_path)


def init_multi_node_tools(settings) -> None:
    """multi-node 전용 툴을 cogito MCP에 등록한다."""
    global _orch_base
    mcp_multi_node.init(settings)
    _orch_base = mcp_multi_node.get_orch_base()


# ---------------------------------------------------------------------------
# REST API router — MCP 외부 엔드포인트
# ---------------------------------------------------------------------------

cogito_api_router = APIRouter(prefix="/cogito", tags=["cogito"])


@cogito_api_router.get("/search")
async def api_search_sessions(
    q: str,
    top_k: int = Query(default=10, ge=1, le=100),
    session_ids: str | None = None,  # 콤마 구분 문자열
    event_types: str | None = None,  # 콤마 구분 문자열
    search_session_id: bool = False,
) -> dict:
    """세션 기록 BM25 검색 REST 엔드포인트."""
    from soul_server.service.postgres_session_db import get_session_db
    try:
        db = get_session_db()
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e))
    from soul_server.cogito.search import SessionSearchEngine
    ids = [s.strip() for s in session_ids.split(",") if s.strip()] if session_ids else None
    types = [s.strip() for s in event_types.split(",") if s.strip()] if event_types else None
    try:
        engine = SessionSearchEngine(db)
        results = await engine.search(
            query=q, session_ids=ids, top_k=top_k,
            event_types=types, search_session_id=search_session_id,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {
        "results": [r.to_dict() for r in results]
    }
