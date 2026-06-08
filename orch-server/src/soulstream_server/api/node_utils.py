"""
노드 검색 유틸리티 — 세션 ID로 노드를 찾는 공유 로직.

sessions.py와 execute_proxy.py가 공유한다.
"""

import logging

from fastapi import HTTPException

from soulstream_server.nodes.node_connection import NodeConnection

logger = logging.getLogger(__name__)


def is_node_resume_internal_error(message: str) -> bool:
    lowered = message.lower()
    return (
        "task hydration failed" in lowered
        or "task owned by another node" in lowered
    )


def node_resume_internal_error_detail(message: str) -> str:
    return f"Node could not resume existing session: {message}"


async def http_exception_for_node_resume_runtime_error(
    session_id: str,
    db,
    error: RuntimeError,
) -> HTTPException:
    message = str(error)
    if is_node_resume_internal_error(message):
        return HTTPException(
            status_code=503,
            detail=node_resume_internal_error_detail(message),
        )
    if "not found" in message.lower():
        session = await db.get_session(session_id)
        if session is None:
            return HTTPException(status_code=404, detail=message)
        return HTTPException(
            status_code=503,
            detail=f"Node could not resume existing session, please retry: {message}",
        )
    return HTTPException(status_code=422, detail=message)


async def find_session_node(session_id: str, db, node_manager) -> NodeConnection:
    """DB owner -> legacy active-node fallback으로 세션 노드를 찾는다.

    NodeManager는 DB를 알지 않으므로(설계 원칙 S1 지식 경계),
    DB owner 해석은 이미 db를 보유한 API 핸들러 계층에서 수행한다.

    Raises:
        HTTPException 404: 세션 노드를 찾을 수 없음
        HTTPException 503: 세션은 있으나 owner node가 연결되어 있지 않음
    """
    session_data = await db.get_session(session_id)
    if session_data:
        owner_node_id = session_data.get("node_id")
        if owner_node_id:
            node = node_manager.get_node(owner_node_id)
            if node:
                return node
            raise HTTPException(
                status_code=503,
                detail=f"Session owner node unavailable: {owner_node_id}",
            )

        # Legacy rows can lack node_id. In that case only, single-node fallback
        # is acceptable. DB-missing sessions never route through stale per-node
        # session dumps.
        active_nodes = node_manager.get_connected_nodes()
        if active_nodes:
            return active_nodes[0]

    raise HTTPException(status_code=404, detail="Session not found")
