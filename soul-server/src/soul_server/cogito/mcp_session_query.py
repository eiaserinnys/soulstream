"""Session query MCP tools (read-only).

세션 이벤트 조회, 히스토리 다운로드, 검색, 요약 등 읽기 전용 도구.
"""

from __future__ import annotations

import json as _json
import logging
from pathlib import Path

from soul_server.cogito.mcp_tools import cogito_mcp
from soul_server.service.session_query_service import get_session_query_service
from soul_server.service.postgres_session_db import get_session_db

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Internal helpers
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


def _serialize_datetime(val: object) -> str | None:
    """datetime 또는 문자열을 ISO 문자열로 변환한다."""
    if val is None:
        return None
    if hasattr(val, "isoformat"):
        return val.isoformat()
    return str(val)


def _assemble_turns(events: list[dict], max_response_chars: int) -> list[dict]:
    """이벤트 목록을 턴 단위로 조립한다."""
    turns: list[dict] = []
    current_turn: dict | None = None

    for entry in events:
        try:
            ev = _json.loads(entry["payload"])
        except (_json.JSONDecodeError, KeyError):
            continue

        event_type = ev.get("type") or entry.get("event_type", "")

        if event_type == "user_message":
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

    if current_turn is not None:
        turns.append(current_turn)

    return turns


# ---------------------------------------------------------------------------
# MCP Tools
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

    Returns:
        {total: int, sessions: [...], next_cursor: int | None}
        next_cursor가 None이면 마지막 페이지.
    """
    try:
        svc = get_session_query_service()
    except RuntimeError as e:
        return {"error": str(e)}
    limit = min(limit, 100)

    resolved_folder_id = folder_id
    if folder_name and not folder_id:
        all_folders = await svc.get_all_folders()
        matched = next((f for f in all_folders if f.get("name") == folder_name), None)
        resolved_folder_id = matched["id"] if matched else None

    resolved_node_id = node_id or node_name

    sessions, total = await svc.list_sessions_summary(
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
        limit: 반환할 이벤트 수 (최대 100).
        tool_truncate_chars: tool_content="truncate"일 때 잘라낼 글자 수. 기본 500.
        event_types: 반환할 이벤트 타입 목록 (None이면 전체).
        tool_content: tool_use/tool_result 이벤트 처리 방식.
                      "omit" / "truncate" (기본) / "full".

    Returns:
        {total: int, events: [...], next_cursor: int | None}
    """
    try:
        db = get_session_db()
    except RuntimeError as e:
        return {"error": str(e)}
    limit = min(limit, 100)
    session = await db.get_session(session_id)
    if session is None:
        return {"error": f"세션을 찾을 수 없습니다: {session_id}"}
    total = await db.count_events(session_id)
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
        event_id: 이벤트 ID.

    Returns:
        {id: int, event: dict} 또는 {error: str}
    """
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
async def download_session_history(
    session_id: str,
    output_dir: str | None = None,
) -> dict:
    """세션의 전체 이벤트 히스토리를 JSONL 파일로 저장한다.

    Args:
        session_id: 세션 ID.
        output_dir: 저장 디렉토리 경로. 미지정 시 /tmp/soulstream_sessions/.

    Returns:
        {"session_id": str, "file_path": str, "event_count": int}
    """
    try:
        db = get_session_db()
    except RuntimeError as e:
        return {"error": str(e)}

    session = await db.get_session(session_id)
    if session is None:
        return {"error": f"세션을 찾을 수 없습니다: {session_id}"}

    out_dir = Path(output_dir) if output_dir else Path("/tmp/soulstream_sessions")
    out_dir.mkdir(parents=True, exist_ok=True)
    file_path = str(out_dir / f"session_{session_id}.jsonl")

    event_count = 0
    with open(file_path, "w", encoding="utf-8") as f:
        async for ev_id, ev_type, payload_text in db.stream_events_raw(session_id):
            try:
                event = _json.loads(payload_text) if payload_text else {}
            except _json.JSONDecodeError:
                event = {}
            line = _json.dumps(
                {"id": ev_id, "event_type": ev_type, "event": event},
                ensure_ascii=False,
            )
            f.write(line + "\n")
            event_count += 1

    return {
        "session_id": session_id,
        "file_path": file_path,
        "event_count": event_count,
    }


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

    Args:
        session_id: 세션 ID.
        max_response_chars: 응답 텍스트 최대 길이 (기본 500).

    Returns:
        {session_id, display_name, status, created_at, total_events, turns: [...]}
    """
    try:
        db = get_session_db()
    except RuntimeError as e:
        return {"error": str(e)}

    session = await db.get_session(session_id)
    if session is None:
        return {"error": f"세션을 찾을 수 없습니다: {session_id}"}

    total_events = await db.count_events(session_id)

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
        # 위임 세션의 부모 식별자. 직접 진입은 None.
        "caller_session_id": session.get("caller_session_id"),
        "total_events": total_events,
        "turns": turns,
    }
