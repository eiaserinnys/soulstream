"""UpstreamAdapter subscribe_events 커맨드 단위 테스트."""

import asyncio
import json
from unittest.mock import AsyncMock, MagicMock

import pytest

from soul_server.upstream.adapter import UpstreamAdapter
from soul_server.upstream.protocol import CMD_SUBSCRIBE_EVENTS


# ─── Helpers ──────────────────────────────────────────


def _make_adapter_with_session_db(session_db: MagicMock) -> UpstreamAdapter:
    """session_db를 명시적으로 주입한 UpstreamAdapter."""
    tm = MagicMock()
    rm = MagicMock()
    rm.max_concurrent = 3
    rm.get_stats.return_value = {}
    bc = MagicMock()
    bc.add_listener = AsyncMock()
    bc.remove_listener = AsyncMock()

    return UpstreamAdapter(
        task_manager=tm,
        soul_engine=MagicMock(),
        resource_manager=rm,
        session_broadcaster=bc,
        upstream_url="ws://localhost:5200/ws/node",
        node_id="test-node",
        session_db=session_db,
        host="localhost",
        port=3105,
    )


# ─── Tests ──────────────────────────────────────────


class TestHandleSubscribeEvents:
    """subscribe_events 커맨드 처리 테스트.

    _handle_subscribe_events는 라이브 이벤트만 relay한다.
    DB 재생은 soulstream-server(sessions.py)가 수행하므로 여기서는 생략.
    """

    @pytest.mark.asyncio
    async def test_live_events_sent_with_agent_session_id(self):
        """라이브 이벤트가 agentSessionId 포함하여 전송되는지 확인."""
        session_db = MagicMock()

        live_events = [
            {"type": "text_delta", "text": "Hello"},
            {"type": "complete"},
            None,  # 세션 종료 센티넬 — complete 이후에도 계속 실행되므로 명시적 종료 필요
        ]

        async def mock_add_listener(session_id, queue):
            async def _feed():
                for e in live_events:
                    await queue.put(e)
            asyncio.create_task(_feed())

        adapter = _make_adapter_with_session_db(session_db)
        adapter._tm.add_listener = AsyncMock(side_effect=mock_add_listener)
        adapter._tm.remove_listener = AsyncMock()
        adapter._ws = MagicMock()
        adapter._ws.closed = False
        adapter._ws.send_json = AsyncMock()
        adapter._running = True

        cmd = {
            "type": CMD_SUBSCRIBE_EVENTS,
            "agentSessionId": "session-1",
        }

        await adapter._handle_subscribe_events(cmd)

        sent = [call.args[0] for call in adapter._ws.send_json.call_args_list]
        # None 센티넬 이전의 이벤트 2개만 전송
        assert len(sent) == 2
        assert sent[0]["type"] == "event"
        assert sent[0]["agentSessionId"] == "session-1"
        assert sent[0]["event"]["type"] == "text_delta"
        assert sent[1]["event"]["type"] == "complete"

    @pytest.mark.asyncio
    async def test_complete_event_does_not_stop_streaming(self):
        """complete 이벤트 수신 후에도 스트리밍이 종료되지 않는다.

        세션이 complete된 후 새 turn이 시작되면 동일 스트림으로 이벤트가 계속 전달돼야 한다.
        종료는 None 센티넬로만 이루어진다.
        """
        session_db = MagicMock()

        events = [
            {"type": "complete"},                   # turn 1 종료
            {"type": "user_message", "text": "hi"}, # turn 2 시작 — 계속 전달돼야 함
            None,                                    # 세션 종료
        ]

        async def mock_add_listener(session_id, queue):
            async def _feed():
                for e in events:
                    await queue.put(e)
            asyncio.create_task(_feed())

        adapter = _make_adapter_with_session_db(session_db)
        adapter._tm.add_listener = AsyncMock(side_effect=mock_add_listener)
        adapter._tm.remove_listener = AsyncMock()
        adapter._ws = MagicMock()
        adapter._ws.closed = False
        adapter._ws.send_json = AsyncMock()
        adapter._running = True

        cmd = {"type": CMD_SUBSCRIBE_EVENTS, "agentSessionId": "s1"}
        await adapter._handle_subscribe_events(cmd)

        sent = [call.args[0] for call in adapter._ws.send_json.call_args_list]
        # complete 이후 user_message까지 2개 전송
        assert len(sent) == 2, f"기대 2개, 실제 {len(sent)}개"
        assert sent[0]["event"]["type"] == "complete"
        assert sent[1]["event"]["type"] == "user_message"

    @pytest.mark.asyncio
    async def test_none_event_stops_streaming(self):
        """None 이벤트(세션 종료 시그널) 수신 시 스트리밍이 종료되는지 확인."""
        session_db = MagicMock()

        async def mock_add_listener(session_id, queue):
            async def _feed():
                await queue.put({"type": "text_delta", "text": "hello"})
                await queue.put(None)  # 종료 시그널
            asyncio.create_task(_feed())

        adapter = _make_adapter_with_session_db(session_db)
        adapter._tm.add_listener = AsyncMock(side_effect=mock_add_listener)
        adapter._tm.remove_listener = AsyncMock()
        adapter._ws = MagicMock()
        adapter._ws.closed = False
        adapter._ws.send_json = AsyncMock()
        adapter._running = True

        cmd = {"type": CMD_SUBSCRIBE_EVENTS, "agentSessionId": "s1"}
        await adapter._handle_subscribe_events(cmd)

        sent = [call.args[0] for call in adapter._ws.send_json.call_args_list]
        assert len(sent) == 1
        assert sent[0]["event"]["type"] == "text_delta"

        # 리스너 제거 확인
        adapter._tm.remove_listener.assert_awaited_once()


