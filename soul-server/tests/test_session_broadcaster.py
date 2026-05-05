"""
test_session_broadcaster - SessionBroadcaster 테스트

TDD 방식으로 작성:
1. get_session_broadcaster: 초기화 안 된 상태에서 RuntimeError 발생
2. init_session_broadcaster: 초기화 후 정상 반환
3. set_session_broadcaster: 테스트용 인스턴스 설정
"""

import asyncio
from datetime import datetime, timezone

import pytest
from unittest.mock import MagicMock
from soul_server.service.agent_registry import AgentRegistry
from soul_server.service.session_broadcaster import (
    SessionBroadcaster,
    get_session_broadcaster,
    init_session_broadcaster,
    set_session_broadcaster,
)
from soul_server.service.task_models import Task, TaskStatus


@pytest.fixture
def mock_registry():
    registry = MagicMock(spec=AgentRegistry)
    registry.get.return_value = None
    return registry


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

    def test_returns_broadcaster_after_init(self, mock_registry):
        """초기화 후 정상적으로 SessionBroadcaster 반환"""
        init_session_broadcaster(mock_registry)
        broadcaster = get_session_broadcaster()
        assert isinstance(broadcaster, SessionBroadcaster)

    def test_returns_same_instance(self, mock_registry):
        """동일한 인스턴스를 반환한다"""
        init_session_broadcaster(mock_registry)
        b1 = get_session_broadcaster()
        b2 = get_session_broadcaster()
        assert b1 is b2


class TestInitSessionBroadcaster:
    """init_session_broadcaster 테스트"""

    def test_creates_new_instance(self, mock_registry):
        """새 SessionBroadcaster 인스턴스 생성"""
        broadcaster = init_session_broadcaster(mock_registry)
        assert isinstance(broadcaster, SessionBroadcaster)

    def test_replaces_existing_instance(self, mock_registry):
        """기존 인스턴스를 교체한다"""
        b1 = init_session_broadcaster(mock_registry)
        b2 = init_session_broadcaster(mock_registry)
        assert b1 is not b2
        assert get_session_broadcaster() is b2


class TestSetSessionBroadcaster:
    """set_session_broadcaster 테스트 (테스트용)"""

    def test_set_custom_instance(self, mock_registry):
        """커스텀 인스턴스 설정"""
        custom = SessionBroadcaster(agent_registry=mock_registry)
        set_session_broadcaster(custom)
        assert get_session_broadcaster() is custom

    def test_set_none_clears_instance(self, mock_registry):
        """None 설정 시 인스턴스 제거"""
        init_session_broadcaster(mock_registry)
        set_session_broadcaster(None)
        with pytest.raises(RuntimeError):
            get_session_broadcaster()


