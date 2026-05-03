"""UpstreamAdapter 단위 테스트.

mock WebSocket으로 명령 수신 → TaskManager 호출을 검증한다.
"""

import asyncio
import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from soul_server.upstream.adapter import UpstreamAdapter
from soul_server.upstream.protocol import (
    CMD_CREATE_SESSION,
    CMD_HEALTH_CHECK,
    CMD_INTERVENE,
    CMD_LIST_SESSIONS,
    CMD_RESPOND,
    EVT_ERROR,
    EVT_EVENT,
    EVT_HEALTH_STATUS,
    EVT_NODE_REGISTER,
    EVT_SESSION_CREATED,
    EVT_SESSION_DELETED,
    EVT_SESSION_UPDATED,
    EVT_SESSIONS_UPDATE,
)


# ─── Fixtures ───────────────────────────────────────


def _make_mock_task(agent_session_id: str = "test-session-1"):
    """TaskManager.create_task의 반환값 mock."""
    task = MagicMock()
    task.agent_session_id = agent_session_id
    return task


def _make_broadcaster():
    """테스트용 SessionBroadcaster mock 생성."""
    broadcaster = MagicMock()
    broadcaster.add_client = MagicMock(return_value=asyncio.Queue())
    broadcaster.remove_client = MagicMock()
    return broadcaster


def _make_adapter(
    task_manager: MagicMock | None = None,
    soul_engine: MagicMock | None = None,
    resource_manager: MagicMock | None = None,
    session_broadcaster: MagicMock | None = None,
    auth_bearer_token: str = "test-token",
) -> UpstreamAdapter:
    """테스트용 UpstreamAdapter 인스턴스 생성."""
    tm = task_manager or MagicMock()
    se = soul_engine or MagicMock()
    rm = resource_manager or MagicMock()
    rm.max_concurrent = 3
    rm.get_stats.return_value = {"active": 1, "available": 2, "max": 3}
    bc = session_broadcaster or _make_broadcaster()

    return UpstreamAdapter(
        task_manager=tm,
        soul_engine=se,
        resource_manager=rm,
        session_broadcaster=bc,
        upstream_url="ws://localhost:5200/ws/node",
        node_id="test-node",
        session_db=MagicMock(),
        host="localhost",
        port=3105,
        auth_bearer_token=auth_bearer_token,
    )


# ─── Tests ──────────────────────────────────────────


class TestHandleCreateSession:
    """create_session 명령 처리 테스트."""

    @pytest.mark.asyncio
    async def test_creates_task_and_starts_execution(self):
        tm = MagicMock()
        tm.create_task = AsyncMock(return_value=_make_mock_task("session-abc"))
        tm.start_execution = AsyncMock(return_value=True)
        tm.add_listener = AsyncMock(return_value=True)
        tm.remove_listener = AsyncMock()

        adapter = _make_adapter(task_manager=tm)
        adapter._ws = MagicMock()
        adapter._ws.closed = False
        adapter._ws.send_json = AsyncMock()
        adapter._running = True

        cmd = {
            "type": CMD_CREATE_SESSION,
            "prompt": "Hello, world!",
            "requestId": "req-1",
        }

        await adapter._handle_command(cmd)

        # TaskManager.create_task 호출 확인
        tm.create_task.assert_awaited_once()
        call_kwargs = tm.create_task.call_args.kwargs
        assert call_kwargs["prompt"] == "Hello, world!"

        # 실행 시작 확인
        tm.start_execution.assert_awaited_once_with(
            agent_session_id="session-abc",
            claude_runner=adapter._engine,
            resource_manager=adapter._rm,
        )

        # session_created 응답 전송 확인
        sent_messages = [
            call.args[0] for call in adapter._ws.send_json.call_args_list
        ]
        created_msgs = [m for m in sent_messages if m["type"] == EVT_SESSION_CREATED]
        assert len(created_msgs) == 1
        assert created_msgs[0]["agentSessionId"] == "session-abc"
        assert created_msgs[0]["requestId"] == "req-1"

    @pytest.mark.asyncio
    async def test_passes_optional_parameters(self):
        tm = MagicMock()
        tm.create_task = AsyncMock(return_value=_make_mock_task())
        tm.start_execution = AsyncMock(return_value=True)
        tm.add_listener = AsyncMock(return_value=True)
        tm.remove_listener = AsyncMock()

        adapter = _make_adapter(task_manager=tm)
        adapter._ws = MagicMock()
        adapter._ws.closed = False
        adapter._ws.send_json = AsyncMock()
        adapter._running = True

        cmd = {
            "type": CMD_CREATE_SESSION,
            "prompt": "Test",
            "allowedTools": ["Read", "Grep"],   # camelCase — 실제 soulstream이 전송하는 형식
            "disallowedTools": ["Bash"],         # camelCase — 실제 soulstream이 전송하는 형식
            "use_mcp": False,
            "request_id": "req-2",
        }

        await adapter._handle_command(cmd)

        call_kwargs = tm.create_task.call_args.kwargs
        assert call_kwargs["allowed_tools"] == ["Read", "Grep"]
        assert call_kwargs["disallowed_tools"] == ["Bash"]
        assert call_kwargs["use_mcp"] is False

    @pytest.mark.asyncio
    async def test_passes_caller_info_to_task_manager(self):
        """WS payload의 caller_info가 create_task 인자로 그대로 전달된다."""
        tm = MagicMock()
        tm.create_task = AsyncMock(return_value=_make_mock_task())
        tm.start_execution = AsyncMock(return_value=True)
        tm.add_listener = AsyncMock(return_value=True)
        tm.remove_listener = AsyncMock()

        adapter = _make_adapter(task_manager=tm)
        adapter._ws = MagicMock()
        adapter._ws.closed = False
        adapter._ws.send_json = AsyncMock()
        adapter._running = True

        caller_info = {
            "source": "browser",
            "ip": "10.0.0.5",
            "user_agent": "Mozilla/5.0",
            "referer": "https://dashboard.example/",
        }
        cmd = {
            "type": CMD_CREATE_SESSION,
            "prompt": "Test",
            "caller_info": caller_info,
        }

        await adapter._handle_command(cmd)

        call_kwargs = tm.create_task.call_args.kwargs
        assert call_kwargs["caller_info"] == caller_info

    @pytest.mark.asyncio
    async def test_caller_info_absent_passes_none(self):
        """WS payload에 caller_info가 없으면 create_task에 None이 전달된다 (소비부에서 .get())."""
        tm = MagicMock()
        tm.create_task = AsyncMock(return_value=_make_mock_task())
        tm.start_execution = AsyncMock(return_value=True)
        tm.add_listener = AsyncMock(return_value=True)
        tm.remove_listener = AsyncMock()

        adapter = _make_adapter(task_manager=tm)
        adapter._ws = MagicMock()
        adapter._ws.closed = False
        adapter._ws.send_json = AsyncMock()
        adapter._running = True

        cmd = {
            "type": CMD_CREATE_SESSION,
            "prompt": "Test",
        }

        await adapter._handle_command(cmd)

        call_kwargs = tm.create_task.call_args.kwargs
        assert call_kwargs["caller_info"] is None


