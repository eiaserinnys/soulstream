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
        HTTPException 503: 세션은 있으나 owner node가 연결되어 있지 않음
    """
    session_data = None
    node = node_manager.find_node_for_session(session_id)
    if not node:
        session_data = await db.get_session(session_id)
        if session_data and session_data.get("node_id"):
            node = node_manager.get_node(session_data["node_id"])
            if not node:
                raise HTTPException(
                    status_code=503,
                    detail=f"Session owner node unavailable: {session_data['node_id']}",
                )
    if not node:
        # Legacy rows can lack node_id. In that case only, single-node fallback is
        # acceptable. A row with an explicit owner node must not be routed to an
        # arbitrary active node.
        active_nodes = node_manager.get_connected_nodes()
        if active_nodes:
            node = active_nodes[0]
    if not node:
        raise HTTPException(status_code=404, detail="Session not found")
    return node
