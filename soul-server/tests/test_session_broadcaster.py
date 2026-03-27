"""
test_session_broadcaster - SessionBroadcaster 테스트

TDD 방식으로 작성:
1. get_session_broadcaster: 초기화 안 된 상태에서 RuntimeError 발생
2. init_session_broadcaster: 초기화 후 정상 반환
3. set_session_broadcaster: 테스트용 인스턴스 설정
"""

import pytest
from soul_server.service.session_broadcaster import (
    SessionBroadcaster,
    get_session_broadcaster,
    init_session_broadcaster,
    set_session_broadcaster,
)


@pytest.fixture(autouse=True)
def reset_broadcaster():
    """각 테스트 전후로 broadcaster 상태 초기화"""
    set_session_broadcaster(None)
    yield
    set_session_broadcaster(None)


class TestGetSessionBroadcaster:
    """get_session_broadcaster 테스트"""

    def test_raises_runtime_error_when_not_initialized(self):
        """초기화되지 않은 상태에서 RuntimeError 발생"""
        with pytest.raises(RuntimeError) as exc_info:
            get_session_broadcaster()
        assert "not initialized" in str(exc_info.value)

    def test_returns_broadcaster_after_init(self):
        """초기화 후 정상적으로 SessionBroadcaster 반환"""
        init_session_broadcaster()
        broadcaster = get_session_broadcaster()
        assert isinstance(broadcaster, SessionBroadcaster)

    def test_returns_same_instance(self):
        """동일한 인스턴스를 반환한다"""
        init_session_broadcaster()
        b1 = get_session_broadcaster()
        b2 = get_session_broadcaster()
        assert b1 is b2


class TestInitSessionBroadcaster:
    """init_session_broadcaster 테스트"""

    def test_creates_new_instance(self):
        """새 SessionBroadcaster 인스턴스 생성"""
        broadcaster = init_session_broadcaster()
        assert isinstance(broadcaster, SessionBroadcaster)

    def test_replaces_existing_instance(self):
        """기존 인스턴스를 교체한다"""
        b1 = init_session_broadcaster()
        b2 = init_session_broadcaster()
        assert b1 is not b2
        assert get_session_broadcaster() is b2


class TestSetSessionBroadcaster:
    """set_session_broadcaster 테스트 (테스트용)"""

    def test_set_custom_instance(self):
        """커스텀 인스턴스 설정"""
        custom = SessionBroadcaster()
        set_session_broadcaster(custom)
        assert get_session_broadcaster() is custom

    def test_set_none_clears_instance(self):
        """None 설정 시 인스턴스 제거"""
        init_session_broadcaster()
        set_session_broadcaster(None)
        with pytest.raises(RuntimeError):
            get_session_broadcaster()


import asyncio


class TestSessionBroadcasterBroadcast:
    """broadcast 메서드 테스트"""

    @pytest.fixture
    def broadcaster(self):
        return SessionBroadcaster()

    async def test_broadcast_to_single_listener(self, broadcaster):
        """단일 클라이언트에게 이벤트 브로드캐스트"""
        queue = broadcaster.add_client()

        event = {"type": "test", "data": "hello"}
        count = await broadcaster.broadcast(event)

        assert count == 1
        assert queue.get_nowait() == event

    async def test_broadcast_to_multiple_listeners(self, broadcaster):
        """여러 클라이언트에게 이벤트 브로드캐스트"""
        queue1 = broadcaster.add_client()
        queue2 = broadcaster.add_client()

        event = {"type": "test", "data": "hello"}
        count = await broadcaster.broadcast(event)

        assert count == 2
        assert queue1.get_nowait() == event
        assert queue2.get_nowait() == event

    async def test_broadcast_removes_full_queue_listener(self, broadcaster):
        """큐가 가득 찬 클라이언트는 자동으로 제거된다"""
        # maxsize=1로 제한된 큐 생성
        full_queue = broadcaster.add_client(maxsize=1)
        normal_queue = broadcaster.add_client()

        # 첫 번째 이벤트로 full_queue를 채움
        full_queue.put_nowait({"type": "fill"})

        assert broadcaster.client_count == 2

        # 두 번째 브로드캐스트 - full_queue는 가득 참
        event = {"type": "test", "data": "hello"}
        count = await broadcaster.broadcast(event)

        # normal_queue만 성공, full_queue는 제거됨
        assert count == 1
        assert broadcaster.client_count == 1
        assert normal_queue.get_nowait() == event

    async def test_broadcast_removes_multiple_full_queues(self, broadcaster):
        """여러 개의 가득 찬 큐가 동시에 제거된다"""
        full_queue1 = broadcaster.add_client(maxsize=1)
        full_queue2 = broadcaster.add_client(maxsize=1)
        normal_queue = broadcaster.add_client()

        # 두 큐를 채움
        full_queue1.put_nowait({"type": "fill"})
        full_queue2.put_nowait({"type": "fill"})

        assert broadcaster.client_count == 3

        event = {"type": "test"}
        count = await broadcaster.broadcast(event)

        assert count == 1
        assert broadcaster.client_count == 1

    async def test_broadcast_empty_listeners(self, broadcaster):
        """클라이언트가 없으면 0 반환"""
        count = await broadcaster.broadcast({"type": "test"})
        assert count == 0


class TestEmitSessionMessageUpdated:
    """emit_session_message_updated 메서드 테스트"""

    @pytest.fixture
    def broadcaster(self):
        return SessionBroadcaster()

    async def test_emits_session_updated_with_last_message(self, broadcaster):
        """session_updated 이벤트에 last_message 필드가 포함되어 클라이언트에 전달된다"""
        queue = broadcaster.add_client()

        last_message = {"type": "thinking", "preview": "분석 중...", "timestamp": "2026-03-20T01:00:00+00:00"}
        count = await broadcaster.emit_session_message_updated(
            agent_session_id="sess-123",
            status="running",
            updated_at="2026-03-20T01:00:00+00:00",
            last_message=last_message,
        )

        assert count == 1
        event = queue.get_nowait()
        assert event["type"] == "session_updated"
        assert event["agent_session_id"] == "sess-123"
        assert event["status"] == "running"
        assert event["updated_at"] == "2026-03-20T01:00:00+00:00"
        assert event["last_message"] == last_message

    async def test_emits_to_multiple_listeners(self, broadcaster):
        """여러 클라이언트 모두에게 last_message가 포함된 이벤트를 전달한다"""
        q1 = broadcaster.add_client()
        q2 = broadcaster.add_client()

        last_message = {"type": "text", "preview": "Hello", "timestamp": "2026-03-20T01:00:00+00:00"}
        count = await broadcaster.emit_session_message_updated(
            agent_session_id="sess-456",
            status="running",
            updated_at="2026-03-20T01:00:00+00:00",
            last_message=last_message,
        )

        assert count == 2
        assert q1.get_nowait()["last_message"] == last_message
        assert q2.get_nowait()["last_message"] == last_message
