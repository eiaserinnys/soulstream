"""Session management MCP tools (write operations).

에이전트 목록, 세션 생성, 메시지 전송, 세션 이름 관리.
"""

from __future__ import annotations

import logging
from typing import Optional

import httpx

from soul_server.cogito.mcp_tools import cogito_mcp
from soul_server.service.task_manager import get_task_manager, CreateTaskParams
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
    caller_info: Optional[dict] = None
    if caller_session_id:
        caller_task = await task_manager.get_task(caller_session_id)
        caller_profile = None
        if caller_task and caller_task.profile_id and task_manager._agent_registry:
            caller_profile = task_manager._agent_registry.get(caller_task.profile_id)

        caller_info = {
            "source": "agent",
            "agent_node": task_manager._db.node_id,
            "agent_id": caller_task.profile_id if caller_task else None,
            "agent_name": caller_profile.name if caller_profile else None,
        }

    task = await task_manager.create_task(CreateTaskParams(
        prompt=prompt,
        profile_id=agent_id,
        folder_id=folder_id,
        caller_session_id=caller_session_id,
        caller_info=caller_info,
    ))

    await task_manager.executor.start_execution(
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
            user="agent",
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
            async with httpx.AsyncClient(timeout=10.0, headers=_get_orch_headers()) as client:
                resp = await client.post(
                    f"{orch_base}/api/sessions/{target_session_id}/intervene",
                    json={"text": message, "user": "agent"},
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
