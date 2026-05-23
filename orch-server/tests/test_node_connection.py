"""Tests for NodeConnection message handling and command sending."""

import asyncio
from unittest.mock import AsyncMock, MagicMock

import pytest

from soulstream_server.constants import (
    CMD_APPROVE_TOOL,
    CMD_CREATE_SESSION,
    CMD_DELETE_SESSION_ATTACHMENTS,
    CMD_DOWNLOAD_ATTACHMENT,
    CMD_INTERVENE,
    CMD_INTERRUPT_SESSION,
    CMD_REALTIME_CREATE_CALL,
    CMD_REALTIME_EVENT,
    CMD_REALTIME_RESOLVE_TOOL_APPROVAL,
    CMD_REJECT_TOOL,
    CMD_RESPOND,
    CMD_SUBSCRIBE_EVENTS,
    CMD_UPLOAD_ATTACHMENT,
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

    async def test_send_interrupt_session_sends_correct_payload(self, node, ws):
        """send_interrupt_session sends interrupt command and waits for ACK."""

        async def resolve_future(*args, **kwargs):
            data = args[0] if args else kwargs.get("data")
            req_id = data["requestId"]
            if req_id in node._pending:
                node._pending[req_id].set_result({
                    "type": "interrupt_session_ack",
                    "requestId": req_id,
                    "status": "ok",
                    "interrupted": True,
                })

        ws.send_json.side_effect = resolve_future

        result = await node.send_interrupt_session("sess-1")

        sent = ws.send_json.call_args[0][0]
        assert sent["type"] == CMD_INTERRUPT_SESSION
        assert sent["agentSessionId"] == "sess-1"
        assert result["interrupted"] is True

    async def test_send_respond_sends_input_request_id_without_overwriting_command_request_id(
        self, node, ws
    ):
        """respond는 input_request id를 inputRequestId로 보내고 ACK requestId로 resolve한다."""

        async def resolve_future(*args, **kwargs):
            data = args[0] if args else kwargs.get("data")
            req_id = data["requestId"]
            if req_id in node._pending:
                node._pending[req_id].set_result({
                    "type": "respond_ack",
                    "requestId": req_id,
                    "status": "ok",
                    "inputRequestId": data["inputRequestId"],
                })

        ws.send_json.side_effect = resolve_future

        result = await node.send_respond("sess-1", "ask-hex-1", {"choice": "yes"})

        sent = ws.send_json.call_args[0][0]
        assert sent["type"] == CMD_RESPOND
        assert sent["agentSessionId"] == "sess-1"
        assert sent["inputRequestId"] == "ask-hex-1"
        assert sent["requestId"] != "ask-hex-1"
        assert result["status"] == "ok"
        assert result["inputRequestId"] == "ask-hex-1"

    async def test_send_tool_approval_sends_approval_command(self, node, ws):
        """tool approval 명령은 approvalId와 별도 ACK requestId를 함께 보낸다."""

        async def resolve_future(*args, **kwargs):
            data = args[0] if args else kwargs.get("data")
            req_id = data["requestId"]
            if req_id in node._pending:
                node._pending[req_id].set_result({
                    "type": "tool_approval_ack",
                    "requestId": req_id,
                    "status": "ok",
                    "approvalId": data["approvalId"],
                    "decision": "rejected",
                    "delivered": True,
                })

        ws.send_json.side_effect = resolve_future

        result = await node.send_tool_approval(
            "sess-1",
            "danger-call-1",
            "rejected",
            message="no prod write",
            always_reject=True,
        )

        sent = ws.send_json.call_args[0][0]
        assert sent["type"] == CMD_REJECT_TOOL
        assert sent["agentSessionId"] == "sess-1"
        assert sent["approvalId"] == "danger-call-1"
        assert sent["requestId"] != "danger-call-1"
        assert sent["message"] == "no prod write"
        assert sent["alwaysReject"] is True
        assert result["status"] == "ok"
        assert result["approvalId"] == "danger-call-1"

    async def test_send_tool_approval_sends_approve_command(self, node, ws):
        """approved decision은 approve_tool 명령으로 전송한다."""

        async def resolve_future(*args, **kwargs):
            data = args[0] if args else kwargs.get("data")
            req_id = data["requestId"]
            if req_id in node._pending:
                node._pending[req_id].set_result({
                    "type": "tool_approval_ack",
                    "requestId": req_id,
                    "status": "ok",
                    "approvalId": data["approvalId"],
                    "decision": "approved",
                    "delivered": True,
                })

        ws.send_json.side_effect = resolve_future

        result = await node.send_tool_approval(
            "sess-1",
            "safe-call-1",
            "approved",
            always_approve=True,
        )

        sent = ws.send_json.call_args[0][0]
        assert sent["type"] == CMD_APPROVE_TOOL
        assert sent["agentSessionId"] == "sess-1"
        assert sent["approvalId"] == "safe-call-1"
        assert sent["requestId"] != "safe-call-1"
        assert sent["alwaysApprove"] is True
        assert result["status"] == "ok"
        assert result["approvalId"] == "safe-call-1"

    async def test_send_realtime_create_call_sends_offer_without_api_key(self, node, ws):
        """Realtime call broker command은 SDP offer만 전달하고 OpenAI key를 앱/오케스트레이터에 싣지 않는다."""

        async def resolve_future(*args, **kwargs):
            data = args[0] if args else kwargs.get("data")
            req_id = data["requestId"]
            if req_id in node._pending:
                node._pending[req_id].set_result({
                    "type": "realtime_call_created",
                    "requestId": req_id,
                    "status": "ok",
                    "callId": "call_1",
                    "answerSdp": "answer",
                })

        ws.send_json.side_effect = resolve_future

        result = await node.send_realtime_create_call(
            "sess-rt",
            "offer",
            model="gpt-realtime",
            voice="alloy",
        )

        sent = ws.send_json.call_args[0][0]
        assert sent["type"] == CMD_REALTIME_CREATE_CALL
        assert sent["agentSessionId"] == "sess-rt"
        assert sent["offerSdp"] == "offer"
        assert sent["model"] == "gpt-realtime"
        assert sent["voice"] == "alloy"
        assert "apiKey" not in sent
        assert result["answerSdp"] == "answer"

    async def test_send_realtime_event_sends_data_channel_event(self, node, ws):
        """soul-app data-channel event를 realtime_event command로 전달한다."""

        async def resolve_future(*args, **kwargs):
            data = args[0] if args else kwargs.get("data")
            req_id = data["requestId"]
            if req_id in node._pending:
                node._pending[req_id].set_result({
                    "type": "realtime_event_ack",
                    "requestId": req_id,
                    "status": "ok",
                    "normalizedType": "realtime_transcript",
                    "eventId": 5,
                })

        ws.send_json.side_effect = resolve_future

        result = await node.send_realtime_event(
            "sess-rt",
            {"type": "response.audio_transcript.done", "transcript": "hi"},
            call_id="call_1",
        )

        sent = ws.send_json.call_args[0][0]
        assert sent["type"] == CMD_REALTIME_EVENT
        assert sent["agentSessionId"] == "sess-rt"
        assert sent["event"]["type"] == "response.audio_transcript.done"
        assert sent["callId"] == "call_1"
        assert result["normalizedType"] == "realtime_transcript"

    async def test_send_realtime_tool_approval_sends_decision_command(self, node, ws):
        """voice/tap realtime approval resolution은 별도 command로 전달한다."""

        async def resolve_future(*args, **kwargs):
            data = args[0] if args else kwargs.get("data")
            req_id = data["requestId"]
            if req_id in node._pending:
                node._pending[req_id].set_result({
                    "type": "realtime_tool_approval_ack",
                    "requestId": req_id,
                    "status": "ok",
                    "approvalId": data["approvalId"],
                    "decision": data["decision"],
                    "dataChannelEvent": {"type": "tool_approval.response"},
                })

        ws.send_json.side_effect = resolve_future

        result = await node.send_realtime_tool_approval(
            "sess-rt",
            "approval-1",
            "approved",
            source="voice",
        )

        sent = ws.send_json.call_args[0][0]
        assert sent["type"] == CMD_REALTIME_RESOLVE_TOOL_APPROVAL
        assert sent["agentSessionId"] == "sess-rt"
        assert sent["approvalId"] == "approval-1"
        assert sent["decision"] == "approved"
        assert sent["source"] == "voice"
        assert result["status"] == "ok"

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

    async def test_send_create_session_includes_reasoning_effort(self, node, ws):
        """reasoning_effort가 있으면 camelCase wire 키로 전달한다."""
        async def resolve_future(*args, **kwargs):
            data = args[0] if args else kwargs.get("data")
            req_id = data["requestId"]
            if req_id in node._pending:
                node._pending[req_id].set_result({"agentSessionId": "sess-r"})

        ws.send_json.side_effect = resolve_future

        await node.send_create_session(
            prompt="test",
            session_id="sid-1",
            reasoning_effort="medium",
        )

        sent = ws.send_json.call_args[0][0]
        assert sent["reasoningEffort"] == "medium"

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


class TestSendUploadAttachment:
    """attachment WS reverse-proxy — send_upload_attachment 단위 테스트.

    노드 self-reported host:port HTTP 가정 폐기 후 신규 정공법 wire (atom 260513.01).
    """

    async def test_sends_upload_command_with_b64_payload(self, node, ws):
        """payload type/필드 검증 + request_id 매칭."""
        async def resolve_future(*args, **kwargs):
            data = args[0] if args else kwargs.get("data")
            req_id = data["requestId"]
            if req_id in node._pending:
                node._pending[req_id].set_result({
                    "type": "upload_attachment_result",
                    "path": "/incoming/s/x.png",
                    "filename": "x.png",
                    "size": 4,
                    "content_type": "image/png",
                })

        ws.send_json.side_effect = resolve_future

        result = await node.send_upload_attachment(
            session_id="sess-1",
            filename="x.png",
            content_type="image/png",
            content_b64="YWJjZA==",
        )

        sent = ws.send_json.call_args[0][0]
        assert sent["type"] == CMD_UPLOAD_ATTACHMENT
        assert sent["session_id"] == "sess-1"
        assert sent["filename"] == "x.png"
        assert sent["content_type"] == "image/png"
        assert sent["content_b64"] == "YWJjZA=="
        assert "requestId" in sent
        assert result["path"] == "/incoming/s/x.png"

    async def test_raises_runtime_error_on_evt_error(self, node, ws):
        """노드가 EVT_ERROR로 응답 → RuntimeError raise (orch 측이 분류한다)."""
        async def resolve_future(*args, **kwargs):
            data = args[0] if args else kwargs.get("data")
            req_id = data["requestId"]
            if req_id in node._pending:
                # NodeConnection.handle_message는 EVT_ERROR를 RuntimeError로 변환한다
                await node.handle_message({
                    "type": EVT_ERROR,
                    "requestId": req_id,
                    "message": "INVALID_REQUEST: 보안상 허용되지 않는 파일 형식입니다: .exe",
                })

        ws.send_json.side_effect = resolve_future

        with pytest.raises(RuntimeError, match="INVALID_REQUEST"):
            await node.send_upload_attachment(
                session_id="s", filename="evil.exe",
                content_type="application/octet-stream", content_b64="eA==",
            )

    async def test_raises_timeout_when_no_response(self, node, ws):
        """노드 미응답 → asyncio.wait_for timeout → TimeoutError raise."""
        # ws.send_json은 그냥 noop — future가 끝까지 resolve되지 않음
        # COMMAND_TIMEOUT 기본 30초이지만 본 테스트는 timeout 강제를 위해
        # _send_command를 직접 호출하지 않고 짧은 timeout으로 wait_for.
        # send_upload_attachment 내부의 _send_command(..., timeout=COMMAND_TIMEOUT)는
        # 그대로 두고 외부 wait_for로 단축한다.
        with pytest.raises((TimeoutError, asyncio.TimeoutError)):
            await asyncio.wait_for(
                node.send_upload_attachment(
                    session_id="s", filename="x", content_type="text/plain", content_b64="eA==",
                ),
                timeout=0.2,
            )


class TestSendCommandDisconnect:
    """노드 disconnect 중 outstanding _send_command 결과 정규화 (code-review P1)."""

    async def test_send_failure_cleans_pending_and_raises_connection_error(
        self, node, ws
    ):
        """send_json 실패는 pending을 남기지 않고 ConnectionError로 정규화한다."""
        ws.send_json.side_effect = RuntimeError("Cannot send after close")

        with pytest.raises(ConnectionError, match="Node disconnected before send"):
            await node._send_command("test_command", {}, timeout=0.1)

        assert node._pending == {}

    async def test_close_during_command_raises_connection_error(self, node, ws):
        """close()가 outstanding 요청 중 호출되면 _closed flag set + future cancel →
        _send_command가 ConnectionError로 정규화 (호출자가 503으로 분류 가능)."""
        ws.send_json = AsyncMock()

        async def simulate_close_after_delay():
            await asyncio.sleep(0.05)
            await node.close()

        close_task = asyncio.create_task(simulate_close_after_delay())

        with pytest.raises(ConnectionError, match="disconnected during command"):
            await node.send_upload_attachment(
                session_id="s", filename="x",
                content_type="text/plain", content_b64="eA==",
            )

        await close_task

    async def test_external_task_cancel_propagates_cancelled_error(self, node, ws):
        """close() 호출이 아닌 *외부 task cancellation*(예: HTTP request abort)은
        CancelledError 그대로 전파한다. _closed flag가 set되지 않았기 때문이다.

        실제 시나리오: 클라이언트가 HTTP 요청을 끊으면 FastAPI/starlette가 task를
        cancel한다. inner _send_command의 wait_for는 CancelledError를 받지만
        node 자체는 살아 있으므로 ConnectionError로 변환하면 안 된다.
        """
        ws.send_json = AsyncMock()

        # 외부에서 task 전체를 cancel
        async def run_send():
            await node.send_upload_attachment(
                session_id="s", filename="x",
                content_type="text/plain", content_b64="eA==",
            )

        task = asyncio.create_task(run_send())
        await asyncio.sleep(0.05)
        task.cancel()

        with pytest.raises(asyncio.CancelledError):
            await task

        # node는 여전히 살아있어야 함 (close() 호출 X)
        assert node._closed is False


class TestSendDeleteSessionAttachments:
    async def test_sends_delete_command(self, node, ws):
        async def resolve_future(*args, **kwargs):
            data = args[0] if args else kwargs.get("data")
            req_id = data["requestId"]
            if req_id in node._pending:
                node._pending[req_id].set_result({
                    "type": "delete_session_attachments_result",
                    "cleaned": True,
                    "files_removed": 5,
                })

        ws.send_json.side_effect = resolve_future

        result = await node.send_delete_session_attachments("sess-xyz")

        sent = ws.send_json.call_args[0][0]
        assert sent["type"] == CMD_DELETE_SESSION_ATTACHMENTS
        assert sent["session_id"] == "sess-xyz"
        assert result["files_removed"] == 5

    async def test_raises_runtime_error_on_evt_error(self, node, ws):
        async def resolve_future(*args, **kwargs):
            data = args[0] if args else kwargs.get("data")
            req_id = data["requestId"]
            if req_id in node._pending:
                await node.handle_message({
                    "type": EVT_ERROR,
                    "requestId": req_id,
                    "message": "INVALID_REQUEST: session_id 누락",
                })

        ws.send_json.side_effect = resolve_future

        with pytest.raises(RuntimeError, match="INVALID_REQUEST"):
            await node.send_delete_session_attachments("")


class TestSendDownloadAttachment:
    """Phase 2 — chat-inline-attachment 다운로드 wire 단위 테스트."""

    async def test_sends_download_command_with_path(self, node, ws):
        async def resolve_future(*args, **kwargs):
            data = args[0] if args else kwargs.get("data")
            req_id = data["requestId"]
            if req_id in node._pending:
                node._pending[req_id].set_result({
                    "type": "download_attachment_result",
                    "content_b64": "aGVsbG8=",
                    "content_type": "image/png",
                    "filename": "x.png",
                    "size": 5,
                })

        ws.send_json.side_effect = resolve_future

        result = await node.send_download_attachment(path="/incoming/s/x.png")

        sent = ws.send_json.call_args[0][0]
        assert sent["type"] == CMD_DOWNLOAD_ATTACHMENT
        assert sent["path"] == "/incoming/s/x.png"
        assert "requestId" in sent
        assert result["content_b64"] == "aGVsbG8="
        assert result["content_type"] == "image/png"
        assert result["filename"] == "x.png"

    async def test_raises_runtime_error_on_evt_error_not_found(self, node, ws):
        """NOT_FOUND: prefix → RuntimeError (orch가 404로 분류)."""
        async def resolve_future(*args, **kwargs):
            data = args[0] if args else kwargs.get("data")
            req_id = data["requestId"]
            if req_id in node._pending:
                await node.handle_message({
                    "type": EVT_ERROR,
                    "requestId": req_id,
                    "message": "NOT_FOUND: 파일이 존재하지 않습니다",
                })

        ws.send_json.side_effect = resolve_future

        with pytest.raises(RuntimeError, match="NOT_FOUND"):
            await node.send_download_attachment(path="/incoming/missing.png")

    async def test_raises_runtime_error_on_evt_error_traversal(self, node, ws):
        async def resolve_future(*args, **kwargs):
            data = args[0] if args else kwargs.get("data")
            req_id = data["requestId"]
            if req_id in node._pending:
                await node.handle_message({
                    "type": EVT_ERROR,
                    "requestId": req_id,
                    "message": "INVALID_REQUEST: path가 첨부 디렉토리 하위가 아닙니다",
                })

        ws.send_json.side_effect = resolve_future

        with pytest.raises(RuntimeError, match="INVALID_REQUEST"):
            await node.send_download_attachment(path="/etc/passwd")
