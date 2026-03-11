"""
Session Contract Tests - SSE 이벤트 스키마 검증

Pydantic 스키마로 SSE 이벤트 형식을 검증합니다.
각 스키마별로:
- 유효한 데이터 통과
- 잘못된 status 거부
- 필수 필드 누락 거부
"""

import pytest
from datetime import datetime, timezone
from pydantic import ValidationError

from soul_server.models import (
    TaskStatus,
    SessionInfo,
    SessionsListResponse,
    SessionListSSEEvent,
    SessionCreatedSSEEvent,
    SessionUpdatedSSEEvent,
    SessionDeletedSSEEvent,
)


class TestSessionInfoSchema:
    """SessionInfo 스키마 검증"""

    def test_valid_session_info(self):
        """유효한 세션 정보가 통과해야 한다"""
        info = SessionInfo(
            agent_session_id="sess-001",
            status=TaskStatus.RUNNING,
            prompt="Hello world",
            created_at=datetime(2026, 3, 3, 2, 0, 0, tzinfo=timezone.utc),
            updated_at=datetime(2026, 3, 3, 2, 0, 0, tzinfo=timezone.utc),
            session_type="claude",
        )

        assert info.agent_session_id == "sess-001"
        assert info.status == TaskStatus.RUNNING
        assert info.prompt == "Hello world"

    def test_valid_session_info_completed(self):
        """완료된 세션 정보가 통과해야 한다"""
        info = SessionInfo(
            agent_session_id="sess-002",
            status=TaskStatus.COMPLETED,
            prompt="Test prompt",
            created_at=datetime(2026, 3, 3, 1, 0, 0, tzinfo=timezone.utc),
            updated_at=datetime(2026, 3, 3, 1, 30, 0, tzinfo=timezone.utc),
            session_type="claude",
        )

        assert info.status == TaskStatus.COMPLETED

    def test_valid_session_info_error(self):
        """에러 상태 세션 정보가 통과해야 한다"""
        info = SessionInfo(
            agent_session_id="sess-003",
            status=TaskStatus.ERROR,
            prompt="Error prompt",
            created_at=datetime(2026, 3, 3, 1, 0, 0, tzinfo=timezone.utc),
            updated_at=datetime(2026, 3, 3, 1, 5, 0, tzinfo=timezone.utc),
            session_type="llm",
        )

        assert info.status == TaskStatus.ERROR

    def test_invalid_status_rejected(self):
        """잘못된 status가 거부되어야 한다"""
        with pytest.raises(ValidationError) as exc_info:
            SessionInfo(
                agent_session_id="sess-001",
                status="invalid_status",  # 잘못된 상태
                prompt="Hello",
                created_at=datetime(2026, 3, 3, 2, 0, 0, tzinfo=timezone.utc),
                updated_at=datetime(2026, 3, 3, 2, 0, 0, tzinfo=timezone.utc),
            )

        # ValidationError 메시지에 status 관련 오류 확인
        assert "status" in str(exc_info.value).lower()

    def test_missing_agent_session_id_rejected(self):
        """agent_session_id 누락 시 거부되어야 한다"""
        with pytest.raises(ValidationError):
            SessionInfo(
                status=TaskStatus.RUNNING,
                prompt="Hello",
                created_at=datetime(2026, 3, 3, 2, 0, 0, tzinfo=timezone.utc),
                updated_at=datetime(2026, 3, 3, 2, 0, 0, tzinfo=timezone.utc),
            )

    def test_missing_status_rejected(self):
        """status 누락 시 거부되어야 한다"""
        with pytest.raises(ValidationError):
            SessionInfo(
                agent_session_id="sess-001",
                prompt="Hello",
                created_at=datetime(2026, 3, 3, 2, 0, 0, tzinfo=timezone.utc),
                updated_at=datetime(2026, 3, 3, 2, 0, 0, tzinfo=timezone.utc),
            )

    def test_missing_prompt_rejected(self):
        """prompt 누락 시 거부되어야 한다"""
        with pytest.raises(ValidationError):
            SessionInfo(
                agent_session_id="sess-001",
                status=TaskStatus.RUNNING,
                created_at=datetime(2026, 3, 3, 2, 0, 0, tzinfo=timezone.utc),
                updated_at=datetime(2026, 3, 3, 2, 0, 0, tzinfo=timezone.utc),
            )

    def test_missing_timestamps_rejected(self):
        """타임스탬프 누락 시 거부되어야 한다"""
        with pytest.raises(ValidationError):
            SessionInfo(
                agent_session_id="sess-001",
                status=TaskStatus.RUNNING,
                prompt="Hello",
                # created_at, updated_at 누락
            )

    def test_missing_session_type_rejected(self):
        """session_type 누락 시 거부되어야 한다"""
        with pytest.raises(ValidationError):
            SessionInfo(
                agent_session_id="sess-001",
                status=TaskStatus.RUNNING,
                prompt="Hello",
                created_at=datetime(2026, 3, 3, 2, 0, 0, tzinfo=timezone.utc),
                updated_at=datetime(2026, 3, 3, 2, 0, 0, tzinfo=timezone.utc),
                # session_type 누락 — 필수 필드
            )


