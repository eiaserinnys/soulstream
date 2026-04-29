"""
노드 검색 유틸리티 — 세션 ID로 노드를 찾는 공유 로직.

sessions.py와 execute_proxy.py가 공유한다.
"""

import logging

from fastapi import HTTPException

from soulstream_server.nodes.node_connection import NodeConnection

logger = logging.getLogger(__name__)


async def find_session_node(session_id: str, db, node_manager) -> NodeConnection:
    """인메모리 -> DB -> 활성 노드 폴백으로 세션의 노드를 찾는다.

    NodeManager는 DB를 알지 않으므로(설계 원칙 S1 지식 경계),
    DB 폴백은 이미 db를 보유한 API 핸들러 계층에서 수행한다.

    Raises:
        HTTPException 404: 세션 노드를 찾을 수 없음
    """
    node = node_manager.find_node_for_session(session_id)
    if not node:
        session_data = await db.get_session(session_id)
        if session_data and session_data.get("node_id"):
            node = node_manager.get_node(session_data["node_id"])
    if not node:
        # node_id가 stale하거나 노드가 재연결된 경우 (예: soul-server 재시작 3초 공백)
        # — 활성 노드 중 첫 번째를 폴백으로 사용한다.
        # soul-server는 단일 노드 구성이므로 활성 노드가 있으면 그것이 정답이다.
        active_nodes = node_manager.get_connected_nodes()
        if active_nodes:
            node = active_nodes[0]
    if not node:
        raise HTTPException(status_code=404, detail="Session not found")
    return node
