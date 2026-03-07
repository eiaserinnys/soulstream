"""
test_task_storage - 로드/저장, atomic write, running→error 복구 테스트

현재 API에서 키는 agent_session_id입니다.
"""

import json
from pathlib import Path

import pytest

from soul_server.service.task_models import Task, TaskStatus, utc_now, datetime_to_str
from soul_server.service.task_storage import TaskStorage


@pytest.fixture
def tmp_storage_path(tmp_path):
    return tmp_path / "data" / "tasks.json"


@pytest.fixture
def storage(tmp_storage_path):
    return TaskStorage(tmp_storage_path)


class TestTaskStorageSave:
    async def test_save_creates_file(self, storage, tmp_storage_path):
        tasks = {
            "sess-1": Task(agent_session_id="sess-1", prompt="hello")
        }
        await storage.save(tasks)
        assert tmp_storage_path.exists()

    async def test_save_creates_directories(self, storage, tmp_storage_path):
        tasks = {"sess-1": Task(agent_session_id="sess-1", prompt="hello")}
        await storage.save(tasks)
        assert tmp_storage_path.parent.exists()

    async def test_save_valid_json(self, storage, tmp_storage_path):
        tasks = {"sess-1": Task(agent_session_id="sess-1", prompt="hello", client_id="bot")}
        await storage.save(tasks)

        data = json.loads(tmp_storage_path.read_text())
        assert "tasks" in data
        assert "last_saved" in data
        assert "sess-1" in data["tasks"]

    async def test_save_multiple_tasks(self, storage, tmp_storage_path):
        tasks = {
            "sess-1": Task(agent_session_id="sess-1", prompt="hello"),
            "sess-2": Task(agent_session_id="sess-2", prompt="world"),
        }
        await storage.save(tasks)

        data = json.loads(tmp_storage_path.read_text())
        assert len(data["tasks"]) == 2

    async def test_save_empty_tasks(self, storage, tmp_storage_path):
        await storage.save({})
        data = json.loads(tmp_storage_path.read_text())
        assert len(data["tasks"]) == 0


