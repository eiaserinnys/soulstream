"""BaseSessionBroadcaster 단위 테스트."""

import asyncio
import pytest
from soul_common.broadcaster import BaseSessionBroadcaster


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
        assert await q1.get() == event
        assert await q2.get() == event

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
        assert await q1.get() == event
        assert await q2.get() == event

    @pytest.mark.asyncio
    async def test_emit_session_deleted(self):
        broadcaster = BaseSessionBroadcaster()
        queue = broadcaster.add_client()

        count = await broadcaster.emit_session_deleted("sess-abc")

        assert count == 1
        event = await queue.get()
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
        event = await queue.get()
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

        event = await queue.get()
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
        event = queue.get_nowait()
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
        event = queue.get_nowait()
        assert set(event.keys()) == self.EXPECTED_READ_POSITION_KEYS
