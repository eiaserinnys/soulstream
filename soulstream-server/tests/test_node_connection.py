"""Tests for NodeConnection message handling and command sending."""

import asyncio
from unittest.mock import AsyncMock, MagicMock

import pytest

from soulstream_server.constants import (
    CMD_CREATE_SESSION,
    CMD_INTERVENE,
    CMD_SUBSCRIBE_EVENTS,
    EVT_ERROR,
    EVT_EVENT,
    EVT_SESSION_CREATED,
    EVT_SESSION_DELETED,
    EVT_SESSION_UPDATED,
    EVT_SESSIONS_UPDATE,
)
from soulstream_server.nodes.node_connection import NodeConnection


@pytest.fixture
def ws():
    mock = AsyncMock()
    mock.send_json = AsyncMock()
    mock.close = AsyncMock()
    return mock


@pytest.fixture
def node(ws):
    return NodeConnection(
        ws=ws,
        node_id="node-1",
        host="localhost",
        port=4100,
    )


class TestHandleMessage:
    """handle_message dispatching tests."""

    async def test_session_created_resolves_pending_future(self, node):
        """session_created with matching requestId resolves the pending future."""
        loop = asyncio.get_running_loop()
        future = loop.create_future()
        node._pending["req-1-1000"] = future

        await node.handle_message({
            "type": EVT_SESSION_CREATED,
            "requestId": "req-1-1000",
            "agentSessionId": "sess-abc",
            "status": "running",
        })

        assert future.done()
        result = future.result()
        assert result["agentSessionId"] == "sess-abc"

    async def test_error_rejects_pending_future(self, node):
        """error message with matching requestId sets exception on the future."""
        loop = asyncio.get_running_loop()
        future = loop.create_future()
        node._pending["req-2-2000"] = future

        await node.handle_message({
            "type": EVT_ERROR,
            "requestId": "req-2-2000",
            "message": "Something went wrong",
        })

        assert future.done()
        with pytest.raises(RuntimeError, match="Something went wrong"):
            future.result()

    async def test_event_dispatches_to_subscribe_listeners(self, node):
        """event message dispatches to registered subscribe listeners."""
        received = []

        async def callback(data):
            received.append(data)

        node._subscribe_listeners["sess-1"] = {"sub-1": callback}

        await node.handle_message({
            "type": EVT_EVENT,
            "agentSessionId": "sess-1",
            "subscribeId": "sub-1",
            "payload": {"text": "hello"},
        })

        assert len(received) == 1
        assert received[0]["payload"]["text"] == "hello"

    async def test_event_broadcasts_to_all_listeners_without_subscribe_id(self, node):
        """event without subscribeId broadcasts to all listeners for that session."""
        results_a = []
        results_b = []

        async def cb_a(data):
            results_a.append(data)

        async def cb_b(data):
            results_b.append(data)

        node._subscribe_listeners["sess-2"] = {"sub-a": cb_a, "sub-b": cb_b}

        await node.handle_message({
            "type": EVT_EVENT,
            "agentSessionId": "sess-2",
            "payload": {"text": "broadcast"},
        })

        assert len(results_a) == 1
        assert len(results_b) == 1

    async def test_sessions_update_replaces_sessions_map(self, node):
        """sessions_update replaces the entire sessions map."""
        node._sessions["old-sess"] = {"agentSessionId": "old-sess"}

        await node.handle_message({
            "type": EVT_SESSIONS_UPDATE,
            "sessions": [
                {"agentSessionId": "new-1", "status": "idle"},
                {"agentSessionId": "new-2", "status": "running"},
            ],
        })

        assert "old-sess" not in node.sessions
        assert "new-1" in node.sessions
        assert "new-2" in node.sessions
        assert node.session_count == 2

    async def test_session_updated_updates_existing_session(self, node):
        """session_updated merges data into existing session entry."""
        node._sessions["sess-x"] = {"agentSessionId": "sess-x", "status": "running"}

        await node.handle_message({
            "type": EVT_SESSION_UPDATED,
            "agentSessionId": "sess-x",
            "status": "idle",
        })

        assert node.sessions["sess-x"]["status"] == "idle"

    async def test_session_deleted_removes_from_sessions(self, node):
        """session_deleted removes the session from the sessions map."""
        node._sessions["sess-del"] = {"agentSessionId": "sess-del"}

        await node.handle_message({
            "type": EVT_SESSION_DELETED,
            "agentSessionId": "sess-del",
        })

        assert "sess-del" not in node.sessions

    async def test_session_created_event_adds_to_sessions(self, node):
        """session_created event (without requestId) adds to sessions map."""
        await node.handle_message({
            "type": EVT_SESSION_CREATED,
            "agentSessionId": "sess-new",
            "status": "running",
        })

        assert "sess-new" in node.sessions
        assert node.sessions["sess-new"]["status"] == "running"


