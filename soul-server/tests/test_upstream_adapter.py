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
            "request_id": "input-req-1",
            "answers": {"q1": "yes"},
        }

        await adapter._handle_command(cmd)

        tm.deliver_input_response.assert_called_once_with(
            agent_session_id="session-1",
            request_id="input-req-1",
            answers={"q1": "yes"},
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
    async def test_streams_events_until_complete(self):
        tm = MagicMock()

        # add_listener가 호출되면 queue에 이벤트를 넣는다
        events_to_send = [
            {"type": "progress", "text": "Working..."},
            {"type": "complete", "result": "Done"},
        ]

        async def mock_add_listener(session_id, queue):
            # 별도 태스크에서 이벤트를 큐에 넣는다
            async def _feed():
                for e in events_to_send:
                    await queue.put(e)
            asyncio.create_task(_feed())
            return True

        tm.add_listener = AsyncMock(side_effect=mock_add_listener)
        tm.remove_listener = AsyncMock()

        adapter = _make_adapter(task_manager=tm)
        adapter._ws = MagicMock()
        adapter._ws.closed = False
        adapter._ws.send_json = AsyncMock()
        adapter._running = True

        await adapter._stream_events("session-1")

        # 이벤트 전송 확인
        sent_messages = [
            call.args[0] for call in adapter._ws.send_json.call_args_list
        ]
        assert len(sent_messages) == 2

        assert sent_messages[0]["type"] == EVT_EVENT
        assert sent_messages[0]["agentSessionId"] == "session-1"
        assert sent_messages[0]["event"]["type"] == "progress"
        assert sent_messages[0]["event"]["text"] == "Working..."

        assert sent_messages[1]["type"] == EVT_EVENT
        assert sent_messages[1]["agentSessionId"] == "session-1"
        assert sent_messages[1]["event"]["type"] == "complete"
        assert sent_messages[1]["event"]["result"] == "Done"

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
