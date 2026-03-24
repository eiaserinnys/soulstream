"""
WebSocket 엔드포인트 핸들러 — /ws/node

soul-server 노드의 등록 및 메시지 수신 루프.
"""

import asyncio
import json
import logging

from fastapi import WebSocket, WebSocketDisconnect

from soulstream_server.constants import (
    EVT_NODE_REGISTER,
    REGISTRATION_TIMEOUT,
    WS_CLOSE_INVALID_FIRST_MSG,
    WS_CLOSE_INVALID_JSON,
    WS_CLOSE_NODE_ID_REQUIRED,
    WS_CLOSE_REGISTRATION_TIMEOUT,
)
from soulstream_server.nodes.node_manager import NodeManager

logger = logging.getLogger(__name__)


async def handle_node_ws(ws: WebSocket, node_manager: NodeManager) -> None:
    """soul-server 노드의 WebSocket 연결을 처리한다.

    1. 연결 수락
    2. 10초 이내에 node_register 메시지 대기
    3. 등록 성공 후 메시지 수신 루프
    """
    await ws.accept()

    # 등록 대기
    try:
        raw = await asyncio.wait_for(ws.receive_text(), timeout=REGISTRATION_TIMEOUT)
    except asyncio.TimeoutError:
        logger.warning("Node registration timeout")
        await ws.close(code=WS_CLOSE_REGISTRATION_TIMEOUT, reason="Registration timeout")
        return

    try:
        data = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        logger.warning("Invalid JSON in registration message")
        await ws.close(code=WS_CLOSE_INVALID_JSON, reason="Invalid JSON")
        return

    if data.get("type") != EVT_NODE_REGISTER:
        logger.warning("First message is not node_register: %s", data.get("type"))
        await ws.close(
            code=WS_CLOSE_INVALID_FIRST_MSG,
            reason=f"Expected {EVT_NODE_REGISTER}, got {data.get('type')}",
        )
        return

    node_id = data.get("nodeId")
    if not node_id:
        logger.warning("node_register missing nodeId")
        await ws.close(code=WS_CLOSE_NODE_ID_REQUIRED, reason="nodeId required")
        return

    # 등록
    node = await node_manager.register_node(ws, data)

    # 메시지 수신 루프
    try:
        while True:
            raw = await ws.receive_text()
            try:
                msg = json.loads(raw)
            except (json.JSONDecodeError, TypeError):
                logger.warning("Invalid JSON from node %s", node_id)
                continue
            await node.handle_message(msg)
    except WebSocketDisconnect:
        logger.info("Node %s disconnected", node_id)
    except Exception:
        logger.exception("Error in node %s message loop", node_id)
    finally:
        await node.close()