class TestTaskStorageLoad:
    async def test_load_nonexistent_file(self, storage):
        tasks = {}
        loaded = await storage.load(tasks)
        assert loaded == 0
        assert len(tasks) == 0

    async def test_load_from_saved(self, storage, tmp_storage_path):
        # 먼저 저장
        original_tasks = {
            "sess-1": Task(agent_session_id="sess-1", prompt="hello", client_id="bot"),
        }
        original_tasks["sess-1"].status = TaskStatus.COMPLETED
        original_tasks["sess-1"].result = "done"
        original_tasks["sess-1"].completed_at = utc_now()
        await storage.save(original_tasks)

        # 로드
        loaded_tasks = {}
        loaded = await storage.load(loaded_tasks)
        assert loaded == 1
        assert "sess-1" in loaded_tasks
        assert loaded_tasks["sess-1"].status == TaskStatus.COMPLETED
        assert loaded_tasks["sess-1"].result == "done"

    async def test_load_marks_running_as_interrupted(self, storage, tmp_storage_path):
        """running 상태의 태스크는 서비스 재시작으로 중단된 것으로 간주 (event_store 없으면 interrupted)"""
        now = utc_now()
        data = {
            "tasks": {
                "sess-1": {
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
            },
            "last_saved": datetime_to_str(now),
        }

        tmp_storage_path.parent.mkdir(parents=True, exist_ok=True)
        tmp_storage_path.write_text(json.dumps(data))

        tasks = {}
        loaded = await storage.load(tasks)
        assert loaded == 1
        task = tasks["sess-1"]
        assert task.status == TaskStatus.INTERRUPTED
        assert task.error == "서비스 재시작으로 중단됨"
        assert task.completed_at is not None

    async def test_load_preserves_completed_tasks(self, storage, tmp_storage_path):
        """completed 태스크는 그대로 유지"""
        now = utc_now()
        data = {
            "tasks": {
                "sess-1": {
                    "agent_session_id": "sess-1",
                    "prompt": "hello",
                    "status": "completed",
                    "client_id": "bot",
                    "resume_session_id": None,
                    "claude_session_id": "claude-sess-1",
                    "result": "result text",
                    "error": None,
                    "created_at": datetime_to_str(now),
                    "completed_at": datetime_to_str(now),
                }
            },
            "last_saved": datetime_to_str(now),
        }

        tmp_storage_path.parent.mkdir(parents=True, exist_ok=True)
        tmp_storage_path.write_text(json.dumps(data))

        tasks = {}
        loaded = await storage.load(tasks)
        assert loaded == 1
        assert tasks["sess-1"].status == TaskStatus.COMPLETED
        assert tasks["sess-1"].result == "result text"

    async def test_load_corrupted_data(self, tmp_storage_path):
        """손상된 데이터는 건너뛰고 로드"""
        tmp_storage_path.parent.mkdir(parents=True, exist_ok=True)
        tmp_storage_path.write_text("not json")

        storage = TaskStorage(tmp_storage_path)
        tasks = {}
        loaded = await storage.load(tasks)
        assert loaded == 0


class TestTaskStorageNoPersistence:
    async def test_none_path_skips_save(self):
        storage = TaskStorage(storage_path=None)
        tasks = {"sess-1": Task(agent_session_id="sess-1", prompt="hello")}
        # save가 에러 없이 조용히 스킵되는지 확인
        await storage.save(tasks)

    async def test_none_path_skips_load(self):
        storage = TaskStorage(storage_path=None)
        tasks = {}
        loaded = await storage.load(tasks)
        assert loaded == 0


class TestTaskStorageReconciliation:
    """JSONL 이벤트 기반 상태 보정 테스트"""

    @pytest.fixture
    def tmp_paths(self, tmp_path):
        """tasks.json 경로와 JSONL 이벤트 디렉토리를 반환"""
        storage_path = tmp_path / "data" / "tasks.json"
        events_dir = tmp_path / "data" / "events"
        events_dir.mkdir(parents=True, exist_ok=True)
        return storage_path, events_dir

    def _write_jsonl(self, events_dir: Path, session_id: str, events: list[dict]):
        """JSONL 파일에 이벤트를 기록"""
        from soul_server.service.event_store import EventStore
        store = EventStore(events_dir)
        for event in events:
            store.append(session_id, event)
        return store

    def _make_running_task_data(self, session_id: str = "sess-1") -> dict:
        """running 상태 태스크 JSON 데이터 생성"""
        now = utc_now()
        return {
            "tasks": {
                session_id: {
                    "agent_session_id": session_id,
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
            },
            "last_saved": datetime_to_str(now),
        }

    async def test_reconcile_running_to_completed_from_complete_event(self, tmp_paths):
        """JSONL에 complete 이벤트가 있으면 running → completed로 보정"""
        storage_path, events_dir = tmp_paths
        storage = TaskStorage(storage_path)

        # tasks.json에 running 상태로 저장
        storage_path.parent.mkdir(parents=True, exist_ok=True)
        storage_path.write_text(json.dumps(self._make_running_task_data()))

        # JSONL에 complete 이벤트 기록
        event_store = self._write_jsonl(events_dir, "sess-1", [
            {"type": "user_message", "user": "test", "text": "hello"},
            {"type": "thinking", "timestamp": 1.0, "thinking": "...", "signature": ""},
            {"type": "text_start", "timestamp": 1.0},
            {"type": "text_delta", "timestamp": 1.0, "text": "done"},
            {"type": "text_end", "timestamp": 1.0},
            {"type": "result", "timestamp": 1.0, "success": True, "output": "done"},
            {"type": "complete", "result": "done", "attachments": []},
        ])

        tasks = {}
        loaded = await storage.load(tasks, event_store=event_store)
        assert loaded == 1
        task = tasks["sess-1"]
        assert task.status == TaskStatus.COMPLETED
        assert task.completed_at is not None

    async def test_reconcile_running_to_completed_from_result_event(self, tmp_paths):
        """JSONL에 result(success=True) 이벤트가 있으면 running → completed로 보정"""
        storage_path, events_dir = tmp_paths
        storage = TaskStorage(storage_path)

        storage_path.parent.mkdir(parents=True, exist_ok=True)
        storage_path.write_text(json.dumps(self._make_running_task_data()))

        # complete 없이 result만 있는 경우
        event_store = self._write_jsonl(events_dir, "sess-1", [
            {"type": "user_message", "user": "test", "text": "hello"},
            {"type": "result", "timestamp": 1.0, "success": True, "output": "done"},
        ])

        tasks = {}
        await storage.load(tasks, event_store=event_store)
        assert tasks["sess-1"].status == TaskStatus.COMPLETED

    async def test_reconcile_running_to_error_from_result_failure(self, tmp_paths):
        """JSONL에 result(success=False) 이벤트가 있으면 running → error로 보정"""
        storage_path, events_dir = tmp_paths
        storage = TaskStorage(storage_path)

        storage_path.parent.mkdir(parents=True, exist_ok=True)
        storage_path.write_text(json.dumps(self._make_running_task_data()))

        event_store = self._write_jsonl(events_dir, "sess-1", [
            {"type": "user_message", "user": "test", "text": "hello"},
            {"type": "result", "timestamp": 1.0, "success": False, "output": "failed"},
        ])

        tasks = {}
        await storage.load(tasks, event_store=event_store)
        assert tasks["sess-1"].status == TaskStatus.ERROR

    async def test_reconcile_running_to_error_from_error_event(self, tmp_paths):
        """JSONL에 error 이벤트가 있으면 running → error로 보정"""
        storage_path, events_dir = tmp_paths
        storage = TaskStorage(storage_path)

        storage_path.parent.mkdir(parents=True, exist_ok=True)
        storage_path.write_text(json.dumps(self._make_running_task_data()))

        event_store = self._write_jsonl(events_dir, "sess-1", [
            {"type": "user_message", "user": "test", "text": "hello"},
            {"type": "error", "message": "something broke"},
        ])

        tasks = {}
        await storage.load(tasks, event_store=event_store)
        assert tasks["sess-1"].status == TaskStatus.ERROR

    async def test_reconcile_no_terminal_event_stays_interrupted(self, tmp_paths):
        """JSONL에 터미널 이벤트가 없으면 interrupted"""
        storage_path, events_dir = tmp_paths
        storage = TaskStorage(storage_path)

        storage_path.parent.mkdir(parents=True, exist_ok=True)
        storage_path.write_text(json.dumps(self._make_running_task_data()))

        # 중간 이벤트만 있고 complete/error 없음
        event_store = self._write_jsonl(events_dir, "sess-1", [
            {"type": "user_message", "user": "test", "text": "hello"},
            {"type": "thinking", "timestamp": 1.0, "thinking": "...", "signature": ""},
            {"type": "tool_start", "timestamp": 1.0, "tool_name": "Read", "tool_input": {}},
        ])

        tasks = {}
        await storage.load(tasks, event_store=event_store)
        assert tasks["sess-1"].status == TaskStatus.INTERRUPTED

    async def test_reconcile_empty_jsonl_stays_interrupted(self, tmp_paths):
        """JSONL이 비어있으면 interrupted"""
        storage_path, events_dir = tmp_paths
        storage = TaskStorage(storage_path)

        storage_path.parent.mkdir(parents=True, exist_ok=True)
        storage_path.write_text(json.dumps(self._make_running_task_data()))

        from soul_server.service.event_store import EventStore
        event_store = EventStore(events_dir)
        # JSONL 파일 없음 → read_all returns []

        tasks = {}
        await storage.load(tasks, event_store=event_store)
        assert tasks["sess-1"].status == TaskStatus.INTERRUPTED

    async def test_reconcile_no_event_store_stays_interrupted(self, tmp_paths):
        """event_store=None이면 보정 불가 → interrupted"""
        storage_path, _ = tmp_paths
        storage = TaskStorage(storage_path)

        storage_path.parent.mkdir(parents=True, exist_ok=True)
        storage_path.write_text(json.dumps(self._make_running_task_data()))

        tasks = {}
        await storage.load(tasks, event_store=None)
        assert tasks["sess-1"].status == TaskStatus.INTERRUPTED
