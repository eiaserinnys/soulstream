"""service/sse_streaming.py 단위 테스트.

format_sse_event와 stream_live_events의 동작을 검증한다.
- 한글/datetime 직렬화, _event_id 분리, has_id_field 옵션
- 큐 주입형 라이브 generator, dedup, break_on_terminal, keepalive,
  finally의 remove_listener 호출 보장
"""

from __future__ import annotations

import asyncio
import json
from datetime import datetime, timezone
import pytest

from soul_server.service.sse_streaming import format_sse_event, stream_live_events


# ============================================================================
# format_sse_event
# ============================================================================


class TestFormatSseEvent:
    def test_event_id_extracted_to_id_field(self):
        result = format_sse_event(
            {"_event_id": 42, "type": "text_delta", "delta": "hi"}
        )
        assert result["id"] == "42"
        assert result["event"] == "text_delta"
        data = json.loads(result["data"])
        assert data == {"type": "text_delta", "delta": "hi"}
        assert "_event_id" not in data

    def test_korean_serialized_without_ascii_escape(self):
        result = format_sse_event(
            {"_event_id": 1, "type": "text_delta", "delta": "안녕하세요"}
        )
        # ensure_ascii=False라야 한글 그대로 보존
        assert "안녕하세요" in result["data"]

    def test_datetime_serialized_via_default_str(self):
        ts = datetime(2026, 5, 3, 12, 0, 0, tzinfo=timezone.utc)
        result = format_sse_event(
            {"_event_id": 7, "type": "session_created", "created_at": ts}
        )
        data = json.loads(result["data"])
        # default=str로 datetime이 문자열화된다
        assert "2026-05-03" in data["created_at"]

    def test_has_id_field_false_omits_id(self):
        result = format_sse_event(
            {"_event_id": 99, "type": "history_sync", "last_event_id": 99},
            has_id_field=False,
        )
        assert "id" not in result
        assert result["event"] == "history_sync"

    def test_missing_event_id_omits_id_field(self):
        # _event_id가 없으면 id 필드 자체가 없다
        result = format_sse_event({"type": "keepalive"})
        assert "id" not in result
        assert result["event"] == "keepalive"

    def test_missing_type_defaults_unknown(self):
        result = format_sse_event({"_event_id": 1, "some": "thing"})
        assert result["event"] == "unknown"


# ============================================================================
# stream_live_events
# ============================================================================


class _FakeTaskManager:
    """테스트용 task_manager — remove_listener만 검증."""

    def __init__(self):
        self.removed: list[tuple[str, asyncio.Queue]] = []

    async def remove_listener(self, agent_session_id: str, event_queue: asyncio.Queue):
        self.removed.append((agent_session_id, event_queue))


async def _drain(gen, max_items=10, timeout=1.0):
    """generator에서 최대 max_items개를 timeout 안에 수집한다."""
    items = []
    try:
        async with asyncio.timeout(timeout):
            async for item in gen:
                items.append(item)
                if len(items) >= max_items:
                    break
    except asyncio.TimeoutError:
        pass
    return items


