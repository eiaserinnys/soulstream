"""
SessionRouter — 세션 생성 요청을 적절한 노드로 라우팅.

옵션 D Phase A: agent.backend ↔ node.supported_backends 매칭 필터로 라우팅.
profile 부재는 선택된 노드의 호환 기본 profile로 해석한다.
"""

import logging
import uuid

from fastapi import HTTPException

from soulstream_server.nodes.node_manager import NodeManager

logger = logging.getLogger(__name__)

CREATE_SESSION_RECONCILE_TIMEOUT = 5.0
CREATE_SESSION_RECONCILE_POLL_INTERVAL = 0.1


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

        effective_profile_id = request.get("profile")

        if target_node_id:
            node = self._node_manager.get_node(target_node_id)
            if not node:
                raise HTTPException(
                    status_code=404,
                    detail=f"Node {target_node_id} not found",
                )
            # nodeId 지정 시 해당 노드 profile로 backend를 해석한다.
            if effective_profile_id:
                backend = self._resolve_backend_from_node(
                    node,
                    effective_profile_id,
                    missing_profile_status=404,
                )
            else:
                default_profile = self._default_profile_for_node(node)
                if default_profile is None:
                    raise HTTPException(
                        status_code=503,
                        detail=(
                            f"No compatible agent profile registered on node {target_node_id}"
                        ),
                    )
                effective_profile_id, profile = default_profile
                backend = profile.get("backend", "claude")
            if backend and backend not in node.supported_backends:
                raise HTTPException(
                    status_code=409,
                    detail=(
                        f"Node {target_node_id} does not support backend '{backend}' "
                        f"(supports: {node.supported_backends})"
                    ),
                )
            effective_backend = backend
        else:
            if effective_profile_id:
                eligible = self._profile_nodes(effective_profile_id, nodes)
                if not eligible:
                    raise HTTPException(
                        status_code=404,
                        detail=f"Agent profile '{effective_profile_id}' is not registered on any connected node",
                    )
                compatible = [
                    (candidate_node, profile)
                    for candidate_node, profile in eligible
                    if profile.get("backend", "claude") in candidate_node.supported_backends
                ]
                if not compatible:
                    backends = [
                        f"{candidate_node.node_id}:{profile.get('backend', 'claude')}"
                        for candidate_node, profile in eligible
                    ]
                    raise HTTPException(
                        status_code=409,
                        detail=(
                            f"Agent profile '{effective_profile_id}' is registered on connected nodes "
                            f"but none supports its configured backend ({backends})"
                        ),
                    )

                # profile이 여러 노드에 있으면 오류가 아니라 가용 후보 중 최소 세션 노드를 고른다.
                node, profile = min(
                    compatible,
                    key=lambda pair: pair[0].session_count,
                )
                backend = profile.get("backend", "claude")
                effective_backend = backend
            else:
                compatible_defaults = [
                    (candidate_node, profile_id, profile)
                    for candidate_node in nodes
                    for profile_id, profile in self._compatible_profiles(candidate_node)
                ]
                if not compatible_defaults:
                    raise HTTPException(
                        status_code=503,
                        detail="No compatible agent profiles available on connected nodes",
                    )
                node, effective_profile_id, profile = min(
                    compatible_defaults,
                    key=lambda item: item[0].session_count,
                )
                effective_backend = profile.get("backend", "claude")

        session_id = str(uuid.uuid4())
        try:
            result = await node.send_create_session(
                prompt=request.get("prompt", ""),
                session_id=session_id,
                profile=effective_profile_id,
                allowed_tools=request.get("allowed_tools"),
                disallowed_tools=request.get("disallowed_tools"),
                use_mcp=request.get("use_mcp"),
                claude_permission_mode=request.get("claude_permission_mode"),
                folder_id=request.get("folderId"),
                system_prompt=request.get("system_prompt"),
                oauth_profile_name=request.get("oauth_profile_name"),
                caller_session_id=request.get("caller_session_id"),
                attachment_paths=request.get("attachmentPaths"),
                caller_info=request.get("caller_info"),
                model=request.get("model"),
                reasoning_effort=(
                    request.get("reasoningEffort") if effective_backend == "codex" else None
                ),
                extra_context_items=request.get("extra_context_items"),
            )
        except TimeoutError:
            if await self._reconcile_timed_out_create_session(node, session_id):
                logger.warning(
                    "create_session command timed out but session was observed "
                    "via node cache; returning reconciled success "
                    "(node=%s, session_id=%s)",
                    node.node_id,
                    session_id,
                )
                return session_id, node.node_id
            raise

        # 노드가 반환한 세션 ID를 우선 사용
        actual_session_id = result.get("agentSessionId", session_id)
        return actual_session_id, node.node_id

    async def _reconcile_timed_out_create_session(self, node, session_id: str) -> bool:
        return await node.wait_for_session(
            session_id,
            timeout=CREATE_SESSION_RECONCILE_TIMEOUT,
            poll_interval=CREATE_SESSION_RECONCILE_POLL_INTERVAL,
        )

    def _resolve_backend_from_node(
        self,
        node,
        profile_id: str | None,
        *,
        missing_profile_status: int,
    ) -> str | None:
        """대상 노드의 profile_id로 backend를 결정한다."""
        if not profile_id:
            return None
        profile = getattr(node, "agent_profiles", {}).get(profile_id)
        if profile is None:
            raise HTTPException(
                status_code=missing_profile_status,
                detail=f"Agent profile '{profile_id}' is not registered on node {node.node_id}",
            )
        return profile.get("backend", "claude")

    @staticmethod
    def _profile_nodes(profile_id: str, nodes) -> list[tuple[object, dict]]:
        """profile_id가 등록된 연결 노드 후보를 반환한다."""
        matches: list[tuple[object, dict]] = []
        for node in nodes:
            profile = getattr(node, "agent_profiles", {}).get(profile_id)
            if profile is not None:
                matches.append((node, profile))
        return matches

    @staticmethod
    def _compatible_profiles(node) -> list[tuple[str, dict]]:
        """노드가 실행 가능한 agent profile 후보를 등록 순서대로 반환한다."""
        supported = set(getattr(node, "supported_backends", []) or [])
        profiles = getattr(node, "agent_profiles", {}) or {}
        return [
            (profile_id, profile)
            for profile_id, profile in profiles.items()
            if profile.get("backend", "claude") in supported
        ]

    def _default_profile_for_node(self, node) -> tuple[str, dict] | None:
        """profile 미지정 create_session에서 사용할 노드 기본 profile."""
        compatible = self._compatible_profiles(node)
        if not compatible:
            return None
        return compatible[0]
