"""
SessionRouter — 세션 생성 요청을 적절한 노드로 라우팅.
"""

import logging
import uuid

from fastapi import HTTPException

from soulstream_server.nodes.node_manager import NodeManager

logger = logging.getLogger(__name__)


class SessionRouter:
    """세션 생성 요청을 노드에 라우팅한다.

    노드 지정이 없으면 세션 수가 가장 적은 노드에 할당 (least-sessions-first).
    """

    def __init__(self, node_manager: NodeManager) -> None:
        self._node_manager = node_manager

    async def route_create_session(
        self, request: dict
    ) -> tuple[str, str]:
        """세션 생성 요청을 라우팅하고 (session_id, node_id)를 반환한다.

        Raises:
            HTTPException 503: 연결된 노드 없음
            HTTPException 404: 지정된 노드를 찾을 수 없음
        """
        target_node_id = request.get("nodeId")
        nodes = self._node_manager.get_connected_nodes()

        if not nodes:
            raise HTTPException(
                status_code=503,
                detail="No nodes available",
            )

        if target_node_id:
            node = self._node_manager.get_node(target_node_id)
            if not node:
                raise HTTPException(
                    status_code=404,
                    detail=f"Node {target_node_id} not found",
                )
        else:
            # least-sessions-first
            node = min(nodes, key=lambda n: n.session_count)

        session_id = str(uuid.uuid4())
        result = await node.send_create_session(
            prompt=request.get("prompt", ""),
            session_id=session_id,
            profile=request.get("profile"),
            allowed_tools=request.get("allowed_tools"),
            disallowed_tools=request.get("disallowed_tools"),
            use_mcp=request.get("use_mcp"),
            folder_id=request.get("folderId"),
            system_prompt=request.get("system_prompt"),
            oauth_profile_name=request.get("oauth_profile_name"),
        )

        # 노드가 반환한 세션 ID를 우선 사용
        actual_session_id = result.get("agentSessionId", session_id)
        return actual_session_id, node.node_id
