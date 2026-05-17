"""Tests for SessionBroadcaster."""

import asyncio

import pytest

from soulstream_server.service.session_broadcaster import SessionBroadcaster


class TestBroadcast:
    """broadcast() delivers events to all subscribers."""

    async def test_broadcast_to_single_subscriber(self, broadcaster):
        """A single subscriber receives the broadcast event."""
        events = []

        async def consume():
            async for item in broadcaster.subscribe():
                _eid, event = item
                events.append(event)
                break  # consume one event then exit

        task = asyncio.create_task(consume())
        await asyncio.sleep(0.01)  # let subscribe register

        await broadcaster.broadcast({"type": "test", "data": "hello"})
        await asyncio.sleep(0.01)
        broadcaster.disconnect_all()
        await task

        assert len(events) == 1
        assert events[0] == {"type": "test", "data": "hello"}

    async def test_broadcast_to_multiple_subscribers(self, broadcaster):
        """Multiple subscribers each receive the same event."""
        results = [[], []]

        async def consume(idx):
            async for item in broadcaster.subscribe():
                _eid, event = item
                results[idx].append(event)
                break

        tasks = [asyncio.create_task(consume(i)) for i in range(2)]
        await asyncio.sleep(0.01)

        await broadcaster.broadcast({"type": "multi"})
        await asyncio.sleep(0.01)
        broadcaster.disconnect_all()
        await asyncio.gather(*tasks)

        assert all(len(r) == 1 for r in results)
        assert all(r[0]["type"] == "multi" for r in results)

    async def test_broadcast_drops_full_queue_client(self, broadcaster):
        """A client whose queue is full gets disconnected."""
        # Subscribe but never consume — queue will fill up
        queue: asyncio.Queue[tuple[int, dict] | None] = asyncio.Queue(maxsize=1)
        broadcaster._clients.append(queue)

        # Fill the queue
        await broadcaster.broadcast({"type": "fill"})
        assert queue.qsize() == 1

        # Next broadcast should detect QueueFull and remove client
        await broadcaster.broadcast({"type": "overflow"})
        assert len(broadcaster._clients) == 0


class TestEmitSessionDeleted:
    """emit_session_deleted() broadcasts a session_deleted event."""

    async def test_emit_session_deleted(self, broadcaster):
        events = []

        async def consume():
            async for item in broadcaster.subscribe():
                _eid, event = item
                events.append(event)
                break

        task = asyncio.create_task(consume())
        await asyncio.sleep(0.01)

        await broadcaster.emit_session_deleted("sess-123")
        await asyncio.sleep(0.01)
        broadcaster.disconnect_all()
        await task

        assert len(events) == 1
        assert events[0]["type"] == "session_deleted"
        assert events[0]["agent_session_id"] == "sess-123"


class TestDisconnectAll:
    """disconnect_all() terminates all subscriber generators."""

    async def test_disconnect_all_stops_iteration(self, broadcaster):
        """All subscriber generators exit cleanly after disconnect_all."""
        exited = []

        async def consume(idx):
            async for _ in broadcaster.subscribe():
                pass
            exited.append(idx)

        tasks = [asyncio.create_task(consume(i)) for i in range(3)]
        await asyncio.sleep(0.01)

        assert len(broadcaster._clients) == 3
        broadcaster.disconnect_all()
        await asyncio.gather(*tasks)

        assert len(exited) == 3
        assert len(broadcaster._clients) == 0


class TestSubscribeCleanup:
    """subscribe() removes queue from _clients when generator exits."""

    async def test_subscriber_cleanup_on_break(self, broadcaster):
        """Breaking out of subscribe removes the queue from clients."""

        async def consume():
            async for event in broadcaster.subscribe():
                break  # exit after first event

        task = asyncio.create_task(consume())
        await asyncio.sleep(0.01)
        assert len(broadcaster._clients) == 1

        await broadcaster.broadcast({"type": "trigger_break"})
        await task
        # Allow generator cleanup to complete
        await asyncio.sleep(0.01)
        assert len(broadcaster._clients) == 0


class TestRingBufferTtl:
    """F-C(2026-05-17): SessionBroadcaster ring buffer TTL invariant.

    BaseSessionBroadcaster default 300s를 1800s(30분)로 확장하여 클라이언트가
    잠시 자리를 비웠다 돌아왔을 때 replay_gap 우회 회로 차단
    (analysis 캐시 20260516-1707-dashboard-feed-realtime-regression §5.1 가설 Z).
    """

    def test_orch_broadcaster_overrides_default_ttl_to_1800_seconds(self):
        """orch-server SessionBroadcaster는 1800s(30분) TTL을 명시적으로 사용한다.

        soul-common BaseSessionBroadcaster default(300s)는 변경하지 않으므로,
        orch-server 서브클래스가 override해야 한다 (design-principles §3 정본 하나 —
        서비스별 정책을 서브클래스에서 명시).
        """
        b = SessionBroadcaster()
        # private attribute이지만 본 invariant는 운영 안전성에 직결 — 명시적 검증.
        assert b._recent_events_ttl_sec == 1800.0, (
            f"F-C: orch SessionBroadcaster TTL은 1800.0이어야 함 (현재: {b._recent_events_ttl_sec}). "
            "5분 TTL은 dashboard 회귀 §5.1 가설 Z 회로를 활성화."
        )
