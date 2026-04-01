"""Cogito MCP tools for soulstream.

Exposes cogito reflection data as MCP tools, allowing Claude Code sessions
to query service metadata at various levels of detail.

Dependencies are injected via :func:`init` at server startup; tools return
error dicts gracefully when cogito is not configured.
"""

from __future__ import annotations

import logging
import re
from pathlib import Path
from typing import TYPE_CHECKING, Any, Optional

import httpx
from fastapi import APIRouter, HTTPException, Query
from fastmcp import FastMCP

from cogito.manifest import load_manifest
from soul_server.cogito.reflector_setup import reflect
from soul_server.service.task_manager import get_task_manager
from soul_server.service.postgres_session_db import get_session_db
from soul_server.service.session_broadcaster import get_session_broadcaster
from soul_server.service.catalog_service import get_catalog_service
from soul_server.service import get_soul_engine, resource_manager

if TYPE_CHECKING:
    from soul_server.cogito.brief_composer import BriefComposer

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# FastMCP server instance (tools registered below)
# ---------------------------------------------------------------------------

cogito_mcp = FastMCP("soulstream")

# ---------------------------------------------------------------------------
# Runtime state — set by init() from main.py lifespan
# ---------------------------------------------------------------------------

_brief_composer: BriefComposer | None = None
_manifest_path: str | None = None
_orch_base: str | None = None  # multi-node 모드에서 init_multi_node_tools()가 설정


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

def _omit_tool_content(ev: dict) -> dict:
    ev = dict(ev)
    for field in ("input", "output", "content", "result"):
        ev.pop(field, None)
    return ev


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
    search: str | None = None,
    folder_id: str | None = None,
    folder_name: str | None = None,
    node_id: str | None = None,
    node_name: str | None = None,
) -> dict:
    """세션 목록을 페이지네이션하여 조회한다.

    경량 필드(session_id, display_name, status, session_type, created_at,
    updated_at, event_count)만 반환하여 토큰을 절약한다.

    Args:
        cursor: 시작 오프셋 (행 인덱스 기반 정수). 첫 호출 시 0.
        limit: 반환할 세션 수 (최대 100).
        search: display_name 검색어 (부분 일치, 대소문자 무시).
        folder_id: 폴더 UUID 또는 시스템 ID (예: "claude")로 필터.
        folder_name: 폴더 표시 이름 (예: "⚙️ 클로드 코드 세션")으로 필터.
            folder_id와 동시 제공 시 folder_id 우선.
        node_id: soulstream 노드 식별자 exact match (SOULSTREAM_NODE_ID 환경변수 값).
        node_name: node_id와 동일한 컬럼에 exact match.
            node_id와 동시 제공 시 node_id 우선.
            (node_id가 이미 사람이 읽을 수 있는 문자열 식별자이므로 동일 필드 사용)

    Returns:
        {total: int, sessions: [...], next_cursor: int | None}
        next_cursor가 None이면 마지막 페이지.
    """
    try:
        tm = get_task_manager()
    except RuntimeError as e:
        return {"error": str(e)}
    limit = min(limit, 100)

    # folder_name → folder_id 해소: get_all_folders()로 Python 레이어 필터링
    resolved_folder_id = folder_id
    if folder_name and not folder_id:
        all_folders = await tm.get_all_folders()
        matched = next((f for f in all_folders if f.get("name") == folder_name), None)
        resolved_folder_id = matched["id"] if matched else None

    # node_name → node_id (동일 컬럼, 별도 nodes 테이블 없음)
    resolved_node_id = node_id or node_name

    sessions, total = await tm.list_sessions_summary(
        search=search, limit=limit, offset=cursor,
        folder_id=resolved_folder_id, node_id=resolved_node_id,
    )
    has_more = cursor + limit < total
    return {
        "total": total,
        "sessions": sessions,
        "next_cursor": cursor + limit if has_more else None,
    }


@cogito_mcp.tool()
async def list_local_agents() -> dict:
    """현재 노드에서 사용 가능한 에이전트 목록 반환."""
    # 순환 참조 방지를 위해 지연 import
    # get_agent_registry()는 미초기화 시 RuntimeError를 던짐 (main.py L73~77)
    from soul_server.main import get_agent_registry
    try:
        registry = get_agent_registry()
    except RuntimeError as e:
        logger.warning("AgentRegistry 미초기화 — list_local_agents: %s", e)
        return {"agents": []}
    return {
        "agents": [
            {"id": p.id, "name": p.name, "max_turns": p.max_turns}
            for p in registry.list()
        ]
    }


