"""Cogito MCP tools for soulstream.

Exposes cogito reflection data as MCP tools, allowing Claude Code sessions
to query service metadata at various levels of detail.

Dependencies are injected via :func:`init` at server startup; tools return
error dicts gracefully when cogito is not configured.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import TYPE_CHECKING, Any

import httpx
from fastapi import APIRouter, HTTPException, Query
from fastmcp import FastMCP

from cogito.manifest import load_manifest
from soul_server.cogito.reflector_setup import reflect
from soul_server.service.task_manager import get_task_manager
from soul_server.service.session_db import get_session_db
from soul_server.service.session_broadcaster import get_session_broadcaster

if TYPE_CHECKING:
    from soul_server.cogito.brief_composer import BriefComposer

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# FastMCP server instance (tools registered below)
# ---------------------------------------------------------------------------

cogito_mcp = FastMCP("soulstream-cogito")

# ---------------------------------------------------------------------------
# Runtime state — set by init() from main.py lifespan
# ---------------------------------------------------------------------------

_brief_composer: BriefComposer | None = None
_manifest_path: str | None = None


def init(brief_composer: BriefComposer, manifest_path: str) -> None:
    """Inject runtime dependencies from the app lifespan.

    Args:
        brief_composer: :class:`BriefComposer` instance.
        manifest_path: Absolute path to ``cogito-manifest.yaml``.
    """
    global _brief_composer, _manifest_path
    if _brief_composer is not None:
        logger.warning("cogito mcp_tools.init() called more than once; overwriting previous state")
    _brief_composer = brief_composer
    _manifest_path = manifest_path


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _load_manifest() -> dict[str, Any]:
    if not _manifest_path:
        raise RuntimeError("Cogito not configured: COGITO_MANIFEST_PATH not set")
    return load_manifest(_manifest_path)


def _find_service(manifest: dict[str, Any], name: str) -> dict[str, Any] | None:
    for svc in manifest.get("services", []):
        if svc.get("name") == name:
            return svc
    return None


async def _http_get(url: str, timeout: float = 5.0) -> dict[str, Any]:
    async with httpx.AsyncClient(timeout=timeout) as client:
        resp = await client.get(url)
        resp.raise_for_status()
        return resp.json()


async def _do_refresh() -> tuple[bool, str]:
    """Shared logic for brief refresh.

    Returns:
        ``(True, path_str)`` on success, ``(False, error_message)`` on failure.
    """
    if not _brief_composer:
        return False, "BriefComposer not initialized"
    path = await _brief_composer.write_brief()
    return True, str(path)


# ---------------------------------------------------------------------------
# MCP Tools
# ---------------------------------------------------------------------------

# NOTE: @reflect.capability가 아래에 있어야 원본 함수를 먼저 받아 inspect로 소스를 추적한다.
# @cogito_mcp.tool()이 위에 있으면 FunctionTool을 반환하므로, 순서를 바꾸면 소스 추적이 실패한다.
@cogito_mcp.tool()
@reflect.capability(
    name="cogito",
    description="서비스 리플렉션 데이터 조회 (MCP 도구)",
    tools=["reflect_service", "reflect_brief", "reflect_refresh"],
)
async def reflect_service(
    service: str,
    level: int = 0,
    capability: str | None = None,
) -> dict:
    """서비스의 리플렉션 데이터를 조회한다.

    Args:
        service: 서비스 이름 (mcp-seosoyoung, supervisor, soulstream-server 등)
        level: 조회 깊이 (0=기능목록, 1=설정, 2=소스위치, 3=런타임상태)
        capability: 특정 capability만 조회 (선택)

    Returns:
        Level 0: {"identity": {...}, "capabilities": [...]}
        Level 1: {"configs": [...]}
        Level 2: {"sources": [...]}
        Level 3: {"status": "healthy", "pid": ..., "uptime_seconds": ...}
    """
    try:
        manifest = _load_manifest()
    except Exception as e:
        return {"error": str(e)}

    svc = _find_service(manifest, service)
    if not svc:
        available = [s.get("name") for s in manifest.get("services", [])]
        return {"error": f"서비스를 찾을 수 없습니다: {service}", "available": available}

    svc_type = svc.get("type", "internal")

    # External services only support Level 0 (static data)
    if svc_type == "external":
        if level > 0:
            return {"error": f"외부 서비스 {service}는 Level 0만 지원합니다"}
        return svc.get("static", {})

    endpoint = svc.get("endpoint", "")
    if not endpoint:
        return {"error": f"서비스 {service}에 endpoint가 설정되지 않았습니다"}

    # Build URL based on level
    url = endpoint
    if level == 1:
        url += "/config"
        if capability:
            url += f"/{capability}"
    elif level == 2:
        url += "/source"
        if capability:
            url += f"/{capability}"
    elif level == 3:
        url += "/runtime"

    try:
        return await _http_get(url)
    except Exception as e:
        return {"error": f"서비스 {service} 조회 실패: {e}"}


@cogito_mcp.tool()
async def reflect_brief() -> dict:
    """전체 서비스의 Level 0 브리프를 반환한다.

    Returns:
        {"services": [{"name": ..., "type": ..., "data": {...}}, ...]}
    """
    if not _brief_composer:
        return {"error": "BriefComposer가 초기화되지 않았습니다"}

    try:
        services = await _brief_composer.compose()
        result = []
        for name, svc_type, data in services:
            result.append({"name": name, "type": svc_type, "data": data})
        return {"services": result}
    except Exception as e:
        return {"error": f"브리프 조회 실패: {e}"}


@cogito_mcp.tool()
async def reflect_refresh() -> dict:
    """브리프 파일(brief.md)을 즉시 갱신한다.

    Returns:
        {"refreshed": true, "path": "...brief.md"}
    """
    try:
        ok, result = await _do_refresh()
    except Exception as e:
        return {"error": f"브리프 갱신 실패: {e}"}

    if not ok:
        return {"error": result}
    return {"refreshed": True, "path": result}


# ---------------------------------------------------------------------------
# Session query helpers
# ---------------------------------------------------------------------------

def _truncate_tool_event(ev: dict, max_chars: int) -> dict:
    ev = dict(ev)
    for field in ("input", "output", "content"):
        if field in ev:
            val = ev[field]
            if isinstance(val, str) and len(val) > max_chars:
                ev[field] = val[:max_chars] + f"... [{len(val) - max_chars}자 생략]"
            elif isinstance(val, dict):
                serialized = str(val)
                if len(serialized) > max_chars:
                    ev[field] = serialized[:max_chars] + "... [생략]"
    return ev


# ---------------------------------------------------------------------------
# MCP Tools — Session query
# ---------------------------------------------------------------------------

@cogito_mcp.tool()
async def list_sessions(
    cursor: int = 0,
    limit: int = 20,
) -> dict:
    """세션 목록을 페이지네이션하여 조회한다.

    Args:
        cursor: 시작 오프셋 (행 인덱스 기반 정수). 첫 호출 시 0.
        limit: 반환할 세션 수 (최대 100).

    Returns:
        {sessions: [...], next_cursor: int | None}
        next_cursor가 None이면 마지막 페이지.
    """
    try:
        tm = get_task_manager()
    except RuntimeError as e:
        return {"error": str(e)}
    limit = min(limit, 100)
    sessions, _total = tm.get_all_sessions(offset=cursor, limit=limit + 1)
    has_more = len(sessions) > limit
    return {
        "sessions": sessions[:limit],
        "next_cursor": cursor + limit if has_more else None,
    }


@cogito_mcp.tool()
async def list_session_events(
    session_id: str,
    cursor: int = 0,
    limit: int = 20,
    tool_truncate_chars: int = 500,
) -> dict:
    """세션의 이벤트 목록을 페이지네이션하여 조회한다.

    Args:
        session_id: 세션 ID.
        cursor: 마지막으로 수신한 이벤트 ID (이 ID는 포함하지 않음). 0이면 처음부터 반환.
                행 오프셋이 아닌 이벤트 ID임에 주의.
        limit: 반환할 이벤트 수 (최대 100).
        tool_truncate_chars: tool_use/tool_result 이벤트의 input/output/content 필드를
                             잘라낼 글자 수. 0이면 자르지 않음.

    Returns:
        {events: [...], next_cursor: int | None}
        next_cursor가 None이면 마지막 페이지.
    """
    import json as _json
    try:
        db = get_session_db()
    except RuntimeError as e:
        return {"error": str(e)}
    limit = min(limit, 100)
    session = db.get_session(session_id)
    if session is None:
        return {"error": f"세션을 찾을 수 없습니다: {session_id}"}
    all_events = db.read_events(session_id, after_id=cursor)
    has_more = len(all_events) > limit
    result = []
    for entry in all_events[:limit]:
        try:
            ev = _json.loads(entry["payload"])
        except (_json.JSONDecodeError, KeyError):
            ev = {}
        if tool_truncate_chars > 0 and ev.get("type") in ("tool_use", "tool_result"):
            ev = _truncate_tool_event(ev, tool_truncate_chars)
        result.append({"id": entry["id"], "event": ev})
    last_id = result[-1]["id"] if result else cursor
    return {
        "events": result,
        "next_cursor": last_id if has_more else None,
    }


@cogito_mcp.tool()
async def get_session_event(
    session_id: str,
    event_id: int,
) -> dict:
    """특정 이벤트의 전문을 조회한다 (truncation 없음).

    Args:
        session_id: 세션 ID.
        event_id: 이벤트 ID (list_session_events 반환 항목의 id 필드 값).

    Returns:
        {id: int, event: dict} 또는 {error: str}
    """
    import json as _json
    try:
        db = get_session_db()
    except RuntimeError as e:
        return {"error": str(e)}
    session = db.get_session(session_id)
    if session is None:
        return {"error": f"세션을 찾을 수 없습니다: {session_id}"}
    entry = db.read_one_event(session_id, event_id)
    if entry is None:
        return {"error": f"이벤트를 찾을 수 없습니다: session={session_id}, event_id={event_id}"}
    try:
        ev = _json.loads(entry["payload"])
    except (_json.JSONDecodeError, KeyError):
        ev = {}
    return {"id": entry["id"], "event": ev}


@cogito_mcp.tool()
async def search_session_history(
    query: str,
    session_ids: list[str] | None = None,
    top_k: int = 10,
) -> dict:
    """BM25로 세션 이벤트 텍스트를 검색한다.

    Args:
        query: 검색어 (공백 기반 토크나이즈, 한글 지원)
        session_ids: 검색할 세션 ID 목록. None이면 전체 세션 검색.
        top_k: 반환할 최대 결과 수 (최대 100).

    Returns:
        {results: [{session_id, event_id, score, preview, event_type}, ...]}
        score > 0인 항목만 반환.
    """
    try:
        db = get_session_db()
    except RuntimeError as e:
        return {"error": str(e)}
    from soul_server.cogito.search import SessionSearchEngine
    try:
        engine = SessionSearchEngine(db)
        results = engine.search(query=query, session_ids=session_ids, top_k=top_k)
    except ValueError as e:
        return {"error": str(e)}
    return {"results": [r.to_dict() for r in results]}


# ---------------------------------------------------------------------------
# MCP Tools — Session name management
# ---------------------------------------------------------------------------


@cogito_mcp.tool()
async def get_session_name(session_id: str) -> dict:
    """세션의 표시 이름(displayName)을 조회한다.

    Args:
        session_id: 세션 ID (agent_session_id).

    Returns:
        {session_id: str, display_name: str | None}
    """
    try:
        db = get_session_db()
    except RuntimeError as e:
        return {"error": str(e)}
    session = db.get_session(session_id)
    if session is None:
        return {"error": f"세션을 찾을 수 없습니다: {session_id}"}
    return {
        "session_id": session_id,
        "display_name": session.get("display_name"),
    }


@cogito_mcp.tool()
async def set_session_name(session_id: str, name: str = "") -> dict:
    """세션의 표시 이름(displayName)을 설정한다.

    빈 문자열을 전달하면 이름을 제거한다.
    대시보드에서 📌 접두어로 표시된다.

    Args:
        session_id: 세션 ID (agent_session_id).
        name: 설정할 이름. 빈 문자열이면 이름 제거.

    Returns:
        {session_id: str, display_name: str | None}
    """
    try:
        db = get_session_db()
    except RuntimeError as e:
        return {"error": str(e)}
    session = db.get_session(session_id)
    if session is None:
        return {"error": f"세션을 찾을 수 없습니다: {session_id}"}
    display_name = name.strip() or None
    db.rename_session(session_id, display_name)
    # 카탈로그 변경 브로드캐스트 (대시보드 실시간 반영)
    try:
        broadcaster = get_session_broadcaster()
    except RuntimeError:
        pass  # 서버 초기화 전이면 브로드캐스트 생략
    else:
        catalog = db.get_catalog()
        await broadcaster.broadcast({"type": "catalog_updated", "catalog": catalog})
    return {
        "session_id": session_id,
        "display_name": display_name,
    }


# ---------------------------------------------------------------------------
# REST API router — cogito-related endpoints outside of MCP
# ---------------------------------------------------------------------------

cogito_api_router = APIRouter(prefix="/cogito", tags=["cogito"])


@cogito_api_router.post("/refresh")
async def api_refresh() -> dict:
    """브리프를 즉시 갱신하는 REST 엔드포인트 (CLI에서 사용)."""
    try:
        ok, result = await _do_refresh()
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Refresh failed: {e}")

    if not ok:
        raise HTTPException(status_code=503, detail=result)
    return {"refreshed": True, "path": result}


@cogito_api_router.get("/search")
async def api_search_sessions(
    q: str,
    top_k: int = Query(default=10, ge=1, le=100),
    session_ids: str | None = None,  # 콤마 구분 문자열
) -> dict:
    """세션 기록 FTS5 검색 REST 엔드포인트."""
    try:
        db = get_session_db()
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e))
    from soul_server.cogito.search import SessionSearchEngine
    ids = [s.strip() for s in session_ids.split(",") if s.strip()] if session_ids else None
    try:
        engine = SessionSearchEngine(db)
        results = engine.search(query=q, session_ids=ids, top_k=top_k)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {
        "results": [r.to_dict() for r in results]
    }
