"""Tests for WebSocket handler (handle_node_ws)."""

import asyncio
import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from soulstream_server.constants import (
    EVT_APP_HEARTBEAT_PING,
    EVT_NODE_REGISTER,
    WS_CLOSE_INVALID_FIRST_MSG,
    WS_CLOSE_NODE_ID_REQUIRED,
    WS_CLOSE_REGISTRATION_TIMEOUT,
)
from soulstream_server.nodes.node_manager import NodeManager
from soulstream_server.nodes.ws_handler import handle_node_ws
from tests.conftest import TEST_AUTH_TOKEN


@pytest.fixture
def ws():
    mock = AsyncMock()
    mock.accept = AsyncMock()
    mock.close = AsyncMock()
    mock.receive_text = AsyncMock()
    mock.send_json = AsyncMock()
    # handle_node_ws가 accept 전 Authorization 헤더를 검증하므로
    # 유효한 Bearer 토큰을 주입하여 기존 시나리오(등록 흐름)가 통과하도록 한다.
    mock.headers = {"authorization": f"Bearer {TEST_AUTH_TOKEN}"}
    return mock


@pytest.fixture
def manager():
    return NodeManager()


class TestRegistrationFlow:
    """WebSocket registration tests."""

    async def test_valid_registration(self, ws, manager):
        """Valid registration message registers the node and enters message loop."""
        from fastapi import WebSocketDisconnect

        # First call: registration message; second call: disconnect
        ws.receive_text.side_effect = [
            json.dumps({
                "type": EVT_NODE_REGISTER,
                "node_id": "test-node",
                "host": "localhost",
                "port": 4100,
            }),
            WebSocketDisconnect(1000),
        ]

        await handle_node_ws(ws, manager)

        ws.accept.assert_called_once()
        # Node was registered (and then unregistered on close)
        # After the handler completes, node.close() is called in finally block

    async def test_timeout_closes_with_4001(self, ws, manager):
        """Registration timeout closes WebSocket with code 4001."""
        ws.receive_text.side_effect = asyncio.TimeoutError()

        await handle_node_ws(ws, manager)

        ws.close.assert_called_once()
        _, kwargs = ws.close.call_args
        assert kwargs.get("code") == WS_CLOSE_REGISTRATION_TIMEOUT

    async def test_missing_node_id_closes_with_4002(self, ws, manager):
        """Registration without nodeId closes with code 4002."""
        ws.receive_text.return_value = json.dumps({
            "type": EVT_NODE_REGISTER,
            # nodeId missing
        })

        await handle_node_ws(ws, manager)

        args, kwargs = ws.close.call_args
        close_code = kwargs.get("code", args[0] if args else None)
        assert close_code == WS_CLOSE_NODE_ID_REQUIRED

    async def test_wrong_first_message_closes_with_4003(self, ws, manager):
        """Non-register first message closes with code 4003."""
        ws.receive_text.return_value = json.dumps({
            "type": "some_other_type",
            "nodeId": "test-node",
        })

        await handle_node_ws(ws, manager)

        args, kwargs = ws.close.call_args
        close_code = kwargs.get("code", args[0] if args else None)
        assert close_code == WS_CLOSE_INVALID_FIRST_MSG

    async def test_invalid_json_closes_with_4004(self, ws, manager):
        """Invalid JSON in registration closes with code 4004."""
        ws.receive_text.return_value = "not valid json {{{"

        await handle_node_ws(ws, manager)

        args, kwargs = ws.close.call_args
        close_code = kwargs.get("code", args[0] if args else None)
        assert close_code == 4004  # WS_CLOSE_INVALID_JSON


class TestMessageLoop:
    """Post-registration message loop tests."""

    async def test_message_loop_handles_messages(self, ws, manager):
        """After registration, messages are passed to node.handle_message."""
        from fastapi import WebSocketDisconnect

        event_msg = json.dumps({
            "type": "sessions_update",
            "sessions": [{"agentSessionId": "s1"}],
        })

        ws.receive_text.side_effect = [
            json.dumps({
                "type": EVT_NODE_REGISTER,
                "node_id": "msg-node",
            }),
            event_msg,
            WebSocketDisconnect(1000),
        ]

        await handle_node_ws(ws, manager)

        # The handler processed messages without error

    async def test_message_loop_routes_node_register_reannounce_to_manager(self, ws, manager):
        """등록 이후 node_register 재수신은 node catalog refresh로 라우팅된다."""
        from fastapi import WebSocketDisconnect

        reannounce = {
            "type": EVT_NODE_REGISTER,
            "node_id": "msg-node",
            "agents": [{"id": "new-agent", "name": "New Agent", "backend": "codex"}],
            "supported_backends": ["codex"],
        }
        manager.refresh_node_registration = AsyncMock(
            wraps=manager.refresh_node_registration
        )

        ws.receive_text.side_effect = [
            json.dumps({
                "type": EVT_NODE_REGISTER,
                "node_id": "msg-node",
            }),
            json.dumps(reannounce),
            WebSocketDisconnect(1000),
        ]

        await handle_node_ws(ws, manager)

        manager.refresh_node_registration.assert_awaited_once_with(
            "msg-node",
            reannounce,
        )

    async def test_invalid_json_in_loop_is_skipped(self, ws, manager):
        """Invalid JSON during message loop is skipped, not fatal."""
        from fastapi import WebSocketDisconnect

        ws.receive_text.side_effect = [
            json.dumps({
                "type": EVT_NODE_REGISTER,
                "node_id": "skip-node",
            }),
            "invalid json!!!",
            WebSocketDisconnect(1000),
        ]

        await handle_node_ws(ws, manager)
        # Should complete without error

    async def test_heartbeat_capable_node_timeout_closes_connection(self, ws, manager):
        """Heartbeat-capable nodes are closed when no app heartbeat pong arrives."""
        first = True

        async def receive_text():
            nonlocal first
            if first:
                first = False
                return json.dumps({
                    "type": EVT_NODE_REGISTER,
                    "node_id": "heartbeat-node",
                    "capabilities": {"app_heartbeat_v1": True},
                })
            await asyncio.Future()

        ws.receive_text.side_effect = receive_text

        with patch("soulstream_server.nodes.node_connection.APP_HEARTBEAT_INTERVAL", 0.01):
            with patch("soulstream_server.nodes.node_connection.APP_HEARTBEAT_MAX_MISSED", 1):
                await asyncio.wait_for(handle_node_ws(ws, manager), timeout=0.2)

        sent_types = [
            call.args[0].get("type")
            for call in ws.send_json.call_args_list
            if call.args and isinstance(call.args[0], dict)
        ]
        assert EVT_APP_HEARTBEAT_PING in sent_types
        ws.close.assert_called()

    async def test_legacy_node_without_capability_is_not_heartbeat_closed(self, ws, manager):
        """Legacy nodes keep the old receive-loop behavior and are not false-disconnected."""
        from fastapi import WebSocketDisconnect

        ws.receive_text.side_effect = [
            json.dumps({
                "type": EVT_NODE_REGISTER,
                "node_id": "legacy-node",
                "capabilities": {},
            }),
            WebSocketDisconnect(1000),
        ]

        with patch("soulstream_server.nodes.node_connection.APP_HEARTBEAT_INTERVAL", 0.01):
            with patch("soulstream_server.nodes.node_connection.APP_HEARTBEAT_MAX_MISSED", 1):
                await handle_node_ws(ws, manager)

        sent_types = [
            call.args[0].get("type")
            for call in ws.send_json.call_args_list
            if call.args and isinstance(call.args[0], dict)
        ]
        assert EVT_APP_HEARTBEAT_PING not in sent_types