class TestCommandSending:
    """send_* method tests."""

    async def test_send_create_session_generates_request_id(self, node, ws):
        """send_create_session sends correct message with generated request_id."""
        # Set up auto-resolve for the pending future
        async def resolve_future(*args, **kwargs):
            data = args[0] if args else kwargs.get("data")
            req_id = data["requestId"]
            if req_id in node._pending:
                node._pending[req_id].set_result({"agentSessionId": "sess-result"})

        ws.send_json.side_effect = resolve_future

        result = await node.send_create_session(prompt="hello", session_id="sid-1")

        ws.send_json.assert_called_once()
        sent = ws.send_json.call_args[0][0]
        assert sent["type"] == CMD_CREATE_SESSION
        assert sent["prompt"] == "hello"
        assert sent["agentSessionId"] == "sid-1"
        assert sent["requestId"].startswith("req-")

    async def test_send_intervene_sends_correct_payload(self, node, ws):
        """send_intervene sends fire-and-forget style command."""
        async def resolve_future(*args, **kwargs):
            data = args[0] if args else kwargs.get("data")
            req_id = data["requestId"]
            if req_id in node._pending:
                node._pending[req_id].set_result({"ok": True})

        ws.send_json.side_effect = resolve_future

        result = await node.send_intervene("sess-1", "stop", user="admin")

        sent = ws.send_json.call_args[0][0]
        assert sent["type"] == CMD_INTERVENE
        assert sent["agentSessionId"] == "sess-1"
        assert sent["text"] == "stop"
        assert sent["user"] == "admin"

    async def test_send_subscribe_events_sends_command_and_registers_listener(self, node, ws):
        """subscribe_events sends command and registers the callback."""
        callback = AsyncMock()

        subscribe_id = await node.send_subscribe_events("sess-1", callback)

        assert subscribe_id  # non-empty UUID string
        assert "sess-1" in node._subscribe_listeners
        assert subscribe_id in node._subscribe_listeners["sess-1"]

        ws.send_json.assert_called_once()
        sent = ws.send_json.call_args[0][0]
        assert sent["type"] == CMD_SUBSCRIBE_EVENTS
        assert sent["agentSessionId"] == "sess-1"
        assert sent["subscribeId"] == subscribe_id

    async def test_unsubscribe_events_removes_listener(self, node):
        """unsubscribe_events removes the callback from listeners."""
        node._subscribe_listeners["sess-1"] = {"sub-1": AsyncMock()}

        node.unsubscribe_events("sess-1", "sub-1")

        assert "sess-1" not in node._subscribe_listeners

    async def test_send_command_timeout_raises(self, node, ws):
        """Command that times out raises TimeoutError."""
        # send_json does nothing, so the future never resolves
        ws.send_json = AsyncMock()

        with pytest.raises(TimeoutError, match="timed out"):
            await node.send_create_session(prompt="test", session_id="s1")


class TestClose:
    """close() cleanup tests."""

    async def test_close_cancels_pending_futures(self, node, ws):
        """close() cancels all pending futures and clears listeners."""
        loop = asyncio.get_running_loop()
        future = loop.create_future()
        node._pending["req-1"] = future
        node._subscribe_listeners["sess-1"] = {"sub-1": AsyncMock()}

        await node.close()

        assert future.cancelled()
        assert len(node._pending) == 0
        assert len(node._subscribe_listeners) == 0
        ws.close.assert_called_once()

    async def test_close_calls_on_close_callback(self, ws):
        """close() invokes the on_close callback."""
        on_close = AsyncMock()
        node = NodeConnection(ws=ws, node_id="n1", on_close=on_close)

        await node.close()

        on_close.assert_called_once_with(node)

    async def test_close_handles_ws_close_error(self, ws):
        """close() tolerates WebSocket close errors."""
        ws.close.side_effect = RuntimeError("already closed")
        on_close = AsyncMock()
        node = NodeConnection(ws=ws, node_id="n1", on_close=on_close)

        await node.close()  # Should not raise

        on_close.assert_called_once()