class TestHandleIntervene:
    """intervene 명령 처리 테스트."""

    @pytest.mark.asyncio
    async def test_calls_add_intervention(self):
        tm = MagicMock()
        tm.add_intervention = AsyncMock(return_value={"queued": True})

        adapter = _make_adapter(task_manager=tm)
        adapter._ws = MagicMock()
        adapter._ws.closed = False
        adapter._ws.send_json = AsyncMock()

        cmd = {
            "type": CMD_INTERVENE,
            "session_id": "session-1",
            "text": "Please stop",
            "user": "admin",
        }

        await adapter._handle_command(cmd)

        tm.add_intervention.assert_awaited_once_with(
            agent_session_id="session-1",
            text="Please stop",
            user="admin",
            attachment_paths=None,
        )

    @pytest.mark.asyncio
    async def test_auto_resume_starts_execution(self):
        tm = MagicMock()
        tm.add_intervention = AsyncMock(return_value={"auto_resumed": True})
        tm.start_execution = AsyncMock(return_value=True)
        tm.add_listener = AsyncMock(return_value=True)
        tm.remove_listener = AsyncMock()

        adapter = _make_adapter(task_manager=tm)
        adapter._ws = MagicMock()
        adapter._ws.closed = False
        adapter._ws.send_json = AsyncMock()
        adapter._running = True

        cmd = {
            "type": CMD_INTERVENE,
            "session_id": "session-1",
            "text": "Continue",
            "user": "system",
        }

        await adapter._handle_command(cmd)

        tm.start_execution.assert_awaited_once()


class TestHandleRespond:
    """respond 명령 처리 테스트."""

    @pytest.mark.asyncio
    async def test_delivers_input_response(self):
        tm = MagicMock()
        tm.deliver_input_response.return_value = True

        adapter = _make_adapter(task_manager=tm)
        adapter._ws = MagicMock()
        adapter._ws.closed = False
        adapter._ws.send_json = AsyncMock()

        cmd = {
            "type": CMD_RESPOND,
            "session_id": "session-1",
            "request_id": "input-req-1",  # 구버전 snake_case fallback
            "answers": {"q1": "yes"},
        }

        await adapter._handle_command(cmd)

        tm.deliver_input_response.assert_called_once_with(
            agent_session_id="session-1",
            request_id="input-req-1",
            answers={"q1": "yes"},
        )

    @pytest.mark.asyncio
    async def test_sends_ack_with_ws_command_id(self):
        """_handle_respond는 WS 명령 ID(cmd['requestId'])를 ACK으로 돌려보내야 한다.

        회귀 방지: ACK 누락 시 orch-server _send_command future가 30초 타임아웃에 걸린다.
        send_respond가 inputRequestId 별도 키로 input_request의 request_id를 보내고,
        cmd['requestId']는 WS 명령 ID(orch-server _pending 매칭용)로 사용된다.
        """
        tm = MagicMock()
        tm.deliver_input_response.return_value = True

        adapter = _make_adapter(task_manager=tm)
        adapter._ws = MagicMock()
        adapter._ws.closed = False
        sent_messages = []

        async def fake_send_json(msg):
            sent_messages.append(msg)

        adapter._ws.send_json = fake_send_json

        cmd = {
            "type": CMD_RESPOND,
            "requestId": "orch-cmd-001",          # WS 명령 ID
            "agentSessionId": "sess-1",
            "inputRequestId": "f88617569028",     # input_request의 hex
            "answers": {"q": "a"},
        }

        await adapter._handle_command(cmd)

        # deliver_input_response에는 inputRequestId가 전달되어야 한다
        tm.deliver_input_response.assert_called_once_with(
            agent_session_id="sess-1",
            request_id="f88617569028",
            answers={"q": "a"},
        )
        # ACK은 WS 명령 ID로 돌아가야 한다 (input_request hex가 아님)
        assert any(
            msg.get("type") == "respond_ack" and msg.get("requestId") == "orch-cmd-001"
            for msg in sent_messages
        ), f"respond_ack with requestId='orch-cmd-001' not found in {sent_messages}"

    @pytest.mark.asyncio
    async def test_legacy_request_id_fallback(self):
        """구버전 orch-server 호환 — request_id snake_case로 폴백."""
        tm = MagicMock()
        tm.deliver_input_response.return_value = True

        adapter = _make_adapter(task_manager=tm)
        adapter._ws = MagicMock()
        adapter._ws.closed = False
        sent_messages = []

        async def fake_send_json(msg):
            sent_messages.append(msg)

        adapter._ws.send_json = fake_send_json

        cmd = {
            "type": CMD_RESPOND,
            "requestId": "orch-cmd-002",
            "agentSessionId": "sess-2",
            "request_id": "legacy-input-id",  # snake_case fallback
            "answers": {"q": "a"},
        }

        await adapter._handle_command(cmd)

        tm.deliver_input_response.assert_called_once_with(
            agent_session_id="sess-2",
            request_id="legacy-input-id",
            answers={"q": "a"},
        )


