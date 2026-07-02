"""
NodeManager — 연결된 soul-server 노드 관리.
"""

import base64
import logging
from typing import Any, Callable, Coroutine

import httpx
from fastapi import WebSocket

from soulstream_server.nodes.node_connection import NodeConnection
from soulstream_server.service.supervisor_ingest import SupervisorIngestService

logger = logging.getLogger(__name__)

ChangeListener = Callable[[str, str, dict | None], Coroutine[Any, Any, None]]
# (event_type, node_id, data)


class AmbiguousAgentProfile(Exception):
    """agent_id가 여러 노드에 있어 nodeId 없는 라우팅이 모호한 경우."""

    def __init__(self, agent_id: str, node_ids: list[str]) -> None:
        super().__init__(
            f"Ambiguous agent profile '{agent_id}' registered on nodes: {node_ids}"
        )
        self.agent_id = agent_id
        self.node_ids = node_ids


class NodeManager:
    """연결된 모든 soul-server 노드를 추적."""

    def __init__(
        self,
        *,
        default_user_email: str = "",
        supervisor_ingest: SupervisorIngestService | None = None,
    ) -> None:
        self._nodes: dict[str, NodeConnection] = {}
        self._change_listeners: list[ChangeListener] = []
        self._supervisor_ingest = supervisor_ingest
        # 빌드 20: soul-server `/api/dashboard/config` 응답에 email 필드가 없어
        # PushNotifier가 user_email로 push_tokens를 조회 못 하는 케이스 fallback.
        # single-user 시스템(allowed_email로 한 명만 OAuth 통과)에서는 이 fallback이
        # 정확하다. 멀티유저 환경 도입 시 soul-server에 dash_user_email 필드 추가
        # (atom: project > soulstream > TODO 등록).
        self._default_user_email = default_user_email

    def add_change_listener(self, listener: ChangeListener) -> None:
        self._change_listeners.append(listener)

    def remove_change_listener(self, listener: ChangeListener) -> None:
        try:
            self._change_listeners.remove(listener)
        except ValueError:
            pass

    async def _emit_change(
        self, event_type: str, node_id: str, data: dict | None = None
    ) -> None:
        for listener in list(self._change_listeners):
            try:
                await listener(event_type, node_id, data)
            except Exception:
                logger.exception("Error in change listener")

    async def register_node(
        self, ws: WebSocket, registration: dict
    ) -> NodeConnection:
        node_id = registration["node_id"]
        host = registration.get("host", "")
        port = registration.get("port", 0)
        # 옵션 D Phase A: capabilities default를 dict {}로 변경 (NodeConnection 시그니처 타입 정정과 정합).
        capabilities = registration.get("capabilities") or {}
        # 옵션 D Phase A: 노드가 광고한 supported_backends 추출. 미명시 시 ["claude"] (후방호환).
        # []는 "실행 가능 backend 없음"의 명시적 광고이므로 legacy default로 덮지 않는다.
        supported_backends = (
            registration["supported_backends"]
            if registration.get("supported_backends") is not None
            else ["claude"]
        )
        agents_from_registration = registration.get("agents")
        self._validate_agent_backends(node_id, supported_backends, agents_from_registration)

        # 기존 연결이 있으면 닫기
        existing = self._nodes.get(node_id)
        if existing:
            logger.warning("Node %s already connected, closing old connection", node_id)
            await existing.close()

        node = NodeConnection(
            ws=ws,
            node_id=node_id,
            host=host,
            port=port,
            capabilities=capabilities,
            supported_backends=supported_backends,
            on_close=self._on_node_close,
            on_session_change=self._on_session_change,
            on_event_ingest=self._on_supervisor_event_ingest,
        )
        self._nodes[node_id] = node

        logger.info(
            "Node registered: %s (host=%s, port=%d, capabilities=%s, backends=%s)",
            node_id, host, port, capabilities, supported_backends,
        )

        # 에이전트 정보: 등록 메시지에 포함된 경우 우선 사용, 없으면 HTTP 조회
        if agents_from_registration is not None:
            profiles, portrait_cache = self._agent_data_from_registration(
                agents_from_registration
            )
            node.set_agent_data(profiles, portrait_cache)
            logger.info(
                "에이전트 프로필 등록 메시지에서 로드: node=%s, count=%d",
                node_id, len(profiles),
            )
        else:
            await self._fetch_agent_profiles(node, host, port)

        # 사용자 정보: 등록 메시지에 포함된 경우 우선 사용 (에이전트 프로필과 동일 패턴)
        user_info = registration.get("user", {})
        if user_info:
            node.set_user_info(self._with_email_fallback(user_info))
            logger.info(
                "사용자 정보 등록 메시지에서 로드: node=%s, name=%s",
                node_id, user_info.get("name"),
            )
        else:
            # HTTP 폴백: 구 버전 soul-server 호환 또는 메시지에 user 없는 경우
            await self._fetch_user_info(node, host, port)

        await self._sync_supervisor_sessions(node_id, registration.get("sessions"))
        await self._emit_change("node_registered", node_id, node.to_info())
        return node

    async def refresh_node_registration(
        self, node_id: str, registration: dict
    ) -> None:
        """연결 유지 중 재수신한 node_register payload로 노드 catalog를 갱신한다."""
        node = self._nodes.get(node_id)
        if node is None:
            logger.warning("node_register 재공지 대상 노드 없음: %s", node_id)
            return

        incoming_node_id = registration.get("node_id")
        if incoming_node_id and incoming_node_id != node_id:
            logger.warning(
                "node_register 재공지 node_id 불일치: current=%s incoming=%s",
                node_id,
                incoming_node_id,
            )
            return

        if "host" in registration:
            node.host = registration.get("host", "")
        if "port" in registration:
            node.port = registration.get("port", 0)
        if "capabilities" in registration:
            node.capabilities = registration.get("capabilities") or {}

        if "supported_backends" in registration:
            supported_backends = (
                registration["supported_backends"]
                if registration.get("supported_backends") is not None
                else ["claude"]
            )
            node.supported_backends = supported_backends
        else:
            supported_backends = node.supported_backends

        agents_from_registration = registration.get("agents")
        self._validate_agent_backends(node_id, supported_backends, agents_from_registration)
        if agents_from_registration is not None:
            profiles, portrait_cache = self._agent_data_from_registration(
                agents_from_registration
            )
            node.set_agent_data(profiles, portrait_cache)
        else:
            profiles = node.agent_profiles

        user_info = registration.get("user", {})
        if user_info:
            node.set_user_info(self._with_email_fallback(user_info))

        logger.info(
            "노드 등록 재공지 반영: node=%s, agents=%d, backends=%s",
            node_id,
            len(profiles),
            node.supported_backends,
        )
        await self._emit_change("node_updated", node_id, node.to_info())

    @staticmethod
    def _agent_data_from_registration(
        agents_from_registration: list[dict],
    ) -> tuple[dict, dict[str, bytes]]:
        profiles = {}
        portrait_cache: dict[str, bytes] = {}
        for a in agents_from_registration:
            agent_id = a["id"]
            profiles[agent_id] = {
                "id": agent_id,
                "name": a.get("name", ""),
                "portrait_url": a.get("portrait_url", ""),
                "max_turns": a.get("max_turns"),
                # 옵션 D Phase A: agent의 백엔드 ("claude" | "codex" 등). SessionRouter._resolve_backend가 조회.
                "backend": a.get("backend", "claude"),
            }
            if a.get("portrait_b64"):
                try:
                    portrait_cache[agent_id] = base64.b64decode(a["portrait_b64"])
                except Exception:
                    logger.warning("portrait_b64 디코딩 실패 (agent=%s)", agent_id)
        return profiles, portrait_cache

    async def _fetch_user_info(self, node: "NodeConnection", host: str, port: int) -> None:
        """soul-server /api/dashboard/config에서 사용자 정보 조회.
        실패 시 빈 dict로 graceful degradation.
        """
        try:
            async with httpx.AsyncClient(timeout=3.0) as http:
                resp = await http.get(f"http://{host}:{port}/api/dashboard/config")
                data = resp.json()
                user_info = data.get("user", {})
        except Exception:
            logger.warning("사용자 정보 조회 실패 (node=%s), 빈 정보로 진행", node.node_id)
            user_info = {}
        node.set_user_info(self._with_email_fallback(user_info))

    def _with_email_fallback(self, user_info: dict) -> dict:
        """user_info에 email이 없으면 default_user_email(allowed_email)로 보충.

        single-user 시스템(allowed_email로 한 명만 OAuth 통과)에서 PushNotifier가
        push_tokens 조회 키로 email을 쓰는데, soul-server `/api/dashboard/config`
        응답이 email을 포함하지 않아 매칭 실패하는 문제(빌드 20 보고)를 우회.

        멀티유저 환경 전환 시 soul-server에 dash_user_email 필드 추가가 정공법.
        """
        if not self._default_user_email:
            return user_info
        if user_info.get("email"):
            return user_info
        # 원본 dict 미변형 — 새 dict 반환 (호출자가 원본을 다른 곳에서 참조할 수 있음)
        return {**user_info, "email": self._default_user_email}

    async def _fetch_agent_profiles(self, node: "NodeConnection", host: str, port: int) -> None:
        """soul-server /api/agents에서 에이전트 프로필 조회.
        실패 시 빈 목록으로 graceful degradation.
        """
        try:
            async with httpx.AsyncClient(timeout=3.0) as http:
                resp = await http.get(f"http://{host}:{port}/api/agents")
                data = resp.json()
                profiles = {p["id"]: p for p in data.get("agents", [])}
        except Exception:
            logger.warning("에이전트 프로필 조회 실패 (node=%s), 빈 목록으로 진행", node.node_id)
            profiles = {}
        node.set_agent_data(profiles, {})

    async def _on_node_close(self, node: NodeConnection) -> None:
        # 이 노드가 아직 등록된 노드와 동일한 경우에만 제거한다.
        # soul-server 재연결 시 register_node()가 기존 노드를 close()하는데,
        # 기존 ws_handler의 finally 블록이 뒤늦게 같은 close()를 다시 호출하면
        # _nodes[node_id]가 이미 새 노드로 교체된 상태다. identity 비교로 오제거를 막는다.
        if self._nodes.get(node.node_id) is node:
            self._nodes.pop(node.node_id, None)
            logger.info("Node disconnected: %s", node.node_id)
            await self._emit_change("node_unregistered", node.node_id)
        else:
            logger.debug(
                "Node %s close() called but already replaced — skipping unregister",
                node.node_id,
            )

    async def _on_session_change(
        self, node_id: str, change_type: str, data: dict | None
    ) -> None:
        if change_type == "sessions_update":
            await self._sync_supervisor_sessions(node_id, (data or {}).get("sessions"))
        await self._emit_change(f"node_session_{change_type}", node_id, data)

    async def _on_supervisor_event_ingest(self, node_id: str, data: dict) -> None:
        if self._supervisor_ingest is None:
            return
        await self._supervisor_ingest.append_event_envelope(node_id, data)

    async def _sync_supervisor_sessions(self, node_id: str, sessions: Any) -> None:
        if self._supervisor_ingest is None or not isinstance(sessions, list):
            return
        await self._supervisor_ingest.sync_sessions_from_dump(node_id, sessions)

    def unregister_node(self, node_id: str) -> None:
        self._nodes.pop(node_id, None)

    def get_node(self, node_id: str) -> NodeConnection | None:
        return self._nodes.get(node_id)

    def get_nodes(self) -> list[dict]:
        return [node.to_info() for node in self._nodes.values()]

    def get_connected_nodes(self) -> list[NodeConnection]:
        return list(self._nodes.values())

    def find_node_for_session(self, session_id: str) -> NodeConnection | None:
        for node in self._nodes.values():
            if session_id in node.sessions:
                return node
        return None

    def resolve_agent_profile_for_routing(
        self, agent_id: str, preferred_node_id: str | None = None
    ) -> tuple[dict, str] | None:
        """세션 라우팅용 agent profile 조회.

        preferred_node_id가 있으면 해당 노드의 profile만 본다. nodeId 없이 같은 agent_id가
        여러 노드에 있으면 임의 first-match를 금지하고 AmbiguousAgentProfile을 던져
        호출자가 409로 노출하게 한다.
        """
        if preferred_node_id:
            node = self._nodes.get(preferred_node_id)
            if node and agent_id in node.agent_profiles:
                return node.agent_profiles[agent_id], preferred_node_id
            return None

        matches: list[tuple[str, dict]] = []
        for node_id, node in self._nodes.items():
            if agent_id in node.agent_profiles:
                matches.append((node_id, node.agent_profiles[agent_id]))

        if not matches:
            return None
        if len(matches) > 1:
            raise AmbiguousAgentProfile(agent_id, [node_id for node_id, _ in matches])
        node_id, profile = matches[0]
        return profile, node_id

    @staticmethod
    def _validate_agent_backends(
        node_id: str,
        supported_backends: list[str],
        agents_from_registration: list[dict] | None,
    ) -> None:
        """agents[].backend이 node.supported_backends와 모순되면 등록을 거부한다."""
        if agents_from_registration is None:
            return
        unsupported: list[tuple[str, str]] = []
        for agent in agents_from_registration:
            backend = agent.get("backend", "claude")
            if backend not in supported_backends:
                unsupported.append((agent.get("id", "<missing-id>"), backend))
        if unsupported:
            raise ValueError(
                "unsupported agent backend in node registration "
                f"(node={node_id}, supported_backends={supported_backends}, "
                f"agents={unsupported})"
            )

    def get_user_info(self, node_id: str) -> dict:
        """node_id에 연결된 사용자 정보를 반환. 없으면 빈 dict."""
        node = self._nodes.get(node_id)
        return node.user_info if node else {}

    def find_agent_profile(
        self, agent_id: str, preferred_node_id: str | None = None
    ) -> tuple[dict, str] | None:
        """어느 노드에서든 agent_id의 프로필을 찾아서 (profile, source_node_id) 반환.

        preferred_node_id의 노드를 먼저 시도한다.
        원격 노드에 agent_profiles가 비어있는 경우 다른 노드로 폴백한다.
        """
        if preferred_node_id:
            node = self._nodes.get(preferred_node_id)
            if node and agent_id in node.agent_profiles:
                return node.agent_profiles[agent_id], preferred_node_id

        for node_id, node in self._nodes.items():
            if agent_id in node.agent_profiles:
                return node.agent_profiles[agent_id], node_id

        return None
