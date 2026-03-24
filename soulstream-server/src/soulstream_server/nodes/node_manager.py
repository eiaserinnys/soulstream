"""
NodeManager — 연결된 soul-server 노드 관리.
"""

import logging
from typing import Any, Callable, Coroutine

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
        node_id = registration["nodeId"]
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
        await self._emit_change("node_registered", node_id, node.to_info())
        return node

    async def _on_node_close(self, node: NodeConnection) -> None:
        self._nodes.pop(node.node_id, None)
        logger.info("Node disconnected: %s", node.node_id)
        await self._emit_change("node_unregistered", node.node_id)

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