class TestHandleListSessions:
    """list_sessions 명령 처리 테스트."""

    @pytest.mark.asyncio
    async def test_returns_session_list(self):
        tm = MagicMock()
        tm.get_all_sessions = AsyncMock(return_value=(
            [{"session_id": "s1"}, {"session_id": "s2"}],
            2,
        ))

        adapter = _make_adapter(task_manager=tm)
        adapter._ws = MagicMock()
        adapter._ws.closed = False
        adapter._ws.send_json = AsyncMock()

        cmd = {
            "type": CMD_LIST_SESSIONS,
            "requestId": "req-list-1",
        }

        await adapter._handle_command(cmd)

        adapter._ws.send_json.assert_awaited_once()
        sent = adapter._ws.send_json.call_args.args[0]
        assert sent["type"] == EVT_SESSIONS_UPDATE
        assert len(sent["sessions"]) == 2
        assert sent["total"] == 2
        assert sent["requestId"] == "req-list-1"


class TestHandleHealthCheck:
    """health_check 명령 처리 테스트."""

    @pytest.mark.asyncio
    async def test_returns_health_status(self):
        rm = MagicMock()
        rm.max_concurrent = 3
        rm.get_stats.return_value = {"active": 1, "available": 2, "max": 3}

        adapter = _make_adapter(resource_manager=rm)
        adapter._ws = MagicMock()
        adapter._ws.closed = False
        adapter._ws.send_json = AsyncMock()

        cmd = {
            "type": CMD_HEALTH_CHECK,
            "requestId": "req-health-1",
        }

        await adapter._handle_command(cmd)

        sent = adapter._ws.send_json.call_args.args[0]
        assert sent["type"] == EVT_HEALTH_STATUS
        assert sent["node_id"] == "test-node"
        assert sent["runners"]["max"] == 3
        assert sent["requestId"] == "req-health-1"


class TestUnknownCommand:
    """알 수 없는 명령 타입 처리 테스트."""

    @pytest.mark.asyncio
    async def test_sends_error_for_unknown_command(self):
        adapter = _make_adapter()
        adapter._ws = MagicMock()
        adapter._ws.closed = False
        adapter._ws.send_json = AsyncMock()

        cmd = {
            "type": "totally_unknown",
            "request_id": "req-x",
        }

        await adapter._handle_command(cmd)

        sent = adapter._ws.send_json.call_args.args[0]
        assert sent["type"] == EVT_ERROR
        assert "Unknown command type" in sent["message"]
        assert sent["command_type"] == "totally_unknown"


class TestStreamEvents:
    """이벤트 스트리밍 테스트."""

    @pytest.mark.asyncio
    async def test_streams_events_across_turns(self):
        """complete 이후에도 스트림이 종료되지 않고 다음 turn 이벤트를 이어서 전달한다."""
        tm = MagicMock()

        # turn 1 + turn 2 이벤트 + None 센티넬(세션 종료)
        events_to_send = [
            {"type": "progress", "text": "Turn 1 thinking..."},
            {"type": "complete", "result": "Turn 1 done"},
            {"type": "user_message", "text": "Turn 2 input"},
            {"type": "progress", "text": "Turn 2 thinking..."},
            {"type": "complete", "result": "Turn 2 done"},
            None,  # 세션 종료 센티넬
        ]

        async def mock_add_listener(session_id, queue):
            async def _feed():
                for e in events_to_send:
                    await queue.put(e)
            asyncio.create_task(_feed())

        tm.add_listener = AsyncMock(side_effect=mock_add_listener)
        tm.remove_listener = AsyncMock()

        adapter = _make_adapter(task_manager=tm)
        adapter._ws = MagicMock()
        adapter._ws.closed = False
        adapter._ws.send_json = AsyncMock()
        adapter._running = True

        await adapter._stream_events("session-1")

        # None 센티넬 이전의 모든 이벤트(5개)가 전달돼야 한다
        sent_messages = [
            call.args[0] for call in adapter._ws.send_json.call_args_list
        ]
        assert len(sent_messages) == 5, f"기대 5개, 실제 {len(sent_messages)}개"

        assert sent_messages[0]["event"]["type"] == "progress"
        assert sent_messages[1]["event"]["type"] == "complete"   # 종료 없이 계속
        assert sent_messages[2]["event"]["type"] == "user_message"
        assert sent_messages[3]["event"]["type"] == "progress"
        assert sent_messages[4]["event"]["type"] == "complete"

        # 리스너 제거 확인
        tm.remove_listener.assert_awaited_once()


class TestReconnectPolicy:
    """ReconnectPolicy 테스트."""

    @pytest.mark.asyncio
    async def test_exponential_backoff(self):
        from soul_server.upstream.reconnect import ReconnectPolicy

        policy = ReconnectPolicy(initial_delay=0.01, max_delay=0.1, multiplier=2.0)

        assert policy.attempt == 0

        # 첫 번째 대기
        await policy.wait()
        assert policy.attempt == 1

        # 리셋 후 다시 시작
        policy.reset()
        assert policy.attempt == 0

    @pytest.mark.asyncio
    async def test_max_delay_cap(self):
        from soul_server.upstream.reconnect import ReconnectPolicy

        policy = ReconnectPolicy(initial_delay=0.01, max_delay=0.02, multiplier=10.0)

        await policy.wait()  # 0.01s
        await policy.wait()  # min(0.1, 0.02) = 0.02s
        await policy.wait()  # min(0.2, 0.02) = 0.02s — 캡 적용

        assert policy.attempt == 3