class TestSessionBroadcasterBroadcast:
    """broadcast 메서드 테스트"""

    @pytest.fixture
    def broadcaster(self, mock_registry):
        return SessionBroadcaster(agent_registry=mock_registry)

    async def test_broadcast_to_single_listener(self, broadcaster):
        """단일 클라이언트에게 이벤트 브로드캐스트"""
        queue = broadcaster.add_client()

        event = {"type": "test", "data": "hello"}
        count = await broadcaster.broadcast(event)

        assert count == 1
        _eid, received = queue.get_nowait()
        assert received == event

    async def test_broadcast_to_multiple_listeners(self, broadcaster):
        """여러 클라이언트에게 이벤트 브로드캐스트"""
        queue1 = broadcaster.add_client()
        queue2 = broadcaster.add_client()

        event = {"type": "test", "data": "hello"}
        count = await broadcaster.broadcast(event)

        assert count == 2
        _eid1, received1 = queue1.get_nowait()
        _eid2, received2 = queue2.get_nowait()
        assert received1 == event
        assert received2 == event

    async def test_broadcast_removes_full_queue_listener(self, broadcaster):
        """큐가 가득 찬 클라이언트는 자동으로 제거된다"""
        # maxsize=1로 제한된 큐 생성
        full_queue = broadcaster.add_client(maxsize=1)
        normal_queue = broadcaster.add_client()

        # 첫 번째 이벤트로 full_queue를 채움 (Phase 1: 큐 형식 (eid, event) 튜플)
        full_queue.put_nowait((0, {"type": "fill"}))

        assert broadcaster.client_count == 2

        # 두 번째 브로드캐스트 - full_queue는 가득 참
        event = {"type": "test", "data": "hello"}
        count = await broadcaster.broadcast(event)

        # normal_queue만 성공, full_queue는 제거됨
        assert count == 1
        assert broadcaster.client_count == 1
        _eid, received = normal_queue.get_nowait()
        assert received == event

    async def test_broadcast_removes_multiple_full_queues(self, broadcaster):
        """여러 개의 가득 찬 큐가 동시에 제거된다"""
        full_queue1 = broadcaster.add_client(maxsize=1)
        full_queue2 = broadcaster.add_client(maxsize=1)
        normal_queue = broadcaster.add_client()

        # 두 큐를 채움 (Phase 1: 큐 형식 (eid, event) 튜플)
        full_queue1.put_nowait((0, {"type": "fill"}))
        full_queue2.put_nowait((0, {"type": "fill"}))

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
    def broadcaster(self, mock_registry):
        return SessionBroadcaster(agent_registry=mock_registry)

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
        _eid, event = queue.get_nowait()
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
        _eid1, ev1 = q1.get_nowait()
        _eid2, ev2 = q2.get_nowait()
        assert ev1["last_message"] == last_message
        assert ev2["last_message"] == last_message


class TestEmitSessionUpdatedWirePayload:
    """emit_session_updated wire payload 검증.

    회귀 방지: 푸시 본문 정본 last_assistant_text가 wire에 실리지 않아
    orch-server PushNotifier가 fallback으로 last_progress_text를 본문에 쓰는 결함
    (커밋 aa8ff313이 commit message로는 추가를 약속했으나 docstring만 변경).
    """

    @pytest.fixture
    def broadcaster(self, mock_registry):
        return SessionBroadcaster(agent_registry=mock_registry)

    def _make_task(self, **overrides) -> Task:
        defaults = dict(
            agent_session_id="sess-wire-1",
            prompt="테스트 프롬프트",
            status=TaskStatus.COMPLETED,
            last_progress_text="도구 실행 중...",
            last_assistant_text="네, 처리 완료했사옵니다.",
            completed_at=datetime(2026, 5, 4, 8, 30, tzinfo=timezone.utc),
            session_type="claude",
            caller_info={"source": "slack"},
        )
        defaults.update(overrides)
        return Task(**defaults)

    async def test_payload_includes_last_assistant_text(self, broadcaster):
        """emit_session_updated wire payload에 last_assistant_text 키가 포함된다."""
        queue = broadcaster.add_client()
        task = self._make_task()

        count = await broadcaster.emit_session_updated(task)

        assert count == 1
        _eid, event = queue.get_nowait()
        assert event["type"] == "session_updated"
        assert "last_assistant_text" in event
        assert event["last_assistant_text"] == "네, 처리 완료했사옵니다."

    async def test_payload_assistant_text_none_when_unset(self, broadcaster):
        """task.last_assistant_text가 None이면 wire에 None으로 실린다 (fallback 체인 정상 동작)."""
        queue = broadcaster.add_client()
        task = self._make_task(last_assistant_text=None)

        await broadcaster.emit_session_updated(task)

        _eid, event = queue.get_nowait()
        assert "last_assistant_text" in event
        assert event["last_assistant_text"] is None

    async def test_phase_payload_includes_last_assistant_text(self, broadcaster):
        """emit_session_phase wire 대칭 — last_assistant_text 포함 (push 트리거 아니지만 일관성)."""
        queue = broadcaster.add_client()
        task = self._make_task(status=TaskStatus.RUNNING)

        await broadcaster.emit_session_phase(task, phase="idle")

        _eid, event = queue.get_nowait()
        assert event["type"] == "session_updated"
        assert event["status"] == "idle"
        assert "last_assistant_text" in event
        assert event["last_assistant_text"] == "네, 처리 완료했사옵니다."


