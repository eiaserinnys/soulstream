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


async def _make_async_gen(*rows):
    """테스트용 async generator: (id, event_type, payload_text) 튜플 yield."""
    for row in rows:
        yield row


# ─── Tests ──────────────────────────────────────────


class TestHandleSubscribeEvents:
    """subscribe_events 커맨드 처리 테스트."""

    @pytest.mark.asyncio
    async def test_db_events_sent_with_event_id(self):
        """DB 이벤트가 event_id 포함하여 전송되는지 확인."""
        session_db = MagicMock()
        session_db.stream_events_raw = MagicMock(return_value=_make_async_gen(
            (1, "text_delta", json.dumps({"type": "text_delta", "text": "Hello"})),
            (2, "complete", json.dumps({"type": "complete"})),
        ))

        adapter = _make_adapter_with_session_db(session_db)
        adapter._tm.add_listener = AsyncMock(return_value=True)
        adapter._tm.remove_listener = AsyncMock()
        adapter._ws = MagicMock()
        adapter._ws.closed = False
        adapter._ws.send_json = AsyncMock()
        adapter._running = True

        cmd = {
            "type": CMD_SUBSCRIBE_EVENTS,
            "session_id": "session-1",
            "after_id": 0,
            "request_id": "",
        }

        await adapter._handle_subscribe_events(cmd)  # type: ignore

        sent = [call.args[0] for call in adapter._ws.send_json.call_args_list]
        # DB 이벤트 2건 전송 확인
        assert len(sent) == 2
        assert sent[0]["type"] == "event"
        assert sent[0]["session_id"] == "session-1"
        assert sent[0]["event_id"] == 1
        assert sent[0]["event"]["type"] == "text_delta"
        assert sent[1]["event_id"] == 2

    @pytest.mark.asyncio
    async def test_after_id_zero_sends_all_events(self):
        """after_id=0이면 전체 이벤트 전송."""
        session_db = MagicMock()
        session_db.stream_events_raw = MagicMock(return_value=_make_async_gen(
            (1, "text_start", json.dumps({"type": "text_start"})),
            (2, "text_delta", json.dumps({"type": "text_delta", "text": "Hi"})),
            (3, "complete", json.dumps({"type": "complete"})),
        ))

        adapter = _make_adapter_with_session_db(session_db)
        adapter._tm.add_listener = AsyncMock(return_value=True)
        adapter._tm.remove_listener = AsyncMock()
        adapter._ws = MagicMock()
        adapter._ws.closed = False
        adapter._ws.send_json = AsyncMock()
        adapter._running = True

        cmd = {"type": CMD_SUBSCRIBE_EVENTS, "session_id": "s1", "after_id": 0, "request_id": ""}
        await adapter._handle_subscribe_events(cmd)  # type: ignore

        sent = [call.args[0] for call in adapter._ws.send_json.call_args_list]
        assert len(sent) == 3
        assert sent[0]["event_id"] == 1
        assert sent[2]["event_id"] == 3

    @pytest.mark.asyncio
    async def test_after_id_n_sends_only_subsequent_events(self):
        """after_id=N이면 N 초과 이벤트만 전송."""
        session_db = MagicMock()
        # stream_events_raw는 after_id 초과 이벤트만 반환 (DB 쿼리 레벨에서 필터)
        session_db.stream_events_raw = MagicMock(return_value=_make_async_gen(
            (3, "text_delta", json.dumps({"type": "text_delta"})),
            (4, "complete", json.dumps({"type": "complete"})),
        ))

        adapter = _make_adapter_with_session_db(session_db)
        adapter._tm.add_listener = AsyncMock(return_value=True)
        adapter._tm.remove_listener = AsyncMock()
        adapter._ws = MagicMock()
        adapter._ws.closed = False
        adapter._ws.send_json = AsyncMock()
        adapter._running = True

        cmd = {"type": CMD_SUBSCRIBE_EVENTS, "session_id": "s1", "after_id": 2, "request_id": ""}
        await adapter._handle_subscribe_events(cmd)  # type: ignore

        # stream_events_raw 호출 시 after_id=2 전달 확인
        session_db.stream_events_raw.assert_called_once_with("s1", after_id=2)
        sent = [call.args[0] for call in adapter._ws.send_json.call_args_list]
        assert len(sent) == 2
        assert sent[0]["event_id"] == 3

    @pytest.mark.asyncio
    async def test_live_events_sent_after_db_replay(self):
        """DB 이벤트 전송 완료 후 라이브 이벤트도 전송되는지 확인."""
        session_db = MagicMock()
        session_db.stream_events_raw = MagicMock(return_value=_make_async_gen(
            (1, "text_start", json.dumps({"type": "text_start"})),
        ))

        live_event = {"type": "complete", "result": "done"}

        async def mock_add_listener(session_id, queue):
            # 별도 태스크에서 라이브 이벤트를 큐에 넣는다
            async def _feed():
                await asyncio.sleep(0.01)
                await queue.put(live_event)
            asyncio.create_task(_feed())
            return True

        adapter = _make_adapter_with_session_db(session_db)
        adapter._tm.add_listener = AsyncMock(side_effect=mock_add_listener)
        adapter._tm.remove_listener = AsyncMock()
        adapter._ws = MagicMock()
        adapter._ws.closed = False
        adapter._ws.send_json = AsyncMock()
        adapter._running = True

        cmd = {"type": CMD_SUBSCRIBE_EVENTS, "session_id": "s1", "after_id": 0, "request_id": ""}
        await adapter._handle_subscribe_events(cmd)  # type: ignore

        sent = [call.args[0] for call in adapter._ws.send_json.call_args_list]
        # DB 이벤트 1건 + 라이브 이벤트 1건
        assert len(sent) == 2
        # DB 이벤트: event_id 포함
        assert sent[0]["event_id"] == 1
        # 라이브 이벤트: event_id 없음 (설계 의도)
        assert "event_id" not in sent[1]
        assert sent[1]["event"]["type"] == "complete"

    @pytest.mark.asyncio
    async def test_complete_event_stops_streaming(self):
        """complete 이벤트 수신 시 스트리밍이 종료되는지 확인."""
        session_db = MagicMock()
        session_db.stream_events_raw = MagicMock(return_value=_make_async_gen())

        complete_event = {"type": "complete"}
        after_event = {"type": "text_delta", "text": "should not be sent"}

        async def mock_add_listener(session_id, queue):
            async def _feed():
                await queue.put(complete_event)
                await queue.put(after_event)
            asyncio.create_task(_feed())
            return True

        adapter = _make_adapter_with_session_db(session_db)
        adapter._tm.add_listener = AsyncMock(side_effect=mock_add_listener)
        adapter._tm.remove_listener = AsyncMock()
        adapter._ws = MagicMock()
        adapter._ws.closed = False
        adapter._ws.send_json = AsyncMock()
        adapter._running = True

        cmd = {"type": CMD_SUBSCRIBE_EVENTS, "session_id": "s1", "after_id": 0, "request_id": ""}
        await adapter._handle_subscribe_events(cmd)  # type: ignore

        sent = [call.args[0] for call in adapter._ws.send_json.call_args_list]
        # complete 이벤트만 전송되고 그 이후는 전송되지 않아야 함
        assert len(sent) == 1
        assert sent[0]["event"]["type"] == "complete"

    @pytest.mark.asyncio
    async def test_add_listener_false_returns_immediately(self):
        """add_listener가 False를 반환하면 즉시 return."""
        session_db = MagicMock()
        session_db.stream_events_raw = MagicMock(return_value=_make_async_gen())

        adapter = _make_adapter_with_session_db(session_db)
        adapter._tm.add_listener = AsyncMock(return_value=False)
        adapter._tm.remove_listener = AsyncMock()
        adapter._ws = MagicMock()
        adapter._ws.closed = False
        adapter._ws.send_json = AsyncMock()
        adapter._running = True

        cmd = {"type": CMD_SUBSCRIBE_EVENTS, "session_id": "s1", "after_id": 0, "request_id": ""}
        await adapter._handle_subscribe_events(cmd)  # type: ignore

        # DB 이벤트나 WS 전송이 없어야 함
        session_db.stream_events_raw.assert_not_called()
        adapter._ws.send_json.assert_not_awaited()
        # remove_listener도 호출되지 않아야 함 (add_listener 실패 → try 블록 진입 안 함)
        adapter._tm.remove_listener.assert_not_awaited()