class TestStreamLiveEvents:
    async def test_yields_event_in_format_sse_event_shape(self):
        tm = _FakeTaskManager()
        q: asyncio.Queue = asyncio.Queue()
        await q.put({"_event_id": 1, "type": "text_delta", "delta": "x"})
        # complete로 루프 종료
        await q.put({"_event_id": 2, "type": "complete"})

        gen = stream_live_events(
            "sess-1", tm, q, break_on_terminal=True, keepalive_interval=0.5
        )
        items = await _drain(gen, max_items=5, timeout=2.0)

        # 두 이벤트 모두 wrap되어 yield됨
        assert items[0]["event"] == "text_delta"
        assert items[0]["id"] == "1"
        assert items[1]["event"] == "complete"
        assert items[1]["id"] == "2"

    async def test_keepalive_on_timeout(self):
        tm = _FakeTaskManager()
        q: asyncio.Queue = asyncio.Queue()
        # 큐에 아무것도 안 넣음 → keepalive_interval 후 keepalive 1회

        gen = stream_live_events(
            "sess-2", tm, q, break_on_terminal=False, keepalive_interval=0.05
        )
        items = await _drain(gen, max_items=2, timeout=0.5)

        # 최소 1회 이상 keepalive
        keepalives = [it for it in items if it.get("comment") == "keepalive"]
        assert len(keepalives) >= 1

    async def test_dedup_after_id_skips_old_events(self):
        tm = _FakeTaskManager()
        q: asyncio.Queue = asyncio.Queue()
        await q.put({"_event_id": 5, "type": "text_delta", "delta": "old1"})  # skip
        await q.put({"_event_id": 10, "type": "text_delta", "delta": "old2"})  # skip
        await q.put({"_event_id": 11, "type": "text_delta", "delta": "new"})  # keep
        await q.put({"_event_id": 12, "type": "complete"})

        gen = stream_live_events(
            "sess-3", tm, q,
            dedup_after_id=10,
            break_on_terminal=True,
            keepalive_interval=0.5,
        )
        items = await _drain(gen, max_items=5, timeout=2.0)

        # event_id <= 10은 모두 skip, 11과 12만 yield
        assert len(items) == 2
        assert items[0]["id"] == "11"
        assert items[1]["id"] == "12"

    async def test_break_on_terminal_true_stops_at_complete(self):
        tm = _FakeTaskManager()
        q: asyncio.Queue = asyncio.Queue()
        await q.put({"_event_id": 1, "type": "complete"})
        await q.put({"_event_id": 2, "type": "text_delta", "delta": "after"})

        gen = stream_live_events(
            "sess-4", tm, q, break_on_terminal=True, keepalive_interval=0.5
        )
        items = await _drain(gen, max_items=5, timeout=1.0)

        # complete 이후로는 더 yield하지 않음
        assert len(items) == 1
        assert items[0]["event"] == "complete"

    async def test_break_on_terminal_false_continues_after_complete(self):
        tm = _FakeTaskManager()
        q: asyncio.Queue = asyncio.Queue()
        await q.put({"_event_id": 1, "type": "complete"})
        await q.put({"_event_id": 2, "type": "text_delta", "delta": "after"})

        gen = stream_live_events(
            "sess-5", tm, q, break_on_terminal=False, keepalive_interval=0.5
        )
        items = await _drain(gen, max_items=5, timeout=1.0)

        # complete 이후에도 다음 이벤트 yield
        assert items[0]["event"] == "complete"
        assert items[1]["event"] == "text_delta"

    async def test_break_on_terminal_true_stops_at_error(self):
        tm = _FakeTaskManager()
        q: asyncio.Queue = asyncio.Queue()
        await q.put({"_event_id": 1, "type": "error", "message": "boom"})
        await q.put({"_event_id": 2, "type": "text_delta"})

        gen = stream_live_events(
            "sess-6", tm, q, break_on_terminal=True, keepalive_interval=0.5
        )
        items = await _drain(gen, max_items=5, timeout=1.0)

        assert len(items) == 1
        assert items[0]["event"] == "error"

    async def test_finally_calls_remove_listener_on_normal_completion(self):
        tm = _FakeTaskManager()
        q: asyncio.Queue = asyncio.Queue()
        await q.put({"_event_id": 1, "type": "complete"})

        gen = stream_live_events(
            "sess-7", tm, q, break_on_terminal=True, keepalive_interval=0.5
        )
        async for _ in gen:
            pass

        assert tm.removed == [("sess-7", q)]

    async def test_finally_calls_remove_listener_on_aclose(self):
        # 호출자가 break/aclose하는 경우에도 remove_listener가 호출되어야 한다.
        tm = _FakeTaskManager()
        q: asyncio.Queue = asyncio.Queue()
        await q.put({"_event_id": 1, "type": "text_delta"})

        gen = stream_live_events(
            "sess-8", tm, q, break_on_terminal=False, keepalive_interval=10.0
        )
        # 한 개만 받고 close
        async for _ in gen:
            break
        await gen.aclose()

        assert tm.removed == [("sess-8", q)]

    async def test_dedup_with_none_event_id_keeps_event(self):
        # _event_id가 없는 이벤트는 dedup_after_id가 있어도 통과 (안전한 기본값)
        tm = _FakeTaskManager()
        q: asyncio.Queue = asyncio.Queue()
        await q.put({"type": "metadata_updated"})  # _event_id 없음
        await q.put({"_event_id": 200, "type": "complete"})  # dedup_after_id 초과

        gen = stream_live_events(
            "sess-9", tm, q,
            dedup_after_id=100,
            break_on_terminal=True,
            keepalive_interval=10.0,  # keepalive 끼어들지 않도록 충분히 길게
        )
        # break_on_terminal=True + complete → 자연 종료
        items = []
        async for item in gen:
            items.append(item)

        # _event_id 없는 이벤트도 yield된다 (keepalive 없이)
        events = [it for it in items if "event" in it]
        assert events[0]["event"] == "metadata_updated"
        assert events[1]["event"] == "complete"