class TestBroadcasterWireContract:
    """broadcaster wire payload 키 화이트리스트 계약 테스트.

    docstring과 event dict 비대칭(커밋 aa8ff313 안티패턴 — commit message로는
    wire 키 추가를 약속했으나 docstring만 변경) 사전 차단.

    의도: 키 추가·삭제·오타가 발생하면 즉시 RED. 값 의미 검증은
    TestEmitSessionUpdatedWirePayload 등 별도 테스트가 담당한다.
    """

    # session_updated 타입 wire 이벤트의 정본 키 셋. push notifier가 읽는 표면.
    EXPECTED_UPDATED_KEYS = {
        "type",
        "agent_session_id",
        "status",
        "updated_at",
        "last_event_id",
        "last_read_event_id",
        "last_progress_text",
        "last_assistant_text",
        "session_type",
        "caller_source",
    }

    # phase wire 이벤트는 last_progress_text를 싣지 않는다.
    # (push 트리거 아닌 idle 통보 의미라 진행 안내 텍스트 부적합)
    EXPECTED_PHASE_KEYS = {
        "type",
        "agent_session_id",
        "status",
        "updated_at",
        "last_event_id",
        "last_read_event_id",
        "last_assistant_text",
        "session_type",
        "caller_source",
    }

    # session_created wire — task.to_session_info() 결과가 'session' 키에 들어간다.
    EXPECTED_CREATED_KEYS = {"type", "session", "folder_id"}

    # session_message_updated wire — type='session_updated'이지만 emit_session_updated와
    # 키 셋이 다름. last_message를 포함하고 last_progress_text/last_assistant_text 미포함.
    EXPECTED_MESSAGE_UPDATED_KEYS = {
        "type",
        "agent_session_id",
        "status",
        "updated_at",
        "last_message",
        "last_event_id",
        "last_read_event_id",
    }

    @pytest.fixture
    def broadcaster(self, mock_registry):
        return SessionBroadcaster(agent_registry=mock_registry)

    def _make_task(self) -> Task:
        return Task(
            agent_session_id="sess-contract-1",
            prompt="테스트",
            status=TaskStatus.COMPLETED,
            last_progress_text="...",
            last_assistant_text="...",
            completed_at=datetime(2026, 5, 4, 8, 50, tzinfo=timezone.utc),
            session_type="claude",
            caller_info={"source": "slack"},
        )

    async def test_session_updated_payload_keys_exact(self, broadcaster):
        """emit_session_updated wire 키 셋이 화이트리스트와 정확히 일치한다.

        키 누락·오타·추가 시 RED — docstring과 dict 비대칭을 즉시 차단.
        """
        queue = broadcaster.add_client()
        await broadcaster.emit_session_updated(self._make_task())
        _eid, event = queue.get_nowait()
        assert set(event.keys()) == self.EXPECTED_UPDATED_KEYS

    async def test_session_phase_payload_keys_exact(self, broadcaster):
        """emit_session_phase wire 키 셋이 화이트리스트와 정확히 일치한다."""
        queue = broadcaster.add_client()
        await broadcaster.emit_session_phase(self._make_task(), phase="idle")
        _eid, event = queue.get_nowait()
        assert set(event.keys()) == self.EXPECTED_PHASE_KEYS

    async def test_session_created_payload_keys_exact(self, broadcaster):
        """emit_session_created wire 키 셋이 화이트리스트와 정확히 일치한다."""
        queue = broadcaster.add_client()
        await broadcaster.emit_session_created(self._make_task(), folder_id="folder-1")
        _eid, event = queue.get_nowait()
        assert set(event.keys()) == self.EXPECTED_CREATED_KEYS

    async def test_session_created_payload_keys_when_folder_id_none(self, broadcaster):
        """folder_id=None일 때도 키 셋은 동일 (값만 None) — 미분류 세션 케이스."""
        queue = broadcaster.add_client()
        await broadcaster.emit_session_created(self._make_task(), folder_id=None)
        _eid, event = queue.get_nowait()
        assert set(event.keys()) == self.EXPECTED_CREATED_KEYS
        assert event["folder_id"] is None

    async def test_session_message_updated_payload_keys_exact(self, broadcaster):
        """emit_session_message_updated wire 키 셋이 화이트리스트와 정확히 일치한다.

        type='session_updated'이지만 emit_session_updated와 다른 모양 — last_message를
        포함하고 last_progress_text/last_assistant_text는 없다. 같은 type을 발행하는
        4개 메서드(updated/phase/message_updated/read_position_updated)가 각각 다른
        키 셋을 가지므로 emit 메서드 기준으로 화이트리스트를 분리한다.
        """
        queue = broadcaster.add_client()
        await broadcaster.emit_session_message_updated(
            agent_session_id="sess-msg-1",
            status="running",
            updated_at="2026-05-04T09:50:00+00:00",
            last_message={
                "type": "text_delta",
                "preview": "안녕",
                "timestamp": "2026-05-04T09:50:00+00:00",
            },
            last_event_id=42,
            last_read_event_id=40,
        )
        _eid, event = queue.get_nowait()
        assert set(event.keys()) == self.EXPECTED_MESSAGE_UPDATED_KEYS