@cogito_mcp.tool()
async def create_agent_session(
    agent_id: Optional[str],
    prompt: str,
    caller_session_id: Optional[str] = None,
    folder_id: Optional[str] = None,
) -> dict:
    """현재 노드에 새 에이전트 세션을 생성한다. 비동기 (세션 ID만 반환).

    caller_session_id가 지정되면 에이전트 세션 완료 시 자동으로 해당 세션에 결과를 보고한다.

    Args:
        agent_id: 에이전트 프로필 ID (None이면 기본 에이전트 사용)
        prompt: 수행할 작업 프롬프트
        caller_session_id: 발신 세션 ID. 지정하면 에이전트 완료 시 자동 완료 보고 전송.
        folder_id: 세션을 배치할 폴더 ID (None이면 기본 배치)
    """
    task_manager = get_task_manager()
    task = await task_manager.create_task(
        prompt=prompt,
        profile_id=agent_id,
        folder_id=folder_id,
        caller_session_id=caller_session_id,
    )

    if caller_session_id:
        # caller_agent_info 설정: 발신자 메타데이터 (user_message 이벤트에 포함됨)
        caller_task = await task_manager.get_task(caller_session_id)
        caller_profile = None
        if caller_task and caller_task.profile_id and task_manager._agent_registry:
            caller_profile = task_manager._agent_registry.get(caller_task.profile_id)

        task.caller_agent_info = {
            "source": "agent",
            "agent_node": task_manager._db.node_id,
            "agent_id": caller_task.profile_id if caller_task else None,
            "agent_name": caller_profile.name if caller_profile else None,
        }

    # 백그라운드에서 Claude 실행 시작
    await task_manager.start_execution(
        agent_session_id=task.agent_session_id,
        claude_runner=get_soul_engine(),
        resource_manager=resource_manager,
    )

    return {"agent_session_id": task.agent_session_id, "status": task.status.value}


@cogito_mcp.tool()
async def send_message_to_session(target_session_id: str, message: str) -> dict:
    """대상 세션에 메시지를 전달한다.

    내부적으로 task_manager.add_intervention()을 사용하며,
    세션 상태에 따라 동작이 다르다:
    - Running/paused 세션: intervention queue에 추가
    - 완료/유휴/에러 세션: 자동 resume하여 메시지 전달

    로컬 세션 실패 시 _orch_base가 설정되어 있으면 오케스트레이터 경유 폴백을 시도한다.

    Returns:
        {"ok": True, "detail": ...} 또는 {"ok": False, "error": "..."}
    """
    task_manager = get_task_manager()
    try:
        result = await task_manager.add_intervention(
            agent_session_id=target_session_id,
            text=message,
            user="agent",  # user는 기본값 없는 필수값 (HTTP API InterveneRequest.user와 다름)
        )
        return {"ok": True, "detail": result}
    except Exception as local_err:
        logger.warning("send_message_to_session 로컬 실패: %s", local_err, exc_info=True)
        if _orch_base is None:
            return {"ok": False, "error": str(local_err)}
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                resp = await client.post(
                    f"{_orch_base}/api/sessions/{target_session_id}/intervene",
                    json={"text": message, "user": "agent"},
                )
                resp.raise_for_status()
                return {"ok": True, "detail": resp.json()}
        except Exception as remote_err:
            return {"ok": False, "error": f"local: {local_err}, remote: {remote_err}"}