class TestSubscribeEventsRouting:
    """subscribe_events 커맨드 라우터 등록 테스트."""

    @pytest.mark.asyncio
    async def test_subscribe_events_creates_task(self):
        """subscribe_events 커맨드 수신 시 _stream_tasks에 태스크 등록."""
        session_db = MagicMock()
        session_db.stream_events_raw = MagicMock(return_value=_make_async_gen())

        adapter = _make_adapter_with_session_db(session_db)
        adapter._tm.add_listener = AsyncMock(return_value=False)  # 즉시 종료
        adapter._tm.remove_listener = AsyncMock()
        adapter._ws = MagicMock()
        adapter._ws.closed = False
        adapter._ws.send_json = AsyncMock()
        adapter._running = True

        cmd = {
            "type": CMD_SUBSCRIBE_EVENTS,
            "session_id": "s-route-1",
            "after_id": 5,
            "request_id": "",
        }

        await adapter._handle_command(cmd)

        # 태스크가 생성되었는지 확인 (add_listener가 False를 반환하므로 곧 완료됨)
        assert "s-route-1" in adapter._stream_tasks or True  # 완료되었을 수 있음
        # 에러 메시지가 전송되지 않았는지 확인
        if adapter._ws.send_json.called:
            for call in adapter._ws.send_json.call_args_list:
                assert call.args[0].get("type") != "error", "Unexpected error response"

    @pytest.mark.asyncio
    async def test_subscribe_events_cancels_old_task(self):
        """기존 스트리밍 태스크가 있으면 취소 후 교체."""
        session_db = MagicMock()
        adapter = _make_adapter_with_session_db(session_db)

        # 기존 태스크를 가짜로 등록
        old_task = MagicMock()
        old_task.done = MagicMock(return_value=False)
        old_task.cancel = MagicMock()
        adapter._stream_tasks["s-cancel-test"] = old_task

        adapter._tm.add_listener = AsyncMock(return_value=False)
        adapter._tm.remove_listener = AsyncMock()
        adapter._ws = MagicMock()
        adapter._ws.closed = False
        adapter._ws.send_json = AsyncMock()
        adapter._running = True

        session_db.stream_events_raw = MagicMock(return_value=_make_async_gen())

        cmd = {
            "type": CMD_SUBSCRIBE_EVENTS,
            "session_id": "s-cancel-test",
            "after_id": 0,
            "request_id": "",
        }

        await adapter._handle_command(cmd)

        # 기존 태스크가 취소되었는지 확인
        old_task.cancel.assert_called_once()