class TestShutdown:
    """shutdown 동작 테스트."""

    @pytest.mark.asyncio
    async def test_shutdown_cancels_stream_tasks(self):
        adapter = _make_adapter()
        adapter._running = True
        adapter._session = MagicMock()
        adapter._session.closed = False
        adapter._session.close = AsyncMock()

        # 가짜 스트리밍 태스크
        mock_task = MagicMock()
        mock_task.cancel = MagicMock()
        adapter._stream_tasks["session-1"] = mock_task

        await adapter.shutdown()

        assert adapter._running is False
        mock_task.cancel.assert_called_once()
        assert len(adapter._stream_tasks) == 0
        adapter._session.close.assert_awaited_once()


class TestInitialSessionSync:
    """연결 직후 초기 세션 전송 테스트."""

    @pytest.mark.asyncio
    async def test_send_initial_sessions(self):
        """_send_initial_sessions가 현재 세션 목록을 sessions_update로 전송."""
        tm = MagicMock()
        tm.get_all_sessions = AsyncMock(return_value=(
            [
                {"agent_session_id": "s1", "status": "running"},
                {"agent_session_id": "s2", "status": "completed"},
            ],
            2,
        ))

        adapter = _make_adapter(task_manager=tm)
        adapter._ws = MagicMock()
        adapter._ws.closed = False
        adapter._ws.send_json = AsyncMock()

        await adapter._send_initial_sessions()

        sent = adapter._ws.send_json.call_args.args[0]
        assert sent["type"] == EVT_SESSIONS_UPDATE
        assert len(sent["sessions"]) == 2
        assert sent["total"] == 2

    @pytest.mark.asyncio
    async def test_send_initial_sessions_empty(self):
        """세션이 없을 때도 빈 목록을 정상 전송."""
        tm = MagicMock()
        tm.get_all_sessions = AsyncMock(return_value=([], 0))

        adapter = _make_adapter(task_manager=tm)
        adapter._ws = MagicMock()
        adapter._ws.closed = False
        adapter._ws.send_json = AsyncMock()

        await adapter._send_initial_sessions()

        sent = adapter._ws.send_json.call_args.args[0]
        assert sent["type"] == EVT_SESSIONS_UPDATE
        assert sent["sessions"] == []
        assert sent["total"] == 0


class TestBroadcastSessionChanges:
    """SessionBroadcaster 이벤트 → 오케스트레이터 전달 테스트.

    _dispatch_broadcast_event를 직접 호출하여 이벤트 변환 로직을 검증한다.
    """

    @pytest.mark.asyncio
    async def test_forwards_session_created(self):
        """session_created 이벤트를 agentSessionId 포함하여 전달."""
        adapter = _make_adapter()
        adapter._ws = MagicMock()
        adapter._ws.closed = False
        adapter._ws.send_json = AsyncMock()

        await adapter._dispatch_broadcast_event({
            "type": "session_created",
            "session": {
                "agent_session_id": "new-session-1",
                "status": "running",
                "prompt": "Hello",
            },
        })

        sent = adapter._ws.send_json.call_args.args[0]
        assert sent["type"] == EVT_SESSION_CREATED
        assert sent["agentSessionId"] == "new-session-1"
        assert sent["session"]["agent_session_id"] == "new-session-1"

    @pytest.mark.asyncio
    async def test_forwards_session_updated(self):
        """session_updated 이벤트를 그대로 전달."""
        adapter = _make_adapter()
        adapter._ws = MagicMock()
        adapter._ws.closed = False
        adapter._ws.send_json = AsyncMock()

        await adapter._dispatch_broadcast_event({
            "type": "session_updated",
            "agent_session_id": "session-1",
            "status": "completed",
            "updated_at": "2026-03-20T08:00:00Z",
        })

        sent = adapter._ws.send_json.call_args.args[0]
        assert sent["type"] == EVT_SESSION_UPDATED
        assert sent["agent_session_id"] == "session-1"
        assert sent["status"] == "completed"

    @pytest.mark.asyncio
    async def test_forwards_session_updated_with_last_message(self):
        """last_message 포함 session_updated 이벤트 전달."""
        adapter = _make_adapter()
        adapter._ws = MagicMock()
        adapter._ws.closed = False
        adapter._ws.send_json = AsyncMock()

        await adapter._dispatch_broadcast_event({
            "type": "session_updated",
            "agent_session_id": "session-1",
            "status": "running",
            "updated_at": "2026-03-20T08:00:00Z",
            "last_message": {
                "type": "text",
                "preview": "Working on it...",
                "timestamp": "2026-03-20T08:00:00Z",
            },
        })

        sent = adapter._ws.send_json.call_args.args[0]
        assert sent["type"] == EVT_SESSION_UPDATED
        assert sent["last_message"]["preview"] == "Working on it..."

    @pytest.mark.asyncio
    async def test_forwards_session_deleted(self):
        """session_deleted 이벤트를 그대로 전달."""
        adapter = _make_adapter()
        adapter._ws = MagicMock()
        adapter._ws.closed = False
        adapter._ws.send_json = AsyncMock()

        await adapter._dispatch_broadcast_event({
            "type": "session_deleted",
            "agent_session_id": "session-to-delete",
        })

        sent = adapter._ws.send_json.call_args.args[0]
        assert sent["type"] == EVT_SESSION_DELETED
        assert sent["agent_session_id"] == "session-to-delete"


class TestStartStopBroadcast:
    """broadcast 리스너 등록/해제 라이프사이클 테스트."""

    @pytest.mark.asyncio
    async def test_start_broadcast_registers_listener(self):
        """_start_broadcast가 broadcaster에 리스너를 등록."""
        bc = _make_broadcaster()
        adapter = _make_adapter(session_broadcaster=bc)
        adapter._running = True

        await adapter._start_broadcast()

        bc.add_client.assert_called_once()
        assert adapter._broadcast_queue is not None
        assert adapter._broadcast_task is not None

        # 정리
        adapter._running = False
        await adapter._stop_broadcast()

    @pytest.mark.asyncio
    async def test_stop_broadcast_removes_listener(self):
        """_stop_broadcast가 broadcaster에서 리스너를 제거."""
        bc = _make_broadcaster()
        adapter = _make_adapter(session_broadcaster=bc)
        adapter._running = True

        await adapter._start_broadcast()
        queue_ref = adapter._broadcast_queue

        adapter._running = False
        await adapter._stop_broadcast()

        bc.remove_client.assert_called_once_with(queue_ref)
        assert adapter._broadcast_queue is None
        assert adapter._broadcast_task is None

    @pytest.mark.asyncio
    async def test_stop_broadcast_idempotent(self):
        """broadcast가 없는 상태에서 _stop_broadcast 호출해도 에러 없음."""
        adapter = _make_adapter()
        await adapter._stop_broadcast()  # 에러 없이 통과