@cogito_mcp.tool()
async def list_session_events(
    session_id: str,
    cursor: int = 0,
    limit: int = 20,
    tool_truncate_chars: int = 500,
    event_types: list[str] | None = None,
    tool_content: str = "truncate",
) -> dict:
    """세션의 이벤트 목록을 페이지네이션하여 조회한다.

    Args:
        session_id: 세션 ID.
        cursor: 마지막으로 수신한 이벤트 ID (이 ID는 포함하지 않음). 0이면 처음부터 반환.
                행 오프셋이 아닌 이벤트 ID임에 주의.
        limit: 반환할 이벤트 수 (최대 100).
        tool_truncate_chars: tool_content="truncate"일 때 잘라낼 글자 수. 기본 500.
        event_types: 반환할 이벤트 타입 목록 (None이면 전체).
                     예: ["user_message", "result", "tool_start"]
        tool_content: tool_use/tool_result 이벤트 처리 방식.
                      "omit" — input/output/content/result 필드 제거.
                      "truncate" — tool_truncate_chars까지 잘라냄 (기본값).
                      "full" — 원본 그대로.

    Returns:
        {total: int, events: [...], next_cursor: int | None}
        next_cursor가 None이면 마지막 페이지.
    """
    import json as _json
    try:
        db = get_session_db()
    except RuntimeError as e:
        return {"error": str(e)}
    limit = min(limit, 100)
    session = await db.get_session(session_id)
    if session is None:
        return {"error": f"세션을 찾을 수 없습니다: {session_id}"}
    total = await db.count_events(session_id)
    # DB 레벨 LIMIT: limit+1로 조회하여 has_more 판단
    all_events = await db.read_events(
        session_id, after_id=cursor, limit=limit + 1, event_types=event_types,
    )
    has_more = len(all_events) > limit
    result = []
    for entry in all_events[:limit]:
        try:
            ev = _json.loads(entry["payload"])
        except (_json.JSONDecodeError, KeyError):
            ev = {}
        if ev.get("type") in ("tool_use", "tool_result"):
            if tool_content == "omit":
                ev = _omit_tool_content(ev)
            elif tool_content == "truncate" and tool_truncate_chars > 0:
                ev = _truncate_tool_event(ev, tool_truncate_chars)
            # "full" → no modification
        result.append({"id": entry["id"], "event": ev})
    last_id = result[-1]["id"] if result else cursor
    return {
        "total": total,
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
    session = await db.get_session(session_id)
    if session is None:
        return {"error": f"세션을 찾을 수 없습니다: {session_id}"}
    entry = await db.read_one_event(session_id, event_id)
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
        results = await engine.search(query=query, session_ids=session_ids, top_k=top_k)
    except ValueError as e:
        return {"error": str(e)}
    return {"results": [r.to_dict() for r in results]}


@cogito_mcp.tool()
async def get_session_summary(
    session_id: str,
    max_response_chars: int = 500,
) -> dict:
    """세션의 턴별 요약을 반환한다 (LLM 미사용, 순수 DB 이벤트 순회).

    user_message 이벤트를 기준으로 턴을 분리하고, 각 턴에서
    사용자 입력, 최종 응답 미리보기, 컨텍스트 사용량, 도구 사용 현황을 집계한다.

    Args:
        session_id: 세션 ID.
        max_response_chars: 응답 텍스트 최대 길이 (기본 500).

    Returns:
        {session_id, display_name, status, created_at, total_events, turns: [...]}
    """
    import json as _json
    try:
        db = get_session_db()
    except RuntimeError as e:
        return {"error": str(e)}

    session = await db.get_session(session_id)
    if session is None:
        return {"error": f"세션을 찾을 수 없습니다: {session_id}"}

    total_events = await db.count_events(session_id)

    # 턴 구성에 필요한 이벤트 타입만 조회
    relevant_types = ["user_message", "result", "context_usage", "tool_start"]
    events = await db.read_events(
        session_id, after_id=0, event_types=relevant_types,
    )

    turns = _assemble_turns(events, max_response_chars)

    return {
        "session_id": session_id,
        "display_name": session.get("display_name"),
        "status": session.get("status"),
        "created_at": _serialize_datetime(session.get("created_at")),
        "total_events": total_events,
        "turns": turns,
    }


def _serialize_datetime(val: object) -> str | None:
    """datetime 또는 문자열을 ISO 문자열로 변환한다."""
    if val is None:
        return None
    if hasattr(val, "isoformat"):
        return val.isoformat()
    return str(val)


def _assemble_turns(events: list[dict], max_response_chars: int) -> list[dict]:
    """이벤트 목록을 턴 단위로 조립한다."""
    import json as _json

    turns: list[dict] = []
    current_turn: dict | None = None

    for entry in events:
        try:
            ev = _json.loads(entry["payload"])
        except (_json.JSONDecodeError, KeyError):
            continue

        event_type = ev.get("type") or entry.get("event_type", "")

        if event_type == "user_message":
            # 새 턴 시작
            if current_turn is not None:
                turns.append(current_turn)
            text = ev.get("text") or ev.get("content", "")
            if isinstance(text, list):
                text = " ".join(
                    c.get("text", "") for c in text if isinstance(c, dict)
                )
            current_turn = {
                "user_message": text,
                "response_preview": None,
                "context_usage": None,
                "tools_used": {},
            }

        elif event_type == "result" and current_turn is not None:
            text = ev.get("result", "")
            if isinstance(text, list):
                text = " ".join(
                    c.get("text", "") for c in text if isinstance(c, dict)
                )
            if isinstance(text, str):
                if len(text) > max_response_chars:
                    text = text[:max_response_chars] + "..."
                current_turn["response_preview"] = text

        elif event_type == "context_usage" and current_turn is not None:
            current_turn["context_usage"] = {
                "percent": ev.get("percent"),
                "used_tokens": ev.get("used_tokens"),
                "max_tokens": ev.get("max_tokens"),
            }

        elif event_type == "tool_start" and current_turn is not None:
            tool_name = ev.get("tool") or ev.get("name", "unknown")
            current_turn["tools_used"][tool_name] = (
                current_turn["tools_used"].get(tool_name, 0) + 1
            )

    # 마지막 턴 추가
    if current_turn is not None:
        turns.append(current_turn)

    return turns


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
    session = await db.get_session(session_id)
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
    session = await db.get_session(session_id)
    if session is None:
        return {"error": f"세션을 찾을 수 없습니다: {session_id}"}
    display_name = name.strip() or None
    try:
        catalog_svc = get_catalog_service()
        await catalog_svc.rename_session(session_id, display_name)
    except RuntimeError:
        # CatalogService 초기화 전이면 DB 직접 호출 (서버 시작 중)
        await db.rename_session(session_id, display_name)
    return {
        "session_id": session_id,
        "display_name": display_name,
    }


# ---------------------------------------------------------------------------
# MCP Tools — Catalog management (folders & sessions)
# ---------------------------------------------------------------------------


@cogito_mcp.tool()
async def list_folders() -> dict:
    """전체 폴더 목록을 조회한다.

    Returns:
        {folders: [{id: str, name: str, sortOrder: int}, ...]}
    """
    try:
        catalog_svc = get_catalog_service()
    except RuntimeError as e:
        return {"error": str(e)}
    folders = await catalog_svc.list_folders()
    return {"folders": folders}


@cogito_mcp.tool()
async def create_folder(name: str, sort_order: int = 0) -> dict:
    """폴더를 생성한다.

    Args:
        name: 폴더 이름.
        sort_order: 정렬 순서 (기본 0).

    Returns:
        {id: str, name: str, sortOrder: int}
    """
    try:
        catalog_svc = get_catalog_service()
    except RuntimeError as e:
        return {"error": str(e)}
    return await catalog_svc.create_folder(name, sort_order)


@cogito_mcp.tool()
async def rename_folder(folder_id: str, name: str) -> dict:
    """폴더 이름을 변경한다.

    Args:
        folder_id: 폴더 ID.
        name: 새 이름.

    Returns:
        {ok: true}
    """
    try:
        catalog_svc = get_catalog_service()
    except RuntimeError as e:
        return {"error": str(e)}
    await catalog_svc.rename_folder(folder_id, name)
    return {"ok": True}


@cogito_mcp.tool()
async def delete_folder(folder_id: str) -> dict:
    """폴더를 삭제한다.

    Args:
        folder_id: 폴더 ID.

    Returns:
        {ok: true}
    """
    try:
        catalog_svc = get_catalog_service()
    except RuntimeError as e:
        return {"error": str(e)}
    await catalog_svc.delete_folder(folder_id)
    return {"ok": True}


@cogito_mcp.tool()
async def move_sessions_to_folder(
    session_ids: list[str],
    folder_id: str | None = None,
) -> dict:
    """세션들을 지정한 폴더로 이동한다.

    단일 세션도 리스트로 감싸서 전달한다.
    folder_id가 None이면 미배정(폴더 해제).

    Args:
        session_ids: 이동할 세션 ID 리스트.
        folder_id: 대상 폴더 ID. None이면 폴더 해제.

    Returns:
        {ok: true, moved: int}
    """
    try:
        catalog_svc = get_catalog_service()
    except RuntimeError as e:
        return {"error": str(e)}
    await catalog_svc.move_sessions_to_folder(session_ids, folder_id)
    return {"ok": True, "moved": len(session_ids)}


@cogito_mcp.tool()
async def get_folder_system_prompt(folder_id: str) -> dict:
    """폴더의 시스템 프롬프트(folderPrompt)를 조회한다.

    Args:
        folder_id: 조회할 폴더 ID.

    Returns:
        {folder_id: str, system_prompt: str | null}
        또는 {error: str}
    """
    try:
        catalog_svc = get_catalog_service()
    except RuntimeError as e:
        return {"error": str(e)}
    try:
        prompt = await catalog_svc.get_folder_system_prompt(folder_id)
    except ValueError as e:
        return {"error": str(e)}
    return {"folder_id": folder_id, "system_prompt": prompt}


@cogito_mcp.tool()
async def set_folder_system_prompt(
    folder_id: str,
    system_prompt: str | None = None,
) -> dict:
    """폴더의 시스템 프롬프트(folderPrompt)를 설정하거나 삭제한다.

    빈 문자열 또는 null을 전달하면 folderPrompt를 삭제한다.
    다른 settings 키는 보존된다.

    Args:
        folder_id: 대상 폴더 ID.
        system_prompt: 설정할 프롬프트. 빈 문자열 또는 null이면 삭제.

    Returns:
        {ok: true} 또는 {error: str}
    """
    try:
        catalog_svc = get_catalog_service()
    except RuntimeError as e:
        return {"error": str(e)}
    try:
        await catalog_svc.set_folder_system_prompt(folder_id, system_prompt)
    except ValueError as e:
        return {"error": str(e)}
    return {"ok": True}


@cogito_mcp.tool()
async def delete_session(session_id: str) -> dict:
    """세션을 삭제한다.

    세션의 모든 이벤트 데이터도 함께 삭제된다.

    Args:
        session_id: 삭제할 세션 ID.

    Returns:
        {ok: true, session_id: str}
    """
    try:
        catalog_svc = get_catalog_service()
    except RuntimeError as e:
        return {"error": str(e)}
    await catalog_svc.delete_session(session_id)
    return {"ok": True, "session_id": session_id}


def init_multi_node_tools(settings) -> None:
    """multi-node 전용 툴을 cogito MCP에 등록하고 _orch_base를 설정한다.

    SOULSTREAM_UPSTREAM_ENABLED=true일 때만 호출해야 한다.
    이 함수를 호출하지 않으면 해당 툴들은 MCP 서버에 등록되지 않는다.

    Phase 2: list_nodes, list_node_agents, create_remote_agent_session 툴 등록.

    내부에서 @cogito_mcp.tool()을 적용하면 이 함수 호출 시점에 등록이 이루어진다
    (Python 데코레이터 실행 시점 원칙 + FastMCP 런타임 등록 지원).
    """
    global _orch_base
    if _orch_base is not None:
        return  # 중복 호출 방어 — lifespan에서 1회만 호출되어야 함
    # ws://host:port/ws/node → http://host:port
    # wss://host:port/ws/node → https://host:port
    url = settings.soulstream_upstream_url
    url = re.sub(r'^wss://', 'https://', url)
    url = re.sub(r'^ws://', 'http://', url)
    _orch_base = re.sub(r'/ws/.*$', '', url)

    _settings = settings  # 클로저 캡처를 위해 로컬 변수에 바인딩

    @cogito_mcp.tool()
    async def list_nodes() -> dict:
        """오케스트레이터에 연결된 노드 목록 반환."""
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(f"{_orch_base}/api/nodes")
            resp.raise_for_status()
            return resp.json()

    @cogito_mcp.tool()
    async def list_node_agents(node_id: str) -> dict:
        """특정 노드에서 사용 가능한 에이전트 목록 반환."""
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(f"{_orch_base}/api/nodes/{node_id}/agents")
            resp.raise_for_status()
            return resp.json()

    @cogito_mcp.tool()
    async def create_remote_agent_session(
        node_id: str,
        agent_id: Optional[str],
        prompt: str,
        caller_session_id: Optional[str] = None,
        folder_id: Optional[str] = None,
    ) -> dict:
        """다른 노드에 새 에이전트 세션을 생성한다. 비동기 (세션 ID만 반환).

        오케스트레이터 POST /api/sessions에 nodeId를 포함하여 호출한다.
        caller_session_id가 지정되면 에이전트 세션 완료 시 자동으로 해당 세션에 결과를 보고한다.

        Args:
            node_id: 대상 노드 ID
            agent_id: 에이전트 프로필 ID (None이면 기본 에이전트 사용)
            prompt: 수행할 작업 프롬프트
            caller_session_id: 발신 세션 ID. 지정하면 에이전트 완료 시 자동 완료 보고 전송.
            folder_id: 세션을 배치할 폴더 ID (None이면 기본 배치)
        """
        body = {
            "prompt": prompt,
            "nodeId": node_id,
            "profile": agent_id,
            "folderId": folder_id,
            "caller_session_id": caller_session_id,
        }
        # None 값 제거 (exclude_none 상당)
        body = {k: v for k, v in body.items() if v is not None}
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(f"{_orch_base}/api/sessions", json=body)
            resp.raise_for_status()
            return resp.json()


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
        results = await engine.search(query=q, session_ids=ids, top_k=top_k)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {
        "results": [r.to_dict() for r in results]
    }