class TestSessionsListResponseSchema:
    """SessionsListResponse 스키마 검증"""

    def test_valid_sessions_list(self):
        """유효한 세션 목록이 통과해야 한다"""
        response = SessionsListResponse(
            sessions=[
                SessionInfo(
                    agent_session_id="sess-001",
                    status=TaskStatus.RUNNING,
                    prompt="Hello",
                    created_at=datetime(2026, 3, 3, 2, 0, 0, tzinfo=timezone.utc),
                    updated_at=datetime(2026, 3, 3, 2, 0, 0, tzinfo=timezone.utc),
                    session_type="claude",
                ),
                SessionInfo(
                    agent_session_id="sess-002",
                    status=TaskStatus.COMPLETED,
                    prompt="World",
                    created_at=datetime(2026, 3, 3, 1, 0, 0, tzinfo=timezone.utc),
                    updated_at=datetime(2026, 3, 3, 1, 30, 0, tzinfo=timezone.utc),
                    session_type="llm",
                ),
            ]
        )

        assert len(response.sessions) == 2

    def test_empty_sessions_list(self):
        """빈 세션 목록이 통과해야 한다"""
        response = SessionsListResponse(sessions=[])
        assert response.sessions == []

    def test_default_empty_sessions_list(self):
        """기본값으로 빈 세션 목록이 생성되어야 한다"""
        response = SessionsListResponse()
        assert response.sessions == []


class TestSessionListSSEEventSchema:
    """SessionListSSEEvent (연결 시 초기 목록) 스키마 검증"""

    def test_valid_session_list_event(self):
        """유효한 세션 목록 이벤트가 통과해야 한다"""
        event = SessionListSSEEvent(
            type="session_list",
            sessions=[
                SessionInfo(
                    agent_session_id="sess-001",
                    status=TaskStatus.RUNNING,
                    prompt="Hello",
                    created_at=datetime(2026, 3, 3, 2, 0, 0, tzinfo=timezone.utc),
                    updated_at=datetime(2026, 3, 3, 2, 0, 0, tzinfo=timezone.utc),
                    session_type="claude",
                ),
            ]
        )

        assert event.type == "session_list"
        assert len(event.sessions) == 1

    def test_empty_session_list_event(self):
        """빈 세션 목록 이벤트가 통과해야 한다"""
        event = SessionListSSEEvent(type="session_list", sessions=[])
        assert event.sessions == []

    def test_default_values(self):
        """기본값이 올바르게 설정되어야 한다"""
        event = SessionListSSEEvent()
        assert event.type == "session_list"
        assert event.sessions == []


