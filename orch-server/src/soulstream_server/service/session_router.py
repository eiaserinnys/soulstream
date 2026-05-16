"""
SessionRouter — 세션 생성 요청을 적절한 노드로 라우팅.

옵션 D Phase A: agent.backend ↔ node.supported_backends 매칭 필터로 라우팅.
profile 부재 / unknown profile은 backend 필터 우회 (graceful — 후방호환).
"""

import logging
import uuid

from fastapi import HTTPException

from soulstream_server.nodes.node_manager import NodeManager

logger = logging.getLogger(__name__)


class NoMatchingBackendNode(HTTPException):
    """No connected node supports the requested backend."""

    def __init__(self, backend: str):
        super().__init__(
            status_code=503,
            detail=f"No connected node supports backend '{backend}'",
        )


class SessionRouter:
    """세션 생성 요청을 노드에 라우팅한다.

    노드 지정이 없으면 backend 매칭 노드 중 세션 수가 가장 적은 노드에 할당
    (backend-filtered least-sessions-first).
    """

    def __init__(self, node_manager: NodeManager) -> None:
        self._node_manager = node_manager

    async def route_create_session(
        self, request: dict
    ) -> tuple[str, str]:
        """세션 생성 요청을 라우팅하고 (session_id, node_id)를 반환한다.

        Raises:
            HTTPException 503: 연결된 노드 없음 또는 backend 매칭 노드 없음
            HTTPException 404: 지정된 노드를 찾을 수 없음
            HTTPException 409: 지정 노드가 요청 backend를 지원하지 않음
        """
        target_node_id = request.get("nodeId")
        nodes = self._node_manager.get_connected_nodes()

        if not nodes:
            raise HTTPException(
                status_code=503,
                detail="No nodes available",
            )

        # 옵션 D Phase A: profile_id로 agent backend 조회. profile 없으면 None — 필터 우회.
        backend = self._resolve_backend(request.get("profile"))

        if target_node_id:
            node = self._node_manager.get_node(target_node_id)
            if not node:
                raise HTTPException(
                    status_code=404,
                    detail=f"Node {target_node_id} not found",
                )
            if backend and backend not in node.supported_backends:
                raise HTTPException(
                    status_code=409,
                    detail=(
                        f"Node {target_node_id} does not support backend '{backend}' "
                        f"(supports: {node.supported_backends})"
                    ),
                )
        else:
            # backend 매칭 노드만 후보로 — backend가 None이면 모든 노드 후보 (graceful).
            eligible = [n for n in nodes if not backend or backend in n.supported_backends]
            if not eligible:
                raise NoMatchingBackendNode(backend)
            # least-sessions-first within eligible pool
            node = min(eligible, key=lambda n: n.session_count)

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
            caller_session_id=request.get("caller_session_id"),
            attachment_paths=request.get("attachmentPaths"),
            caller_info=request.get("caller_info"),
            model=request.get("model"),
            extra_context_items=request.get("extra_context_items"),
        )

        # 노드가 반환한 세션 ID를 우선 사용
        actual_session_id = result.get("agentSessionId", session_id)
        return actual_session_id, node.node_id

    def _resolve_backend(self, profile_id: str | None) -> str | None:
        """profile_id로 agent의 backend를 결정.

        profile_id가 없거나 NodeManager가 해당 profile을 찾지 못하면 None을 반환하여
        backend 필터를 우회한다 (graceful — 후방호환·degraded mode).
        """
        if not profile_id:
            return None
        found = self._node_manager.find_agent_profile(profile_id)
        if not found:
            return None
        profile, _source_node_id = found
        return profile.get("backend", "claude")
