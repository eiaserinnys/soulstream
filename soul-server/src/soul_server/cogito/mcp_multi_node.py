"""Multi-node MCP tools (orchestrator proxy).

SOULSTREAM_UPSTREAM_ENABLED=true일 때만 init()이 호출되어 도구가 등록된다.

함수는 module-level로 노출되어 단위 테스트에서 직접 호출 가능하다 (design-principles §10).
init()는 _orch_base/_orch_headers 셋업 + cogito MCP 등록만 담당한다.
"""

from __future__ import annotations

import re
import logging
from typing import Optional

import httpx

from soul_common.auth.caller_info import build_agent_caller_info

from soul_server.cogito.mcp_tools import cogito_mcp
from soul_server.service.task_manager import get_task_manager

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Runtime state
# ---------------------------------------------------------------------------

_orch_base: str | None = None
_orch_headers: dict[str, str] = {}


def get_orch_base() -> str | None:
    """오케스트레이터 HTTP base URL을 반환한다. send_message_to_session 폴백에서 사용."""
    return _orch_base


def get_orch_headers() -> dict[str, str]:
    """오케스트레이터 요청에 사용할 인증 헤더를 반환한다."""
    return _orch_headers


# ---------------------------------------------------------------------------
# MCP Tools (module-level — 테스트 가능)
# ---------------------------------------------------------------------------

async def list_nodes() -> dict:
    """오케스트레이터에 연결된 노드 목록 반환."""
    async with httpx.AsyncClient(timeout=10.0, headers=_orch_headers) as client:
        resp = await client.get(f"{_orch_base}/api/nodes")
        resp.raise_for_status()
        return resp.json()


async def list_node_agents(node_id: str) -> dict:
    """특정 노드에서 사용 가능한 에이전트 목록 반환."""
    async with httpx.AsyncClient(timeout=10.0, headers=_orch_headers) as client:
        resp = await client.get(f"{_orch_base}/api/nodes/{node_id}/agents")
        resp.raise_for_status()
        return resp.json()


async def create_remote_agent_session(
    node_id: str,
    agent_id: Optional[str],
    prompt: str,
    caller_session_id: Optional[str] = None,
    folder_id: Optional[str] = None,
) -> dict:
    """다른 노드에 새 에이전트 세션을 생성한다. 비동기 (세션 ID만 반환).

    Args:
        node_id: 대상 노드 ID
        agent_id: 에이전트 프로필 ID (None이면 기본 에이전트 사용)
        prompt: 수행할 작업 프롬프트
        caller_session_id: 발신 세션 ID.
        folder_id: 세션을 배치할 폴더 ID
    """
    # caller_info 조립: MCP 진입점이므로 source="agent" 고정.
    # caller_session_id가 지정된 경우 발신 세션의 프로필 정보를 함께 전달한다.
    # orch-server가 이 값을 그대로 node로 전파하여 원격 노드의 Task.caller_info에 도달한다.
    # 통합 v1 스키마는 build_agent_caller_info가 정본 — 1-A(create_agent_session)와 공유.
    # 직전 결함: 본 진입점이 v1 promote 키(display_name/user_id/avatar_url) 누락으로
    # 원격 노드의 Task.caller_info에 신원 정보가 도달하지 않아 catalog userPortraitUrl=null.
    caller_info: dict | None = None
    if caller_session_id:
        task_manager = get_task_manager()
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

    body = {
        "prompt": prompt,
        "nodeId": node_id,
        "profile": agent_id,
        "folderId": folder_id,
        "caller_session_id": caller_session_id,
        "caller_info": caller_info,
    }
    body = {k: v for k, v in body.items() if v is not None}
    async with httpx.AsyncClient(timeout=30.0, headers=_orch_headers) as client:
        resp = await client.post(f"{_orch_base}/api/sessions", json=body)
        resp.raise_for_status()
        return resp.json()


def init(settings) -> None:
    """multi-node 전용 도구를 cogito MCP에 등록하고 _orch_base를 설정한다.

    SOULSTREAM_UPSTREAM_ENABLED=true일 때만 호출해야 한다.
    """
    global _orch_base, _orch_headers
    if _orch_base is not None:
        return  # 중복 호출 방어

    url = settings.soulstream_upstream_url
    url = re.sub(r'^wss://', 'https://', url)
    url = re.sub(r'^ws://', 'http://', url)
    _orch_base = re.sub(r'/ws/.*$', '', url)

    token = getattr(settings, "auth_bearer_token", "")
    if token:
        _orch_headers = {"Authorization": f"Bearer {token}"}

    # cogito MCP에 module-level 함수 등록
    cogito_mcp.tool()(list_nodes)
    cogito_mcp.tool()(list_node_agents)
    cogito_mcp.tool()(create_remote_agent_session)
