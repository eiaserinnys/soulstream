"""BaseSessionBroadcaster 단위 테스트."""

import asyncio
import pytest
from soul_common.broadcaster import BaseSessionBroadcaster, ReplayResult


class TestBaseSessionBroadcaster:
    """BaseSessionBroadcaster 기본 동작 테스트."""

    def test_initial_client_count_is_zero(self):
        broadcaster = BaseSessionBroadcaster()
        assert broadcaster.client_count == 0

    def test_add_client_returns_queue(self):
        broadcaster = BaseSessionBroadcaster()
        queue = broadcaster.add_client()
        assert isinstance(queue, asyncio.Queue)
        assert broadcaster.client_count == 1

    def test_add_multiple_clients(self):
        broadcaster = BaseSessionBroadcaster()
        q1 = broadcaster.add_client()
        q2 = broadcaster.add_client()
        assert q1 is not q2
        assert broadcaster.client_count == 2

    def test_remove_client_decrements_count(self):
        broadcaster = BaseSessionBroadcaster()
        queue = broadcaster.add_client()
        broadcaster.remove_client(queue)
        assert broadcaster.client_count == 0

    def test_remove_nonexistent_client_is_safe(self):
        broadcaster = BaseSessionBroadcaster()
        queue = asyncio.Queue()
        broadcaster.remove_client(queue)  # should not raise

    def test_add_client_respects_maxsize(self):
        broadcaster = BaseSessionBroadcaster(queue_maxsize=10)
        queue = broadcaster.add_client()
        assert queue.maxsize == 10

    def test_add_client_with_explicit_maxsize(self):
        broadcaster = BaseSessionBroadcaster(queue_maxsize=256)
        queue = broadcaster.add_client(maxsize=5)
        assert queue.maxsize == 5

    @pytest.mark.asyncio
    async def test_broadcast_delivers_to_all_clients(self):
        broadcaster = BaseSessionBroadcaster()
        q1 = broadcaster.add_client()
        q2 = broadcaster.add_client()

        event = {"type": "test_event", "value": 42}
        count = await broadcaster.broadcast(event)

        assert count == 2
        eid1, ev1 = await q1.get()
        eid2, ev2 = await q2.get()
        assert ev1 == event
        assert ev2 == event
        assert eid1 == 1 and eid2 == 1

    @pytest.mark.asyncio
    async def test_broadcast_returns_sent_count(self):
        broadcaster = BaseSessionBroadcaster()
        broadcaster.add_client()
        broadcaster.add_client()
        broadcaster.add_client()

        count = await broadcaster.broadcast({"type": "ping"})
        assert count == 3

    @pytest.mark.asyncio
    async def test_broadcast_removes_full_queue(self):
        broadcaster = BaseSessionBroadcaster()
        small_queue = broadcaster.add_client(maxsize=1)

        # 첫 번째 이벤트: 성공
        count = await broadcaster.broadcast({"type": "first"})
        assert count == 1
        assert broadcaster.client_count == 1

        # 두 번째 이벤트: QueueFull → 큐 제거
        count = await broadcaster.broadcast({"type": "second"})
        assert count == 0
        assert broadcaster.client_count == 0  # 가득 찬 큐는 제거됨

    @pytest.mark.asyncio
    async def test_broadcast_with_lock(self):
        """use_lock=True 모드에서도 브로드캐스트가 정상 동작한다."""
        broadcaster = BaseSessionBroadcaster(use_lock=True)
        q1 = broadcaster.add_client()
        q2 = broadcaster.add_client()

        event = {"type": "locked_event"}
        count = await broadcaster.broadcast(event)

        assert count == 2
        _eid1, ev1 = await q1.get()
        _eid2, ev2 = await q2.get()
        assert ev1 == event
        assert ev2 == event

    @pytest.mark.asyncio
    async def test_emit_session_deleted(self):
        broadcaster = BaseSessionBroadcaster()
        queue = broadcaster.add_client()

        count = await broadcaster.emit_session_deleted("sess-abc")

        assert count == 1
        _eid, event = await queue.get()
        assert event["type"] == "session_deleted"
        assert event["agent_session_id"] == "sess-abc"

    @pytest.mark.asyncio
    async def test_emit_read_position_updated(self):
        broadcaster = BaseSessionBroadcaster()
        queue = broadcaster.add_client()

        count = await broadcaster.emit_read_position_updated(
            session_id="sess-xyz",
            last_event_id=100,
            last_read_event_id=90,
        )

        assert count == 1
        _eid, event = await queue.get()
        assert event["type"] == "session_updated"
        assert event["agent_session_id"] == "sess-xyz"
        assert event["last_event_id"] == 100
        assert event["last_read_event_id"] == 90

    @pytest.mark.asyncio
    async def test_emit_read_position_updated_uses_agent_session_id_key(self):
        """emit_read_position_updated 페이로드는 session_id가 아니라 agent_session_id 키를 사용한다."""
        broadcaster = BaseSessionBroadcaster()
        queue = broadcaster.add_client()

        await broadcaster.emit_read_position_updated(
            session_id="sess-key-check",
            last_event_id=1,
            last_read_event_id=1,
        )

        _eid, event = await queue.get()
        assert "agent_session_id" in event
        assert "session_id" not in event

    def test_disconnect_all_clears_clients(self):
        broadcaster = BaseSessionBroadcaster()
        broadcaster.add_client()
        broadcaster.add_client()
        broadcaster.add_client()

        broadcaster.disconnect_all()

        assert broadcaster.client_count == 0

    @pytest.mark.asyncio
    async def test_disconnect_all_sends_none_to_each_client(self):
        """disconnect_all은 각 클라이언트에 None을 전송하여 구독 루프를 종료시킨다."""
        broadcaster = BaseSessionBroadcaster()
        q1 = broadcaster.add_client()
        q2 = broadcaster.add_client()

        broadcaster.disconnect_all()

        sentinel1 = await q1.get()
        sentinel2 = await q2.get()
        assert sentinel1 is None
        assert sentinel2 is None