class TestSessionCreatedSSEEventSchema:
    """SessionCreatedSSEEvent 스키마 검증"""

    def test_valid_session_created_event(self):
        """유효한 세션 생성 이벤트가 통과해야 한다"""
        session = SessionInfo(
            agent_session_id="sess-new",
            status=TaskStatus.RUNNING,
            prompt="New session",
            created_at=datetime(2026, 3, 3, 2, 0, 0, tzinfo=timezone.utc),
            updated_at=datetime(2026, 3, 3, 2, 0, 0, tzinfo=timezone.utc),
            session_type="claude",
        )
        event = SessionCreatedSSEEvent(
            type="session_created",
            session=session,
        )

        assert event.type == "session_created"
        assert event.session.agent_session_id == "sess-new"

    def test_missing_session_rejected(self):
        """session 누락 시 거부되어야 한다"""
        with pytest.raises(ValidationError):
            SessionCreatedSSEEvent(type="session_created")


class TestSessionUpdatedSSEEventSchema:
    """SessionUpdatedSSEEvent 스키마 검증"""

    def test_valid_session_updated_event(self):
        """유효한 세션 업데이트 이벤트가 통과해야 한다"""
        event = SessionUpdatedSSEEvent(
            type="session_updated",
            agent_session_id="sess-001",
            status=TaskStatus.COMPLETED,
            updated_at=datetime(2026, 3, 3, 2, 30, 0, tzinfo=timezone.utc),
        )

        assert event.type == "session_updated"
        assert event.agent_session_id == "sess-001"
        assert event.status == TaskStatus.COMPLETED

    def test_invalid_status_rejected(self):
        """잘못된 status가 거부되어야 한다"""
        with pytest.raises(ValidationError):
            SessionUpdatedSSEEvent(
                type="session_updated",
                agent_session_id="sess-001",
                status="invalid_status",
                updated_at=datetime(2026, 3, 3, 2, 30, 0, tzinfo=timezone.utc),
            )

    def test_missing_agent_session_id_rejected(self):
        """agent_session_id 누락 시 거부되어야 한다"""
        with pytest.raises(ValidationError):
            SessionUpdatedSSEEvent(
                type="session_updated",
                status=TaskStatus.COMPLETED,
                updated_at=datetime(2026, 3, 3, 2, 30, 0, tzinfo=timezone.utc),
            )

    def test_missing_status_rejected(self):
        """status 누락 시 거부되어야 한다"""
        with pytest.raises(ValidationError):
            SessionUpdatedSSEEvent(
                type="session_updated",
                agent_session_id="sess-001",
                updated_at=datetime(2026, 3, 3, 2, 30, 0, tzinfo=timezone.utc),
            )

    def test_missing_updated_at_rejected(self):
        """updated_at 누락 시 거부되어야 한다"""
        with pytest.raises(ValidationError):
            SessionUpdatedSSEEvent(
                type="session_updated",
                agent_session_id="sess-001",
                status=TaskStatus.COMPLETED,
            )


class TestSessionDeletedSSEEventSchema:
    """SessionDeletedSSEEvent 스키마 검증"""

    def test_valid_session_deleted_event(self):
        """유효한 세션 삭제 이벤트가 통과해야 한다"""
        event = SessionDeletedSSEEvent(
            type="session_deleted",
            agent_session_id="sess-001",
        )

        assert event.type == "session_deleted"
        assert event.agent_session_id == "sess-001"

    def test_missing_agent_session_id_rejected(self):
        """agent_session_id 누락 시 거부되어야 한다"""
        with pytest.raises(ValidationError):
            SessionDeletedSSEEvent(type="session_deleted")


