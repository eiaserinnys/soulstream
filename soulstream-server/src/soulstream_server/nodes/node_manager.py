"""
NodeManager — 연결된 soul-server 노드 관리.
"""

import base64
import logging
from typing import Any, Callable, Coroutine

import httpx
from fastapi import WebSocket

from soulstream_server.nodes.node_connection import NodeConnection

logger = logging.getLogger(__name__)

ChangeListener = Callable[[str, str, dict | None], Coroutine[Any, Any, None]]
# (event_type, node_id, data)


class NodeManager:
    """연결된 모든 soul-server 노드를 추적."""

    def __init__(self) -> None:
        self._nodes: dict[str, NodeConnection] = {}
        self._change_listeners: list[ChangeListener] = []

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
        capabilities = registration.get("capabilities", [])

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
            on_close=self._on_node_close,
            on_session_change=self._on_session_change,
        )
        self._nodes[node_id] = node

        logger.info(
            "Node registered: %s (host=%s, port=%d, capabilities=%s)",
            node_id, host, port, capabilities,
        )

        # 에이전트 정보: 등록 메시지에 포함된 경우 우선 사용, 없으면 HTTP 조회
        agents_from_registration = registration.get("agents")
        if agents_from_registration is not None:
            profiles = {}
            portrait_cache: dict[str, bytes] = {}
            for a in agents_from_registration:
                agent_id = a["id"]
                profiles[agent_id] = {
                    "id": agent_id,
                    "name": a.get("name", ""),
                    "portrait_url": a.get("portrait_url", ""),
                    "max_turns": a.get("max_turns"),
                }
                if a.get("portrait_b64"):
                    try:
                        portrait_cache[agent_id] = base64.b64decode(a["portrait_b64"])
                    except Exception:
                        logger.warning("portrait_b64 디코딩 실패 (agent=%s)", agent_id)
            node.set_agent_data(profiles, portrait_cache)
            logger.info(
                "에이전트 프로필 등록 메시지에서 로드: node=%s, count=%d",
                node_id, len(profiles),
            )
        else:
            await self._fetch_agent_profiles(node, host, port)

        await self._emit_change("node_registered", node_id, node.to_info())
        return node

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
        await self._emit_change(f"node_session_{change_type}", node_id, data)

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