class TestBaseSessionBroadcasterWireContract:
    """BaseSessionBroadcaster 상속 메서드의 wire payload 키 화이트리스트 계약 테스트.

    SessionBroadcaster(soul-server)에서 추가한 TestBroadcasterWireContract와 같은 의도 —
    docstring/dict 비대칭(commit message ≠ 실제 diff) 안티패턴 사전 차단.

    의도: 키 추가·삭제·오타 시 즉시 RED. 값 의미 검증은 기존 test_emit_session_deleted /
    test_emit_read_position_updated가 담당하므로 본 클래스는 키 셋 == 비교만 수행.

    Phase 1 큐 형식 변경 후: 큐는 (event_id, event_dict) 튜플을 yield. 본 테스트는
    event_dict의 키만 검증하므로 _eid는 무시.
    """

    EXPECTED_DELETED_KEYS = {"type", "agent_session_id"}

    # type='session_updated'를 발행하지만 다른 메서드(soul-server emit_session_updated 등)와
    # 키 셋이 다름 — 읽음 위치 갱신 전용이라 status/updated_at도 없다.
    EXPECTED_READ_POSITION_KEYS = {
        "type",
        "agent_session_id",
        "last_event_id",
        "last_read_event_id",
    }

    @pytest.mark.asyncio
    async def test_session_deleted_payload_keys_exact(self):
        """emit_session_deleted wire 키 셋이 화이트리스트와 정확히 일치한다."""
        broadcaster = BaseSessionBroadcaster()
        queue = broadcaster.add_client()
        await broadcaster.emit_session_deleted("sess-del-1")
        _eid, event = queue.get_nowait()
        assert set(event.keys()) == self.EXPECTED_DELETED_KEYS

    @pytest.mark.asyncio
    async def test_read_position_updated_payload_keys_exact(self):
        """emit_read_position_updated wire 키 셋이 화이트리스트와 정확히 일치한다."""
        broadcaster = BaseSessionBroadcaster()
        queue = broadcaster.add_client()
        await broadcaster.emit_read_position_updated(
            session_id="sess-rp-1",
            last_event_id=42,
            last_read_event_id=40,
        )
        _eid, event = queue.get_nowait()
        assert set(event.keys()) == self.EXPECTED_READ_POSITION_KEYS