class TestToInfo:
    """to_info() serialization tests."""

    async def test_to_info_returns_expected_fields(self, node):
        """to_info() returns all expected fields."""
        info = node.to_info()

        assert info["nodeId"] == "node-1"
        assert info["host"] == "localhost"
        assert info["port"] == 4100
        assert info["status"] == "connected"
        assert info["sessionCount"] == 0
        assert "connectedAt" in info


class TestUserInfo:
    """user_info 관련 테스트."""

    def test_user_info_initial_is_empty_dict(self, node):
        """초기 user_info는 빈 dict이다."""
        assert node.user_info == {}

    def test_set_user_info_stores_data(self, node):
        """set_user_info로 설정된 데이터를 user_info 프로퍼티로 조회할 수 있다."""
        user_data = {"name": "테스터", "hasPortrait": True}
        node.set_user_info(user_data)

        assert node.user_info == user_data
        assert node.user_info["name"] == "테스터"
        assert node.user_info["hasPortrait"] is True

    def test_set_user_info_overwrites_previous(self, node):
        """set_user_info 재호출 시 이전 값을 덮어쓴다."""
        node.set_user_info({"name": "이전"})
        node.set_user_info({"name": "새값"})

        assert node.user_info["name"] == "새값"


class TestAttachmentPaths:
    """attachment_paths 관련 send_create_session / send_intervene 테스트."""

    async def test_send_create_session_includes_extra_context_items_when_attachment_paths(self, node, ws):
        """attachment_paths가 있으면 extra_context_items를 payload에 포함한다."""
        async def resolve_future(*args, **kwargs):
            data = args[0] if args else kwargs.get("data")
            req_id = data["requestId"]
            if req_id in node._pending:
                node._pending[req_id].set_result({"agentSessionId": "sess-r"})

        ws.send_json.side_effect = resolve_future

        await node.send_create_session(
            prompt="test",
            session_id="sid-1",
            attachment_paths=["/incoming/abc/file.txt", "/incoming/abc/img.png"],
        )

        sent = ws.send_json.call_args[0][0]
        assert "extra_context_items" in sent
        items = sent["extra_context_items"]
        assert isinstance(items, list)
        assert len(items) == 1
        assert items[0]["key"] == "attached_files"
        assert "/incoming/abc/file.txt" in items[0]["content"]
        assert "/incoming/abc/img.png" in items[0]["content"]

    async def test_send_create_session_no_extra_context_items_when_no_attachment_paths(self, node, ws):
        """attachment_paths가 None이면 extra_context_items를 payload에 포함하지 않는다."""
        async def resolve_future(*args, **kwargs):
            data = args[0] if args else kwargs.get("data")
            req_id = data["requestId"]
            if req_id in node._pending:
                node._pending[req_id].set_result({"agentSessionId": "sess-r"})

        ws.send_json.side_effect = resolve_future

        await node.send_create_session(prompt="test", session_id="sid-1")

        sent = ws.send_json.call_args[0][0]
        assert "extra_context_items" not in sent

    async def test_send_intervene_includes_attachment_paths_when_provided(self, node, ws):
        """attachment_paths가 있으면 send_intervene payload에 포함한다."""
        async def resolve_future(*args, **kwargs):
            data = args[0] if args else kwargs.get("data")
            req_id = data["requestId"]
            if req_id in node._pending:
                node._pending[req_id].set_result({"ok": True})

        ws.send_json.side_effect = resolve_future

        await node.send_intervene(
            "sess-1", "add file context", user="admin",
            attachment_paths=["/incoming/sess-1/doc.pdf"],
        )

        sent = ws.send_json.call_args[0][0]
        assert sent["type"] == CMD_INTERVENE
        assert "attachment_paths" in sent
        assert sent["attachment_paths"] == ["/incoming/sess-1/doc.pdf"]

    async def test_send_intervene_no_attachment_paths_key_when_none(self, node, ws):
        """attachment_paths가 None이면 payload에 해당 키가 없다."""
        async def resolve_future(*args, **kwargs):
            data = args[0] if args else kwargs.get("data")
            req_id = data["requestId"]
            if req_id in node._pending:
                node._pending[req_id].set_result({"ok": True})

        ws.send_json.side_effect = resolve_future

        await node.send_intervene("sess-1", "hello", user="u")

        sent = ws.send_json.call_args[0][0]
        assert "attachment_paths" not in sent
