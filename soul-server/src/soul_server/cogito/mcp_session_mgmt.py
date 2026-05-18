"""Session management MCP tools (write operations).

에이전트 목록, 세션 생성, 메시지 전송, 세션 이름 관리.
"""

from __future__ import annotations

import logging
from typing import Optional

import httpx

from soul_common.auth.caller_info import build_agent_caller_info

from soul_server.cogito.mcp_tools import cogito_mcp
from soul_server.service.task_manager import get_task_manager
# NOTE: CreateTaskParams 직접 import 제거 — create_agent_session이 submit_message 정본을
# 거치도록 변경되어 본 모듈은 CreateTaskParams를 직접 다루지 않는다 (design-principles §3).
from soul_server.service.postgres_session_db import get_session_db
from soul_server.service.catalog_service import get_catalog_service
from soul_server.service import get_soul_engine, resource_manager

logger = logging.getLogger(__name__)


def _get_orch_base() -> str | None:
    """multi-node 모드의 오케스트레이터 base URL을 반환한다."""
    from soul_server.cogito import mcp_multi_node
    return mcp_multi_node.get_orch_base()


def _get_orch_headers() -> dict[str, str]:
    """multi-node 모드의 오케스트레이터 인증 헤더를 반환한다."""
    from soul_server.cogito import mcp_multi_node
    return mcp_multi_node.get_orch_headers()


# ---------------------------------------------------------------------------
# MCP Tools
# ---------------------------------------------------------------------------

@cogito_mcp.tool()
async def list_local_agents() -> dict:
    """현재 노드에서 사용 가능한 에이전트 목록 반환."""
    # 순환 참조 방지를 위해 지연 import
    # get_agent_registry()는 미초기화 시 RuntimeError를 던짐
    from soul_server.bootstrap import get_agent_registry
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

    # caller_info 조립: MCP 진입점이므로 source="agent"로 고정하며,
    # caller_session_id가 지정된 경우 발신 세션의 프로필 정보를 포함한다.
    # 통합 v1 스키마(source/agent_node/agent_id/agent_name + display_name/user_id/avatar_url)는
    # soul_common.auth.caller_info.build_agent_caller_info가 정본으로 조립한다 (1-A·1-B 공유,
    # design-principles §3 정본 하나 + §9 대칭성).
    caller_info: Optional[dict] = None
    if caller_session_id:
        caller_task = await task_manager.get_task(caller_session_id)
        caller_profile = None
        if caller_task and caller_task.profile_id and task_manager._agent_registry:
            caller_profile = task_manager._agent_registry.get(caller_task.profile_id)

        caller_info = build_agent_caller_info(
            agent_node=task_manager._db.node_id,
            agent_id=caller_task.profile_id if caller_task else None,
            agent_name=caller_profile.name if caller_profile else None,
            portrait_path=caller_profile.portrait_path if caller_profile else None,
        )

    # 카드 YpM1d1sI: submit_message 정본 경유 (design-principles §3 정본 하나).
    # 신규 세션 생성만이지만 5번째 진입점이 정본을 우회하지 않도록 통합 — 향후 MCP 툴이
    # resume 케이스를 다루게 될 때 terminal 회로 누락 방지.
    # /execute·/intervene·/api/sessions·upstream CMD_CREATE_SESSION에 이어 5번째.
    from soul_server.service.message_submission_service import (
        SubmitMessageParams,
        submit_message,
    )

    submit_result = await submit_message(
        SubmitMessageParams(
            prompt=prompt,
            agent_session_id=None,  # 신규 세션 (MCP 툴은 신규 생성 전용)
            user="agent",  # MCP 진입점
            profile_id=agent_id,
            folder_id=folder_id,
            caller_session_id=caller_session_id,
            caller_info=caller_info,
        ),
        task_manager=task_manager,
    )
    # MCP는 신규 생성 전용이라 kind는 항상 'new_session' (방어적으로 auto_resumed도 포함)
    if submit_result.kind in ("new_session", "auto_resumed"):
        await task_manager.executor.start_execution(
            agent_session_id=submit_result.agent_session_id,
            claude_runner=get_soul_engine(),
            resource_manager=resource_manager,
        )

    return {
        "agent_session_id": submit_result.agent_session_id,
        "status": submit_result.task.status.value,
    }


@cogito_mcp.tool()
async def send_message_to_session(
    target_session_id: str,
    message: str,
    caller_session_id: Optional[str] = None,
) -> dict:
    """대상 세션에 메시지를 전달한다.

    내부적으로 task_manager.add_intervention()을 사용하며,
    세션 상태에 따라 동작이 다르다:
    - Running/paused 세션: intervention queue에 추가
    - 완료/유휴/에러 세션: 자동 resume하여 메시지 전달

    로컬 세션 실패 시 _orch_base가 설정되어 있으면 오케스트레이터 경유 폴백을 시도한다.

    caller_session_id가 지정되면 발신 세션의 agent 정보로 caller_info(통합 v1)를
    조립하여 add_intervention/원격 폴백 양쪽에 전달한다 — create_agent_session과
    정합 패턴 (design-principles §3 정본 하나, build_agent_caller_info 공유 + §9 대칭성).
    F-11A fix(2026-05-09, atom F-11): 본 함수가 caller_info를 forward하지 않아 위임자
    agent의 신원이 wire에서 사라지고 dashboard owner Google portrait로 fallback되던
    결함을 닫는다.

    Returns:
        {"ok": True, "detail": ...} 또는 {"ok": False, "error": "..."}
    """
    task_manager = get_task_manager()

    # caller_info 조립 — caller_session_id 미지정 시 None (기존 동작 보존)
    caller_info: Optional[dict] = None
    if caller_session_id:
        caller_task = await task_manager.get_task(caller_session_id)
        caller_profile = None
        if caller_task and caller_task.profile_id and task_manager._agent_registry:
            caller_profile = task_manager._agent_registry.get(caller_task.profile_id)
        caller_info = build_agent_caller_info(
            agent_node=task_manager._db.node_id,
            agent_id=caller_task.profile_id if caller_task else None,
            agent_name=caller_profile.name if caller_profile else None,
            portrait_path=caller_profile.portrait_path if caller_profile else None,
        )

    try:
        result = await task_manager.add_intervention(
            agent_session_id=target_session_id,
            text=message,
            user="agent",
            caller_info=caller_info,
        )
        if result.get("auto_resumed"):
            await task_manager.executor.start_execution(
                agent_session_id=target_session_id,
                claude_runner=get_soul_engine(),
                resource_manager=resource_manager,
            )
            logger.info(
                "send_message_to_session: auto-resumed session %s", target_session_id
            )
        return {"ok": True, "detail": result}
    except Exception as local_err:
        logger.warning("send_message_to_session 로컬 실패: %s", local_err, exc_info=True)
        orch_base = _get_orch_base()
        if orch_base is None:
            return {"ok": False, "error": str(local_err)}
        try:
            body: dict = {"text": message, "user": "agent"}
            if caller_info:
                body["caller_info"] = caller_info
            async with httpx.AsyncClient(timeout=10.0, headers=_get_orch_headers()) as client:
                resp = await client.post(
                    f"{orch_base}/api/sessions/{target_session_id}/intervene",
                    json=body,
                )
                resp.raise_for_status()
                return {"ok": True, "detail": resp.json()}
        except Exception as remote_err:
            return {"ok": False, "error": f"local: {local_err}, remote: {remote_err}"}


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
        await db.rename_session(session_id, display_name)
    return {
        "session_id": session_id,
        "display_name": display_name,
    }