class TestReplay:
    """Phase 1: Last-Event-ID replay 인프라 테스트."""

    @pytest.mark.asyncio
    async def test_broadcast_assigns_monotonic_id(self):
        b = BaseSessionBroadcaster()
        q = b.add_client()
        await b.broadcast({"type": "a"})
        await b.broadcast({"type": "b"})
        eid1, ev1 = await q.get()
        eid2, ev2 = await q.get()
        assert (eid1, eid2) == (1, 2)
        assert (ev1["type"], ev2["type"]) == ("a", "b")

    @pytest.mark.asyncio
    async def test_replay_since_returns_after_id(self):
        b = BaseSessionBroadcaster()
        for t in ("a", "b", "c"):
            await b.broadcast({"type": t})
        result = b.replay_since(last_event_id=1, client_instance_id=b.instance_id)
        assert isinstance(result, ReplayResult)
        assert not result.gap
        assert [eid for eid, _ in result.events] == [2, 3]
        assert result.latest_id == 3
        assert result.instance_id == b.instance_id

    @pytest.mark.asyncio
    async def test_replay_since_gap_when_below_oldest(self):
        b = BaseSessionBroadcaster(recent_events_maxlen=2)
        for t in ("a", "b", "c"):  # ring keeps [2, 3]
            await b.broadcast({"type": t})
        result = b.replay_since(last_event_id=0, client_instance_id=b.instance_id)
        assert result.gap is True
        assert result.events == []
        assert result.latest_id == 3

    @pytest.mark.asyncio
    async def test_replay_since_gap_on_instance_mismatch(self):
        b = BaseSessionBroadcaster()
        await b.broadcast({"type": "a"})
        result = b.replay_since(last_event_id=1, client_instance_id="different")
        assert result.gap is True

    def test_replay_since_first_connect_no_gap(self):
        b = BaseSessionBroadcaster()
        result = b.replay_since(last_event_id=None, client_instance_id=None)
        assert result.gap is False
        assert result.events == []
        assert result.latest_id == 0

    @pytest.mark.asyncio
    async def test_broadcast_evicts_expired_via_ttl(self, monkeypatch):
        """broadcast 경로에서 _evict_expired가 호출되어 oldest가 빠지는지 검증."""
        import soul_common.broadcaster as mod
        fake_now = [1000.0]
        monkeypatch.setattr(mod.time, "monotonic", lambda: fake_now[0])
        b = BaseSessionBroadcaster(recent_events_ttl_sec=10.0)
        await b.broadcast({"type": "old"})  # ts=1000, id=1
        fake_now[0] = 1015.0
        await b.broadcast({"type": "new"})  # ts=1015, id=2 — 직후 evict로 'old' 제거
        # ring 내부: [(2, 1015, 'new')]
        result = b.replay_since(last_event_id=0, client_instance_id=b.instance_id)
        # last=0 < oldest=2-1=1 → gap
        assert result.gap is True
        assert result.latest_id == 2

    @pytest.mark.asyncio
    async def test_disconnect_all_terminates_subscribers_after_format_change(self):
        """큐 형식이 (eid, event) 튜플로 바뀐 후에도 None sentinel로 안전 종료된다."""
        b = BaseSessionBroadcaster()
        q = b.add_client()

        consumed: list = []

        async def consume():
            while True:
                item = await q.get()
                if item is None:
                    break
                consumed.append(item)

        task = asyncio.create_task(consume())
        await asyncio.sleep(0.01)

        await b.broadcast({"type": "before_disconnect"})
        await asyncio.sleep(0.01)
        b.disconnect_all()
        await asyncio.wait_for(task, timeout=1.0)

        assert len(consumed) == 1
        eid, ev = consumed[0]
        assert eid == 1
        assert ev["type"] == "before_disconnect"

    @pytest.mark.asyncio
    async def test_instance_id_property_is_stable(self):
        b = BaseSessionBroadcaster()
        iid = b.instance_id
        assert isinstance(iid, str) and len(iid) > 0
        # 같은 인스턴스에서는 변경되지 않는다
        await b.broadcast({"type": "x"})
        assert b.instance_id == iid

    @pytest.mark.asyncio
    async def test_latest_event_id_tracks_broadcasts(self):
        b = BaseSessionBroadcaster()
        assert b.latest_event_id == 0
        await b.broadcast({"type": "a"})
        assert b.latest_event_id == 1
        await b.broadcast({"type": "b"})
        assert b.latest_event_id == 2

    @pytest.mark.asyncio
    async def test_replay_since_empty_ring_with_last_id_le_latest(self):
        """ring이 비었지만 last_event_id ≤ latest_id면 gap 없음 (이미 모두 봤음)."""
        b = BaseSessionBroadcaster(recent_events_maxlen=2)
        # broadcast 없음 — latest_id=0, ring 비어있음
        result = b.replay_since(last_event_id=0, client_instance_id=b.instance_id)
        assert result.gap is False
        assert result.events == []
        assert result.latest_id == 0
