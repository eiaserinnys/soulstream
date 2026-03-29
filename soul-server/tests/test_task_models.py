"""
test_task_models - Task 생성, 상태 전이, 직렬화/역직렬화 테스트

현재 API에서 Task는 agent_session_id를 primary key로 사용합니다.
request_id, result_delivered 필드는 제거되었습니다.
"""

import asyncio
from datetime import datetime, timezone

from soul_server.service.task_models import (
    Task,
    TaskStatus,
    TaskConflictError,
    TaskNotFoundError,
    TaskNotRunningError,
    utc_now,
    datetime_to_str,
    str_to_datetime,
    generate_agent_session_id,
)


class TestTaskCreation:
    def test_create_task_defaults(self):
        """기본값으로 Task 생성"""
        task = Task(agent_session_id="sess-1", prompt="hello")
        assert task.agent_session_id == "sess-1"
        assert task.prompt == "hello"
        assert task.status == TaskStatus.RUNNING
        assert task.client_id is None
        assert task.result is None
        assert task.error is None
        assert task.resume_session_id is None
        assert task.claude_session_id is None
        assert task.completed_at is None

    def test_create_task_with_client_id(self):
        """client_id 포함 Task 생성"""
        task = Task(agent_session_id="sess-1", prompt="hello", client_id="bot")
        assert task.client_id == "bot"

    def test_task_key(self):
        """Task.key는 agent_session_id"""
        task = Task(agent_session_id="sess-1", prompt="hello")
        assert task.key == "sess-1"

    def test_task_with_resume_session(self):
        """resume_session_id 포함 Task 생성"""
        task = Task(
            agent_session_id="sess-1",
            prompt="hello",
            resume_session_id="abc-123",
        )
        assert task.resume_session_id == "abc-123"

    def test_task_runtime_fields_initialized(self):
        """런타임 필드 초기화 확인"""
        task = Task(agent_session_id="sess-1", prompt="hello")
        assert isinstance(task.intervention_queue, asyncio.Queue)
        assert task.execution_task is None
        assert task.last_progress_text is None


class TestTaskStatusTransitions:
    def test_complete_task(self):
        """Task 완료 상태 전이"""
        task = Task(agent_session_id="sess-1", prompt="hello")
        assert task.status == TaskStatus.RUNNING

        task.status = TaskStatus.COMPLETED
        task.result = "done"
        task.completed_at = utc_now()

        assert task.status == TaskStatus.COMPLETED
        assert task.result == "done"
        assert task.completed_at is not None

    def test_error_task(self):
        """Task 에러 상태 전이"""
        task = Task(agent_session_id="sess-1", prompt="hello")
        task.status = TaskStatus.ERROR
        task.error = "something went wrong"
        task.completed_at = utc_now()

        assert task.status == TaskStatus.ERROR
        assert task.error == "something went wrong"


class TestTaskSerialization:
    def test_to_dict(self):
        """Task → dict 직렬화"""
        task = Task(agent_session_id="sess-1", prompt="hello", client_id="bot")
        d = task.to_dict()

        assert d["agent_session_id"] == "sess-1"
        assert d["prompt"] == "hello"
        assert d["client_id"] == "bot"
        assert d["status"] == "running"
        assert d["result"] is None
        assert d["error"] is None
        assert "created_at" in d
        assert d["completed_at"] is None

    def test_to_dict_completed(self):
        """완료된 Task → dict 직렬화"""
        task = Task(agent_session_id="sess-1", prompt="hello")
        task.status = TaskStatus.COMPLETED
        task.result = "result text"
        task.claude_session_id = "session-123"
        task.completed_at = utc_now()

        d = task.to_dict()
        assert d["status"] == "completed"
        assert d["result"] == "result text"
        assert d["claude_session_id"] == "session-123"
        assert d["completed_at"] is not None

    def test_from_dict(self):
        """dict → Task 역직렬화"""
        now = utc_now()
        d = {
            "agent_session_id": "sess-1",
            "prompt": "hello",
            "status": "running",
            "client_id": "bot",
            "resume_session_id": None,
            "claude_session_id": None,
            "result": None,
            "error": None,
            "created_at": datetime_to_str(now),
            "completed_at": None,
        }

        task = Task.from_dict(d)
        assert task.agent_session_id == "sess-1"
        assert task.prompt == "hello"
        assert task.client_id == "bot"
        assert task.status == TaskStatus.RUNNING
        assert task.result is None

    def test_from_dict_minimal(self):
        """최소 필드만 있는 dict에서도 복원"""
        now = utc_now()
        d = {
            "agent_session_id": "sess-1",
            "status": "running",
            "created_at": datetime_to_str(now),
        }

        task = Task.from_dict(d)
        assert task.agent_session_id == "sess-1"
        assert task.prompt == ""  # 기본값

    def test_roundtrip(self):
        """Task → dict → Task 라운드트립"""
        task = Task(
            agent_session_id="sess-1",
            prompt="hello",
            client_id="bot",
            resume_session_id="session-abc",
        )
        task.status = TaskStatus.COMPLETED
        task.result = "result"
        task.claude_session_id = "session-xyz"
        task.completed_at = utc_now()

        d = task.to_dict()
        restored = Task.from_dict(d)

        assert restored.agent_session_id == task.agent_session_id
        assert restored.prompt == task.prompt
        assert restored.client_id == task.client_id
        assert restored.status == task.status
        assert restored.result == task.result
        assert restored.claude_session_id == task.claude_session_id
        assert restored.resume_session_id == task.resume_session_id

    def test_runtime_fields_not_serialized(self):
        """런타임 필드는 직렬화되지 않음"""
        task = Task(agent_session_id="sess-1", prompt="hello")
        d = task.to_dict()
        assert "listeners" not in d
        assert "intervention_queue" not in d
        assert "execution_task" not in d
        assert "last_progress_text" not in d


class TestDatetimeHelpers:
    def test_utc_now(self):
        """utc_now() 헬퍼"""
        now = utc_now()
        assert isinstance(now, datetime)
        assert now.tzinfo == timezone.utc

    def test_datetime_roundtrip(self):
        """datetime ↔ string 라운드트립"""
        now = utc_now()
        s = datetime_to_str(now)
        restored = str_to_datetime(s)
        assert restored == now


class TestAgentSessionIdGenerator:
    def test_generate_agent_session_id(self):
        """agent_session_id 생성기"""
        session_id = generate_agent_session_id()
        assert session_id.startswith("sess-")
        # 형식: sess-YYYYMMDDHHMMSS-랜덤8자리
        parts = session_id.split("-")
        assert len(parts) == 3

    def test_generate_unique_ids(self):
        """생성된 ID는 유니크"""
        ids = [generate_agent_session_id() for _ in range(100)]
        assert len(set(ids)) == 100


class TestExceptions:
    def test_task_conflict_error(self):
        err = TaskConflictError("conflict")
        assert str(err) == "conflict"

    def test_task_not_found_error(self):
        err = TaskNotFoundError("not found")
        assert str(err) == "not found"

    def test_task_not_running_error(self):
        err = TaskNotRunningError("not running")
        assert str(err) == "not running"


class TestTaskStatusEnum:
    def test_values(self):
        assert TaskStatus.RUNNING.value == "running"
        assert TaskStatus.COMPLETED.value == "completed"
        assert TaskStatus.ERROR.value == "error"

    def test_from_string(self):
        assert TaskStatus("running") == TaskStatus.RUNNING
        assert TaskStatus("completed") == TaskStatus.COMPLETED
        assert TaskStatus("error") == TaskStatus.ERROR