class TestSubscribeEventsRouting:
    """subscribe_events 커맨드 라우터 등록 테스트."""

    @pytest.mark.asyncio
    async def test_subscribe_events_creates_task(self):
        """subscribe_events 커맨드 수신 시 태스크가 생성된다."""
        session_db = MagicMock()

        async def mock_add_listener(session_id, queue):
            # 즉시 종료 — None 센티넬
            async def _feed():
                await queue.put(None)
            asyncio.create_task(_feed())

        adapter = _make_adapter_with_session_db(session_db)
        adapter._tm.add_listener = AsyncMock(side_effect=mock_add_listener)
        adapter._tm.remove_listener = AsyncMock()
        adapter._ws = MagicMock()
        adapter._ws.closed = False
        adapter._ws.send_json = AsyncMock()
        adapter._running = True

        cmd = {
            "type": CMD_SUBSCRIBE_EVENTS,
            "agentSessionId": "s-route-1",
        }

        await adapter._handle_command(cmd)
        # 에러 메시지가 전송되지 않았는지 확인
        if adapter._ws.send_json.called:
            for call in adapter._ws.send_json.call_args_list:
                assert call.args[0].get("type") != "error", "Unexpected error response"

    @pytest.mark.asyncio
    async def test_subscribe_events_cancels_stream_events_task(self):
        """기존 _stream_events 태스크가 실행 중이면 취소 후 _handle_subscribe_events가 인계받는다."""
        session_db = MagicMock()
        adapter = _make_adapter_with_session_db(session_db)

        # 기존 _stream_events 태스크를 실제 asyncio.Task로 등록
        async def _dummy():
            await asyncio.sleep(999)

        old_task = asyncio.create_task(_dummy())
        adapter._stream_tasks["s-cancel-test"] = old_task

        async def mock_add_listener(session_id, queue):
            async def _feed():
                await queue.put(None)
            asyncio.create_task(_feed())

        adapter._tm.add_listener = AsyncMock(side_effect=mock_add_listener)
        adapter._tm.remove_listener = AsyncMock()
        adapter._ws = MagicMock()
        adapter._ws.closed = False
        adapter._ws.send_json = AsyncMock()
        adapter._running = True

        cmd = {
            "type": CMD_SUBSCRIBE_EVENTS,
            "agentSessionId": "s-cancel-test",
        }

        await adapter._handle_command(cmd)

        # _handle_subscribe_events 태스크가 실행될 때까지 이벤트 루프를 돌린다
        for _ in range(5):
            await asyncio.sleep(0)

        # 기존 태스크에 취소 요청이 전달됐는지 확인 (cancelled() → 완전 종료, cancelling() → 취소 요청됨)
        assert old_task.cancelling() > 0 or old_task.cancelled(), \
            "기존 _stream_events 태스크에 취소 요청이 전달되지 않음"
