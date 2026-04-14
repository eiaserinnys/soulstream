"""Tests for system_prompt propagation through soulstream-server.

Covers:
- CreateSessionRequest includes system_prompt in serialization
- route_create_session passes system_prompt to send_create_session
- send_create_session includes systemPrompt in WebSocket payload
"""

from unittest.mock import AsyncMock, MagicMock

import pytest

from soulstream_server.api.sessions import CreateSessionRequest
from soulstream_server.nodes.node_connection import NodeConnection
from soulstream_server.nodes.node_manager import NodeManager
from soulstream_server.service.session_router import SessionRouter


# ---------------------------------------------------------------------------
# CreateSessionRequest serialization
# ---------------------------------------------------------------------------

class TestCreateSessionRequestModel:
    def test_system_prompt_included_in_model_dump(self):
        """system_prompt가 있으면 model_dump(exclude_none=True)에 포함된다."""
        req = CreateSessionRequest(prompt="hello", system_prompt="You are an agent.")
        data = req.model_dump(exclude_none=True)
        assert "system_prompt" in data
        assert data["system_prompt"] == "You are an agent."

    def test_system_prompt_excluded_when_none(self):
        """system_prompt가 None이면 model_dump(exclude_none=True)에서 제외된다."""
        req = CreateSessionRequest(prompt="hello")
        data = req.model_dump(exclude_none=True)
        assert "system_prompt" not in data

    def test_system_prompt_default_is_none(self):
        """system_prompt의 기본값은 None이다."""
        req = CreateSessionRequest(prompt="hello")
        assert req.system_prompt is None


# ---------------------------------------------------------------------------
# SessionRouter — system_prompt 전달
# ---------------------------------------------------------------------------

class TestSessionRouterSystemPrompt:
    async def test_passes_system_prompt_to_node(self):
        """route_create_session이 system_prompt를 send_create_session에 전달한다."""
        manager = NodeManager()
        router = SessionRouter(manager)

        ws = AsyncMock()
        ws.send_json = AsyncMock()
        ws.close = AsyncMock()

        node = await manager.register_node(ws, {"node_id": "node-a"})

        # WebSocket send_json 호출 시 pending future를 즉시 resolve
        async def resolve_on_send(data):
            req_id = data.get("requestId")
            if req_id and req_id in node._pending:
                node._pending[req_id].set_result({"agentSessionId": "sess-x"})

        ws.send_json.side_effect = resolve_on_send

        await router.route_create_session({
            "prompt": "do something",
            "system_prompt": "You are a helper agent.",
        })

        # send_json이 호출된 페이로드 확인
        assert ws.send_json.called
        sent_payload = ws.send_json.call_args[0][0]
        assert sent_payload["systemPrompt"] == "You are a helper agent."

    async def test_no_system_prompt_key_when_absent(self):
        """system_prompt가 없으면 WebSocket 페이로드에 systemPrompt 키가 없어야 한다."""
        manager = NodeManager()
        router = SessionRouter(manager)

        ws = AsyncMock()
        ws.send_json = AsyncMock()
        ws.close = AsyncMock()

        node = await manager.register_node(ws, {"node_id": "node-b"})

        async def resolve_on_send(data):
            req_id = data.get("requestId")
            if req_id and req_id in node._pending:
                node._pending[req_id].set_result({"agentSessionId": "sess-y"})

        ws.send_json.side_effect = resolve_on_send

        await router.route_create_session({"prompt": "test"})

        sent_payload = ws.send_json.call_args[0][0]
        assert "systemPrompt" not in sent_payload


# ---------------------------------------------------------------------------
# NodeConnection.send_create_session — WebSocket 페이로드
# ---------------------------------------------------------------------------

class TestNodeConnectionSystemPrompt:
    async def test_system_prompt_included_in_payload(self):
        """system_prompt가 있으면 WebSocket 페이로드에 systemPrompt가 포함된다."""
        ws = AsyncMock()
        ws.send_json = AsyncMock()
        ws.close = AsyncMock()

        node = NodeConnection(ws=ws, node_id="test-node")

        # pending future를 즉시 resolve
        async def resolve_on_send(data):
            req_id = data.get("requestId")
            if req_id and req_id in node._pending:
                node._pending[req_id].set_result({"agentSessionId": "s1"})

        ws.send_json.side_effect = resolve_on_send

        await node.send_create_session(
            prompt="hello",
            system_prompt="System instructions here.",
        )

        sent = ws.send_json.call_args[0][0]
        assert sent["systemPrompt"] == "System instructions here."

    async def test_system_prompt_absent_when_none(self):
        """system_prompt=None이면 WebSocket 페이로드에 systemPrompt 키가 없어야 한다."""
        ws = AsyncMock()
        ws.send_json = AsyncMock()
        ws.close = AsyncMock()

        node = NodeConnection(ws=ws, node_id="test-node")

        async def resolve_on_send(data):
            req_id = data.get("requestId")
            if req_id and req_id in node._pending:
                node._pending[req_id].set_result({"agentSessionId": "s2"})

        ws.send_json.side_effect = resolve_on_send

        await node.send_create_session(prompt="hello")

        sent = ws.send_json.call_args[0][0]
        assert "systemPrompt" not in sent