class TestSSEEventJsonSerialization:
    """SSE 이벤트 JSON 직렬화 테스트"""

    def test_session_info_json_serialization(self):
        """SessionInfo가 JSON으로 올바르게 직렬화되어야 한다"""
        info = SessionInfo(
            agent_session_id="sess-001",
            status=TaskStatus.RUNNING,
            prompt="Hello",
            created_at=datetime(2026, 3, 3, 2, 0, 0, tzinfo=timezone.utc),
            updated_at=datetime(2026, 3, 3, 2, 0, 0, tzinfo=timezone.utc),
            session_type="claude",
        )

        json_dict = info.model_dump(mode="json")

        assert json_dict["agent_session_id"] == "sess-001"
        assert json_dict["status"] == "running"
        assert "created_at" in json_dict
        assert "updated_at" in json_dict

    def test_session_created_event_json_serialization(self):
        """SessionCreatedSSEEvent가 JSON으로 올바르게 직렬화되어야 한다"""
        session = SessionInfo(
            agent_session_id="sess-new",
            status=TaskStatus.RUNNING,
            prompt="New session",
            created_at=datetime(2026, 3, 3, 2, 0, 0, tzinfo=timezone.utc),
            updated_at=datetime(2026, 3, 3, 2, 0, 0, tzinfo=timezone.utc),
            session_type="claude",
        )
        event = SessionCreatedSSEEvent(
            type="session_created",
            session=session,
        )

        json_dict = event.model_dump(mode="json")

        assert json_dict["type"] == "session_created"
        assert "session" in json_dict
        assert json_dict["session"]["agent_session_id"] == "sess-new"

    def test_session_updated_event_json_serialization(self):
        """SessionUpdatedSSEEvent가 JSON으로 올바르게 직렬화되어야 한다"""
        event = SessionUpdatedSSEEvent(
            type="session_updated",
            agent_session_id="sess-001",
            status=TaskStatus.COMPLETED,
            updated_at=datetime(2026, 3, 3, 2, 30, 0, tzinfo=timezone.utc),
        )

        json_dict = event.model_dump(mode="json")

        assert json_dict["type"] == "session_updated"
        assert json_dict["agent_session_id"] == "sess-001"
        assert json_dict["status"] == "completed"
        assert "updated_at" in json_dict

    def test_session_deleted_event_json_serialization(self):
        """SessionDeletedSSEEvent가 JSON으로 올바르게 직렬화되어야 한다"""
        event = SessionDeletedSSEEvent(
            type="session_deleted",
            agent_session_id="sess-001",
        )

        json_dict = event.model_dump(mode="json")

        assert json_dict["type"] == "session_deleted"
        assert json_dict["agent_session_id"] == "sess-001"


class TestSSEEventTypeValidation:
    """SSE 이벤트 type 필드 검증"""

    def test_session_list_event_default_type(self):
        """SessionListSSEEvent의 기본 type이 session_list여야 한다"""
        event = SessionListSSEEvent()
        assert event.type == "session_list"

    def test_session_created_event_default_type(self):
        """SessionCreatedSSEEvent의 기본 type이 session_created여야 한다"""
        session = SessionInfo(
            agent_session_id="sess-001",
            status=TaskStatus.RUNNING,
            prompt="Hello",
            created_at=datetime(2026, 3, 3, 2, 0, 0, tzinfo=timezone.utc),
            updated_at=datetime(2026, 3, 3, 2, 0, 0, tzinfo=timezone.utc),
            session_type="claude",
        )
        event = SessionCreatedSSEEvent(session=session)
        assert event.type == "session_created"

    def test_session_updated_event_default_type(self):
        """SessionUpdatedSSEEvent의 기본 type이 session_updated여야 한다"""
        event = SessionUpdatedSSEEvent(
            agent_session_id="sess-001",
            status=TaskStatus.COMPLETED,
            updated_at=datetime(2026, 3, 3, 2, 30, 0, tzinfo=timezone.utc),
        )
        assert event.type == "session_updated"

    def test_session_deleted_event_default_type(self):
        """SessionDeletedSSEEvent의 기본 type이 session_deleted여야 한다"""
        event = SessionDeletedSSEEvent(agent_session_id="sess-001")
        assert event.type == "session_deleted"
