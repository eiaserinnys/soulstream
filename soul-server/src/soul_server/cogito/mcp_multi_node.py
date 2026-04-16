"""Multi-node MCP tools (orchestrator proxy).

SOULSTREAM_UPSTREAM_ENABLED=true일 때만 init()이 호출되어 도구가 등록된다.
"""

from __future__ import annotations

import re
import logging
from typing import Optional

import httpx

from soul_server.cogito.mcp_tools import cogito_mcp

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Runtime state
# ---------------------------------------------------------------------------

_orch_base: str | None = None


def get_orch_base() -> str | None:
    """오케스트레이터 HTTP base URL을 반환한다. send_message_to_session 폴백에서 사용."""
    return _orch_base


def init(settings) -> None:
    """multi-node 전용 도구를 cogito MCP에 등록하고 _orch_base를 설정한다.

    SOULSTREAM_UPSTREAM_ENABLED=true일 때만 호출해야 한다.
    """
    global _orch_base
    if _orch_base is not None:
        return  # 중복 호출 방어

    url = settings.soulstream_upstream_url
    url = re.sub(r'^wss://', 'https://', url)
    url = re.sub(r'^ws://', 'http://', url)
    _orch_base = re.sub(r'/ws/.*$', '', url)

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

        Args:
            node_id: 대상 노드 ID
            agent_id: 에이전트 프로필 ID (None이면 기본 에이전트 사용)
            prompt: 수행할 작업 프롬프트
            caller_session_id: 발신 세션 ID.
            folder_id: 세션을 배치할 폴더 ID
        """
        body = {
            "prompt": prompt,
            "nodeId": node_id,
            "profile": agent_id,
            "folderId": folder_id,
            "caller_session_id": caller_session_id,
        }
        body = {k: v for k, v in body.items() if v is not None}
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(f"{_orch_base}/api/sessions", json=body)
            resp.raise_for_status()
            return resp.json()