class TestSessionUpdatedSessionTypeAndCallerSource:
    """emit_session_updated / emit_session_phase가 session_type·caller_source를 wire에 싣는다.

    push notifier가 LLM 세션 / 비-사용자 시작 세션을 차단하기 위해 필요한 메타데이터.
    소스 정본은 task.session_type, task.caller_info["source"].
    """

    @pytest.fixture
    def broadcaster(self, mock_registry):
        return SessionBroadcaster(agent_registry=mock_registry)

    def _make_task(self, **overrides) -> Task:
        defaults = dict(
            agent_session_id="sess-meta-1",
            prompt="테스트",
            status=TaskStatus.COMPLETED,
            last_progress_text="...",
            last_assistant_text="...",
            completed_at=datetime(2026, 5, 6, 8, 0, tzinfo=timezone.utc),
            session_type="claude",
            caller_info={"source": "slack"},
        )
        defaults.update(overrides)
        return Task(**defaults)

    async def test_updated_includes_caller_source_slack(self, broadcaster):
        queue = broadcaster.add_client()
        await broadcaster.emit_session_updated(
            self._make_task(caller_info={"source": "slack"})
        )
        _eid, event = queue.get_nowait()
        assert event["caller_source"] == "slack"
        assert event["session_type"] == "claude"

    async def test_updated_includes_caller_source_channel_observer(self, broadcaster):
        queue = broadcaster.add_client()
        await broadcaster.emit_session_updated(
            self._make_task(caller_info={"source": "channel_observer"})
        )
        _eid, event = queue.get_nowait()
        assert event["caller_source"] == "channel_observer"

    async def test_updated_caller_source_none_when_caller_info_none(self, broadcaster):
        """task.caller_info=None이면 wire의 caller_source는 None (None-safe)."""
        queue = broadcaster.add_client()
        await broadcaster.emit_session_updated(
            self._make_task(caller_info=None)
        )
        _eid, event = queue.get_nowait()
        assert event["caller_source"] is None

    async def test_updated_session_type_llm(self, broadcaster):
        queue = broadcaster.add_client()
        await broadcaster.emit_session_updated(
            self._make_task(session_type="llm")
        )
        _eid, event = queue.get_nowait()
        assert event["session_type"] == "llm"

    async def test_phase_includes_session_type_and_caller_source(self, broadcaster):
        queue = broadcaster.add_client()
        await broadcaster.emit_session_phase(
            self._make_task(
                status=TaskStatus.RUNNING,
                session_type="claude",
                caller_info={"source": "browser"},
            ),
            phase="idle",
        )
        _eid, event = queue.get_nowait()
        assert event["session_type"] == "claude"
        assert event["caller_source"] == "browser"

    async def test_phase_caller_source_none_when_caller_info_none(self, broadcaster):
        queue = broadcaster.add_client()
        await broadcaster.emit_session_phase(
            self._make_task(status=TaskStatus.RUNNING, caller_info=None),
            phase="idle",
        )
        _eid, event = queue.get_nowait()
        assert event["caller_source"] is None