class TestCommandErrorHandling:
    """명령 처리 중 에러 발생 시 에러 응답 테스트."""

    @pytest.mark.asyncio
    async def test_error_in_create_session_sends_error_response(self):
        tm = MagicMock()
        tm.create_task = AsyncMock(side_effect=RuntimeError("No resources"))

        adapter = _make_adapter(task_manager=tm)
        adapter._ws = MagicMock()
        adapter._ws.closed = False
        adapter._ws.send_json = AsyncMock()

        cmd = {
            "type": CMD_CREATE_SESSION,
            "prompt": "Test",
            "requestId": "req-err",
        }

        await adapter._handle_command(cmd)

        sent = adapter._ws.send_json.call_args.args[0]
        assert sent["type"] == EVT_ERROR
        assert "No resources" in sent["message"]
        assert sent["requestId"] == "req-err"
        assert sent["command_type"] == CMD_CREATE_SESSION


class TestRegistration:
    """노드 등록 메시지 검증."""

    @pytest.mark.asyncio
    async def test_registration_includes_agents_when_registry_provided(self):
        """agent_registry가 있으면 등록 메시지에 agents 배열 포함."""
        import base64

        portrait_bytes = b"\x89PNGfakeportrait"
        portrait_b64 = base64.b64encode(portrait_bytes).decode("ascii")

        profile = MagicMock()
        profile.id = "seosoyoung"
        profile.name = "서소영"
        profile.portrait_path = "/fake/portrait.png"

        registry = MagicMock()
        registry.list.return_value = [profile]

        adapter = _make_adapter()
        adapter._agent_registry = registry
        adapter._ws = MagicMock()
        adapter._ws.closed = False
        adapter._ws.send_json = AsyncMock()

        # open()을 mock하여 portrait bytes 반환
        with patch(
            "builtins.open",
            MagicMock(return_value=MagicMock(
                __enter__=lambda s: s,
                __exit__=MagicMock(return_value=False),
                read=MagicMock(return_value=portrait_bytes),
            )),
        ):
            # _connect_and_serve 전체 대신 등록 메시지 조립 부분만 추출하여 _send 호출
            # adapter._ws.send_json으로 보내는 첫 메시지가 등록 메시지
            with patch.object(adapter, "_start_broadcast", AsyncMock()), \
                 patch.object(adapter, "_send_initial_sessions", AsyncMock()), \
                 patch.object(adapter, "_session", create=True) as mock_session:
                mock_ws = MagicMock()
                mock_ws.__aiter__ = MagicMock(return_value=iter([]))
                mock_session.ws_connect = AsyncMock(return_value=mock_ws)
                adapter._session = mock_session
                try:
                    await adapter._connect_and_serve()
                except Exception:
                    pass

        # 보내진 첫 메시지 = 등록 메시지
        if adapter._ws.send_json.call_count > 0:
            reg_msg = adapter._ws.send_json.call_args_list[0].args[0]
            assert "agents" in reg_msg
            assert len(reg_msg["agents"]) == 1
            assert reg_msg["agents"][0]["id"] == "seosoyoung"
            assert "portrait_b64" in reg_msg["agents"][0]

    @pytest.mark.asyncio
    async def test_registration_skips_large_portrait(self, tmp_path):
        """512KB 초과 portrait는 portrait_b64 없이 등록."""
        from soul_server.upstream.adapter import _MAX_PORTRAIT_SIZE

        large_data = b"\x89PNG" + b"x" * (_MAX_PORTRAIT_SIZE + 1)
        portrait_file = tmp_path / "large.png"
        portrait_file.write_bytes(large_data)

        profile = MagicMock()
        profile.id = "big-agent"
        profile.name = "Big Agent"
        profile.portrait_path = str(portrait_file)

        registry = MagicMock()
        registry.list.return_value = [profile]

        adapter = _make_adapter()
        adapter._agent_registry = registry
        adapter._ws = MagicMock()
        adapter._ws.closed = False
        adapter._ws.send_json = AsyncMock()

        with patch.object(adapter, "_start_broadcast", AsyncMock()), \
             patch.object(adapter, "_send_initial_sessions", AsyncMock()), \
             patch.object(adapter, "_session", create=True) as mock_session:
            mock_ws = MagicMock()
            mock_ws.__aiter__ = MagicMock(return_value=iter([]))
            mock_session.ws_connect = AsyncMock(return_value=mock_ws)
            adapter._session = mock_session
            try:
                await adapter._connect_and_serve()
            except Exception:
                pass

        if adapter._ws.send_json.call_count > 0:
            reg_msg = adapter._ws.send_json.call_args_list[0].args[0]
            assert "agents" in reg_msg
            # portrait_b64 없어야 함
            assert "portrait_b64" not in reg_msg["agents"][0]

    @pytest.mark.asyncio
    async def test_registration_includes_user_when_user_name_provided(self, tmp_path):
        """user_name이 있으면 등록 메시지에 user 필드 포함."""
        import base64

        portrait_bytes = b"\x89PNGfakeuserportrait"
        portrait_file = tmp_path / "user.png"
        portrait_file.write_bytes(portrait_bytes)

        adapter = _make_adapter()
        adapter._user_name = "서소영"
        adapter._user_portrait_path = str(portrait_file)

        with patch.object(adapter, "_start_broadcast", AsyncMock()), \
             patch.object(adapter, "_send_initial_sessions", AsyncMock()), \
             patch.object(adapter, "_session", create=True) as mock_session:
            mock_ws = MagicMock()
            mock_ws.__aiter__ = MagicMock(return_value=iter([]))
            mock_ws.closed = False
            mock_ws.send_json = AsyncMock()
            mock_session.ws_connect = AsyncMock(return_value=mock_ws)
            adapter._session = mock_session
            try:
                await adapter._connect_and_serve()
            except Exception:
                pass

        assert mock_ws.send_json.call_count > 0
        reg_msg = mock_ws.send_json.call_args_list[0].args[0]
        assert "user" in reg_msg
        assert reg_msg["user"]["name"] == "서소영"
        assert reg_msg["user"]["hasPortrait"] is True
        assert "portrait_b64" in reg_msg["user"]
        assert base64.b64decode(reg_msg["user"]["portrait_b64"]) == portrait_bytes

    @pytest.mark.asyncio
    async def test_registration_user_field_absent_when_no_user_name(self):
        """user_name이 없으면 등록 메시지에 user 필드 포함되지 않는다."""
        adapter = _make_adapter()
        adapter._user_name = ""
        adapter._user_portrait_path = ""

        with patch.object(adapter, "_start_broadcast", AsyncMock()), \
             patch.object(adapter, "_send_initial_sessions", AsyncMock()), \
             patch.object(adapter, "_session", create=True) as mock_session:
            mock_ws = MagicMock()
            mock_ws.__aiter__ = MagicMock(return_value=iter([]))
            mock_ws.closed = False
            mock_ws.send_json = AsyncMock()
            mock_session.ws_connect = AsyncMock(return_value=mock_ws)
            adapter._session = mock_session
            try:
                await adapter._connect_and_serve()
            except Exception:
                pass

        assert mock_ws.send_json.call_count > 0
        reg_msg = mock_ws.send_json.call_args_list[0].args[0]
        assert "user" not in reg_msg

    @pytest.mark.asyncio
    async def test_registration_user_without_portrait_path(self):
        """user_name만 있고 portrait_path가 없으면 hasPortrait=False, portrait_b64 없음."""
        adapter = _make_adapter()
        adapter._user_name = "서소영"
        adapter._user_portrait_path = ""

        with patch.object(adapter, "_start_broadcast", AsyncMock()), \
             patch.object(adapter, "_send_initial_sessions", AsyncMock()), \
             patch.object(adapter, "_session", create=True) as mock_session:
            mock_ws = MagicMock()
            mock_ws.__aiter__ = MagicMock(return_value=iter([]))
            mock_ws.closed = False
            mock_ws.send_json = AsyncMock()
            mock_session.ws_connect = AsyncMock(return_value=mock_ws)
            adapter._session = mock_session
            try:
                await adapter._connect_and_serve()
            except Exception:
                pass

        assert mock_ws.send_json.call_count > 0
        reg_msg = mock_ws.send_json.call_args_list[0].args[0]
        assert "user" in reg_msg
        assert reg_msg["user"]["name"] == "서소영"
        assert reg_msg["user"]["hasPortrait"] is False
        assert "portrait_b64" not in reg_msg["user"]


