"""
WebSocket 엔드포인트 핸들러 — /ws/node

soul-server 노드의 등록 및 메시지 수신 루프.
"""

import asyncio
import json
import logging
import secrets

from fastapi import WebSocket, WebSocketDisconnect

from soulstream_server.config import get_settings
from soulstream_server.constants import (
    EVT_NODE_REGISTER,
    REGISTRATION_TIMEOUT,
    WS_CLOSE_AUTH_INVALID,
    WS_CLOSE_AUTH_REQUIRED,
    WS_CLOSE_CONFIG_ERROR,
    WS_CLOSE_INVALID_FIRST_MSG,
    WS_CLOSE_INVALID_JSON,
    WS_CLOSE_NODE_ID_REQUIRED,
    WS_CLOSE_REGISTRATION_TIMEOUT,
)
from soulstream_server.nodes.node_manager import NodeManager

logger = logging.getLogger(__name__)


async def _node_message_loop(ws: WebSocket, node_id: str, node) -> None:
    while True:
        raw = await ws.receive_text()
        try:
            msg = json.loads(raw)
        except (json.JSONDecodeError, TypeError):
            logger.warning("Invalid JSON from node %s", node_id)
            continue
        await node.handle_message(msg)


async def handle_node_ws(ws: WebSocket, node_manager: NodeManager) -> None:
    """soul-server 노드의 WebSocket 연결을 처리한다.

    1. Authorization 헤더 검증 (accept 전)
    2. 연결 수락
    3. 10초 이내에 node_register 메시지 대기
    4. 등록 성공 후 메시지 수신 루프
    """
    settings = get_settings()
    configured_token = settings.auth_bearer_token

    # ── 인증 검사 (accept 전) ──
    # Starlette는 accept 전에 ws.close(code)가 호출되면 ASGI websocket.close 메시지만
    # 내보내고 핸드셰이크를 완료하지 않는다. 클라이언트(aiohttp)는 이를
    # WSServerHandshakeError로 수신한다.
    if not configured_token:
        if settings.is_production:
            logger.error("AUTH_BEARER_TOKEN not configured in production")
            await ws.close(code=WS_CLOSE_CONFIG_ERROR, reason="server misconfigured")
            return
        # 개발 모드: 토큰 미설정 시 인증 우회
    else:
        auth_header = ws.headers.get("authorization", "")
        parts = auth_header.split()
        if len(parts) != 2 or parts[0].lower() != "bearer":
            logger.warning("/ws/node: missing or malformed Authorization header")
            await ws.close(code=WS_CLOSE_AUTH_REQUIRED, reason="auth required")
            return
        if not secrets.compare_digest(parts[1], configured_token):
            logger.warning("/ws/node: invalid token")
            await ws.close(code=WS_CLOSE_AUTH_INVALID, reason="invalid token")
            return

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

    node_id = data.get("node_id")
    if not node_id:
        logger.warning("node_register missing node_id")
        await ws.close(code=WS_CLOSE_NODE_ID_REQUIRED, reason="node_id required")
        return

    # 등록
    node = await node_manager.register_node(ws, data)

    tasks: set[asyncio.Task] = {
        asyncio.create_task(_node_message_loop(ws, node_id, node)),
    }
    if node.supports_app_heartbeat:
        tasks.add(asyncio.create_task(node.run_heartbeat()))

    try:
        done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for task in done:
            task.result()
        for task in pending:
            task.cancel()
        if pending:
            await asyncio.gather(*pending, return_exceptions=True)
    except WebSocketDisconnect:
        logger.info("Node %s disconnected", node_id)
    except Exception:
        logger.exception("Error in node %s message loop", node_id)
    finally:
        for task in tasks:
            if not task.done():
                task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        await node.close()