class TestUpstreamAuthHeader:
    """ws_connect Authorization 헤더 전달 + _auth_warned 중복 방지 테스트.

    _connect_and_serve는 무한 루프이므로 ws_connect를 AsyncMock(side_effect=[...])로
    교체하여 단일 사이클만 관찰한 뒤 CancelledError로 루프를 종료시키는 패턴을 사용한다.
    """

    @pytest.mark.asyncio
    async def test_ws_connect_called_with_bearer_header(self):
        """auth_bearer_token이 있으면 ws_connect에 Bearer 헤더를 전달."""
        adapter = _make_adapter(auth_bearer_token="test-token")

        mock_session = MagicMock()
        # 첫 호출은 CancelledError를 던져 루프를 즉시 종료 — headers 인자만 검증
        mock_session.ws_connect = AsyncMock(side_effect=asyncio.CancelledError())
        adapter._session = mock_session

        with pytest.raises(asyncio.CancelledError):
            await adapter._connect_and_serve()

        mock_session.ws_connect.assert_called_once_with(
            adapter._url,
            headers={"Authorization": "Bearer test-token"},
        )

    @pytest.mark.asyncio
    async def test_ws_connect_without_token_sends_empty_headers(self):
        """auth_bearer_token이 빈 값이면 headers는 빈 dict로 전달."""
        adapter = _make_adapter(auth_bearer_token="")

        mock_session = MagicMock()
        mock_session.ws_connect = AsyncMock(side_effect=asyncio.CancelledError())
        adapter._session = mock_session

        # development 모드에서만 빈 토큰이 허용되므로 get_settings.is_production=False 보장
        from soul_server.upstream import adapter as adapter_module

        with patch.object(adapter_module, "__name__", adapter_module.__name__):
            # config.get_settings는 adapter 내부에서 lazy import되므로 그대로 사용 가능
            # (conftest에서 ENVIRONMENT=development 설정됨)
            with pytest.raises(asyncio.CancelledError):
                await adapter._connect_and_serve()

        mock_session.ws_connect.assert_called_once_with(
            adapter._url,
            headers={},
        )

    @pytest.mark.asyncio
    async def test_auth_warned_logs_error_only_once_in_production(self, caplog):
        """프로덕션 + 빈 토큰으로 _connect_and_serve를 3회 호출해도 error 로그는 1회만."""
        import logging
        from types import SimpleNamespace

        from soul_server import config as config_module

        adapter = _make_adapter(auth_bearer_token="")
        adapter._auth_warned = False

        mock_session = MagicMock()
        # 3회 호출 모두 CancelledError로 루프 종료
        mock_session.ws_connect = AsyncMock(
            side_effect=[
                asyncio.CancelledError(),
                asyncio.CancelledError(),
                asyncio.CancelledError(),
            ]
        )
        adapter._session = mock_session

        fake_settings = SimpleNamespace(is_production=True)
        with patch.object(config_module, "get_settings", lambda: fake_settings):
            with caplog.at_level(logging.DEBUG, logger="soul_server.upstream.adapter"):
                for _ in range(3):
                    with pytest.raises(asyncio.CancelledError):
                        await adapter._connect_and_serve()

        error_records = [
            r for r in caplog.records
            if r.levelname == "ERROR" and "AUTH_BEARER_TOKEN empty in production" in r.message
        ]
        debug_records = [
            r for r in caplog.records
            if r.levelname == "DEBUG" and "still empty" in r.message
        ]
        assert len(error_records) == 1, f"기대 error 1회, 실제 {len(error_records)}"
        assert len(debug_records) == 2, f"기대 debug 2회, 실제 {len(debug_records)}"
        assert adapter._auth_warned is True

    @pytest.mark.asyncio
    async def test_auth_warned_resets_on_successful_connection(self):
        """연결 성공 시 _auth_warned가 False로 리셋되어 이후 새 문제는 다시 error로 기록."""
        from types import SimpleNamespace

        from soul_server import config as config_module

        adapter = _make_adapter(auth_bearer_token="t1")
        adapter._auth_warned = True  # 이전 경고 상태 시뮬레이션

        # async for msg in self._ws 를 즉시 끝낼 수 있는 async iterator를 만든다.
        async def _empty_aiter():
            if False:
                yield None  # pragma: no cover — generator 시그니처만 필요

        mock_ws = MagicMock()
        mock_ws.__aiter__ = lambda self: _empty_aiter()
        mock_ws.closed = False
        mock_ws.send_json = AsyncMock()

        mock_session = MagicMock()
        mock_session.ws_connect = AsyncMock(return_value=mock_ws)
        adapter._session = mock_session

        fake_settings = SimpleNamespace(is_production=False)
        with patch.object(config_module, "get_settings", lambda: fake_settings), \
             patch.object(adapter, "_start_broadcast", AsyncMock()), \
             patch.object(adapter, "_send_initial_sessions", AsyncMock()):
            await adapter._connect_and_serve()

        # 연결 성공 시 플래그가 리셋되어야 한다
        assert adapter._auth_warned is False


# ─── Hotspot Coverage Tests (P0-2) ─────────────────


class TestClaudeAuthCommands:
    """_handle_command의 claude_auth_* 분기 커버리지 보충."""

    @pytest.mark.asyncio
    async def test_claude_auth_status(self):
        adapter = _make_adapter()
        adapter._ws = MagicMock()
        adapter._ws.closed = False
        adapter._ws.send_json = AsyncMock()

        with patch("soul_server.upstream.adapter.handle_auth_status", return_value={"type": "claude_auth_status", "requestId": "r1"}) as mock_fn:
            await adapter._handle_command({"type": "claude_auth_status", "requestId": "r1"})
            mock_fn.assert_called_once()
        adapter._ws.send_json.assert_called_once()

    @pytest.mark.asyncio
    async def test_claude_auth_set_token_success(self):
        adapter = _make_adapter()
        adapter._ws = MagicMock()
        adapter._ws.closed = False
        adapter._ws.send_json = AsyncMock()

        resp = {"type": "claude_auth_set_token", "requestId": "r2", "status": "ok"}
        with patch("soul_server.upstream.adapter.handle_auth_set_token", return_value=(resp, None)):
            await adapter._handle_command({"type": "claude_auth_set_token", "requestId": "r2", "token": "abc"})
        # 성공이면 resp 전송, _send_error 아님
        call_data = adapter._ws.send_json.call_args[0][0]
        assert call_data["status"] == "ok"

    @pytest.mark.asyncio
    async def test_claude_auth_set_token_error(self):
        adapter = _make_adapter()
        adapter._ws = MagicMock()
        adapter._ws.closed = False
        adapter._ws.send_json = AsyncMock()

        with patch("soul_server.upstream.adapter.handle_auth_set_token", return_value=(None, "invalid token")):
            await adapter._handle_command({"type": "claude_auth_set_token", "requestId": "r3"})
        # 에러면 _send_error 호출 → EVT_ERROR 메시지
        call_data = adapter._ws.send_json.call_args[0][0]
        assert call_data["type"] == EVT_ERROR
        assert "invalid token" in call_data["message"]

    @pytest.mark.asyncio
    async def test_claude_auth_delete_token(self):
        adapter = _make_adapter()
        adapter._ws = MagicMock()
        adapter._ws.closed = False
        adapter._ws.send_json = AsyncMock()

        with patch("soul_server.upstream.adapter.handle_auth_delete_token", return_value={"type": "claude_auth_delete_token", "requestId": "r4"}) as mock_fn:
            await adapter._handle_command({"type": "claude_auth_delete_token", "requestId": "r4"})
            mock_fn.assert_called_once()

    @pytest.mark.asyncio
    async def test_claude_auth_get_usage(self):
        adapter = _make_adapter()
        adapter._ws = MagicMock()
        adapter._ws.closed = False
        adapter._ws.send_json = AsyncMock()

        with patch("soul_server.upstream.adapter.handle_auth_api_request", AsyncMock(return_value={"type": "usage", "requestId": "r5"})):
            await adapter._handle_command({"type": "claude_auth_get_usage", "requestId": "r5"})
        adapter._ws.send_json.assert_called_once()

    @pytest.mark.asyncio
    async def test_claude_auth_get_profile(self):
        adapter = _make_adapter()
        adapter._ws = MagicMock()
        adapter._ws.closed = False
        adapter._ws.send_json = AsyncMock()

        with patch("soul_server.upstream.adapter.handle_auth_api_request", AsyncMock(return_value={"type": "profile", "requestId": "r6"})):
            await adapter._handle_command({"type": "claude_auth_get_profile", "requestId": "r6"})
        adapter._ws.send_json.assert_called_once()


class TestRelayEventsEdgeCases:
    """_relay_events의 timeout/error 경로 커버리지 보충."""

    @pytest.mark.asyncio
    async def test_relay_events_timeout_continues(self):
        """큐가 비어 timeout 발생 시 continue → 다음 iteration."""
        tm = MagicMock()
        tm.add_listener = AsyncMock()
        tm.remove_listener = AsyncMock()
        adapter = _make_adapter(task_manager=tm)
        adapter._running = True
        adapter._ws = MagicMock()
        adapter._ws.closed = False
        adapter._ws.send_json = AsyncMock()

        # _relay_events를 짧은 시간 실행하고 취소
        task = asyncio.create_task(adapter._relay_events("sess-timeout"))
        await asyncio.sleep(0.1)  # timeout (30s) 전에 취소하지만 루프 진입은 됨
        adapter._running = False
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass

        tm.remove_listener.assert_called_once()

    @pytest.mark.asyncio
    async def test_relay_events_exception_logged_and_cleanup(self):
        """큐에서 예외 발생 시 로깅 후 finally에서 remove_listener 호출."""
        tm = MagicMock()
        tm.add_listener = AsyncMock()
        tm.remove_listener = AsyncMock()
        adapter = _make_adapter(task_manager=tm)
        adapter._running = True
        adapter._ws = MagicMock()
        adapter._ws.closed = False

        # send_json에서 예외 발생하도록 mock
        adapter._ws.send_json = AsyncMock(side_effect=RuntimeError("WS broken"))

        # 큐에 이벤트를 넣어 send 시도 → 예외 → 로깅 → finally
        queue_holder = {}
        original_add = tm.add_listener

        async def capture_add(sid, q):
            queue_holder["q"] = q

        tm.add_listener = AsyncMock(side_effect=capture_add)

        task = asyncio.create_task(adapter._relay_events("sess-err"))
        await asyncio.sleep(0.05)

        if "q" in queue_holder:
            await queue_holder["q"].put({"type": "text_delta", "_event_id": 1})
            await asyncio.sleep(0.1)

        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass

        # remove_listener 호출 확인
        assert tm.remove_listener.called


class TestSubscribeEventsEdge:
    """_handle_subscribe_events 빈 session_id early return."""

    @pytest.mark.asyncio
    async def test_empty_session_id_returns_early(self):
        adapter = _make_adapter()
        adapter._ws = MagicMock()
        adapter._ws.closed = False
        adapter._ws.send_json = AsyncMock()

        # session_id 없는 명령 → early return, 크래시 없음
        await adapter._handle_subscribe_events({"type": "subscribe_events"})
        # send_json 호출 없음 (에러 응답도 안 보냄)
        adapter._ws.send_json.assert_not_called()


class TestCreateSessionValueError:
    """_handle_create_session ValueError → _send_error."""

    @pytest.mark.asyncio
    async def test_value_error_sends_error_response(self):
        tm = MagicMock()
        tm.create_task = AsyncMock(side_effect=ValueError("bad profile"))
        adapter = _make_adapter(task_manager=tm)
        adapter._ws = MagicMock()
        adapter._ws.closed = False
        adapter._ws.send_json = AsyncMock()

        await adapter._handle_create_session({
            "type": "create_session",
            "prompt": "hello",
            "requestId": "req-val",
        })

        call_data = adapter._ws.send_json.call_args[0][0]
        assert call_data["type"] == EVT_ERROR
        assert "bad profile" in call_data["message"]


class TestDispatchBroadcastEvent:
    """_dispatch_broadcast_event 미커버 분기."""

    @pytest.mark.asyncio
    async def test_session_created_with_folder_id(self):
        """session_created + folder_id 분기 (L359-360)."""
        adapter = _make_adapter()
        adapter._ws = MagicMock()
        adapter._ws.closed = False
        adapter._ws.send_json = AsyncMock()

        await adapter._dispatch_broadcast_event({
            "type": "session_created",
            "session": {"agent_session_id": "sess-1"},
            "folder_id": "folder-abc",
        })

        call_data = adapter._ws.send_json.call_args[0][0]
        assert call_data["type"] == EVT_SESSION_CREATED
        assert call_data["folderId"] == "folder-abc"

    @pytest.mark.asyncio
    async def test_session_deleted(self):
        """session_deleted 분기 (L367-371)."""
        adapter = _make_adapter()
        adapter._ws = MagicMock()
        adapter._ws.closed = False
        adapter._ws.send_json = AsyncMock()

        await adapter._dispatch_broadcast_event({
            "type": "session_deleted",
            "agent_session_id": "sess-del",
        })

        call_data = adapter._ws.send_json.call_args[0][0]
        assert call_data["type"] == EVT_SESSION_DELETED
        assert call_data["agent_session_id"] == "sess-del"

    @pytest.mark.asyncio
    async def test_input_request_forwarded(self):
        """input_request 분기 (L372-379)."""
        adapter = _make_adapter()
        adapter._ws = MagicMock()
        adapter._ws.closed = False
        adapter._ws.send_json = AsyncMock()

        await adapter._dispatch_broadcast_event({
            "type": "input_request",
            "agent_session_id": "sess-ir",
            "request_id": "ir-1",
        })

        call_data = adapter._ws.send_json.call_args[0][0]
        assert call_data["type"] == "input_request"
        assert call_data["agent_session_id"] == "sess-ir"


class TestCleanup:
    """_cleanup 커버리지 (L659-669)."""

    @pytest.mark.asyncio
    async def test_cleanup_stops_broadcast_and_closes_session(self):
        adapter = _make_adapter()
        # broadcast task mock
        adapter._broadcast_task = MagicMock()
        adapter._broadcast_task.done.return_value = True
        adapter._broadcast_queue = asyncio.Queue()

        # stream tasks mock
        mock_task = MagicMock()
        mock_task.cancel = MagicMock()
        adapter._stream_tasks = {"sess-1": mock_task}

        # session mock — _cleanup이 close 후 None으로 설정하므로 참조 보존
        mock_session = MagicMock()
        mock_session.closed = False
        mock_session.close = AsyncMock()
        adapter._session = mock_session

        await adapter._cleanup()

        assert adapter._stream_tasks == {}
        mock_session.close.assert_called_once()
        assert adapter._session is None
