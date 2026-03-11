"""
test_task_storage - 로드/저장, atomic write, running→error 복구 테스트

현재 API에서 키는 agent_session_id입니다.
"""

import asyncio
import json
from pathlib import Path

import pytest

from soul_server.service.event_store import EventStore
from soul_server.service.session_catalog import SessionCatalog
from soul_server.service.task_models import Task, TaskStatus, utc_now, datetime_to_str
from soul_server.service.task_storage import TaskStorage, recover_orphan_sessions


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


class TestRecoverOrphanSessions:
    """recover_orphan_sessions() — 카탈로그 기반/폴백 양쪽 테스트"""

    @pytest.fixture
    def events_dir(self, tmp_path):
        d = tmp_path / "events"
        d.mkdir()
        return d

    @pytest.fixture
    def event_store(self, events_dir):
        return EventStore(events_dir)

    def _seed_events(self, event_store, session_id, events):
        for ev in events:
            event_store.append(session_id, ev)

    async def test_recover_orphan_without_catalog(self, event_store):
        """카탈로그 없이 폴백으로 고아 복구"""
        self._seed_events(event_store, "orphan-1", [
            {"type": "user_message", "text": "hello"},
            {"type": "complete", "result": "done"},
        ])

        tasks = {}
        recovered = recover_orphan_sessions(tasks, event_store, catalog=None)
        assert recovered == 1
        assert "orphan-1" in tasks
        assert tasks["orphan-1"].status == TaskStatus.COMPLETED
        assert tasks["orphan-1"].prompt == "hello"

    async def test_recover_orphan_with_catalog(self, event_store, tmp_path):
        """카탈로그가 있으면 카탈로그에 없는 세션만 고아로 검출"""
        catalog = SessionCatalog(tmp_path / "catalog.json")

        # 세션 2개 생성 (둘 다 JSONL 파일 존재)
        self._seed_events(event_store, "known-1", [
            {"type": "user_message", "text": "known"},
            {"type": "complete", "result": "ok"},
        ])
        self._seed_events(event_store, "orphan-1", [
            {"type": "user_message", "text": "orphan"},
            {"type": "error", "message": "failed"},
        ])

        # 카탈로그에는 known-1만 등록
        catalog.upsert("known-1", status="completed")

        tasks = {}
        recovered = recover_orphan_sessions(tasks, event_store, catalog=catalog)
        assert recovered == 1
        assert "orphan-1" in tasks
        assert "known-1" not in tasks  # 카탈로그에 있으므로 고아가 아님
        assert tasks["orphan-1"].status == TaskStatus.ERROR
        assert tasks["orphan-1"].prompt == "orphan"

    async def test_recover_orphan_updates_catalog(self, event_store, tmp_path):
        """고아 복구 시 카탈로그에도 엔트리가 추가된다"""
        catalog = SessionCatalog(tmp_path / "catalog.json")

        self._seed_events(event_store, "orphan-1", [
            {"type": "user_message", "text": "hello"},
            {"type": "result", "success": True, "output": "done"},
        ])

        tasks = {}
        recover_orphan_sessions(tasks, event_store, catalog=catalog)

        assert tasks["orphan-1"].prompt == "hello"
        entry = catalog.get("orphan-1")
        assert entry is not None
        assert entry["status"] == "completed"

    async def test_recover_skips_known_tasks(self, event_store, tmp_path):
        """이미 tasks에 있는 세션은 고아로 처리하지 않는다"""
        catalog = SessionCatalog(tmp_path / "catalog.json")

        self._seed_events(event_store, "existing-1", [
            {"type": "user_message", "text": "hello"},
            {"type": "complete", "result": "ok"},
        ])

        # tasks에 이미 존재
        existing_task = Task(agent_session_id="existing-1", prompt="hello")
        existing_task.status = TaskStatus.COMPLETED
        tasks = {"existing-1": existing_task}

        recovered = recover_orphan_sessions(tasks, event_store, catalog=catalog)
        assert recovered == 0

    async def test_recover_empty_jsonl_skipped(self, event_store, events_dir, tmp_path):
        """빈 JSONL 파일은 건너뛴다"""
        catalog = SessionCatalog(tmp_path / "catalog.json")

        # 빈 JSONL 파일 생성 (append 없이)
        (events_dir / "empty-sess.jsonl").write_text("")

        tasks = {}
        recovered = recover_orphan_sessions(tasks, event_store, catalog=catalog)
        assert recovered == 0

    async def test_recover_no_orphans(self, event_store, tmp_path):
        """고아가 없으면 0 반환"""
        catalog = SessionCatalog(tmp_path / "catalog.json")

        self._seed_events(event_store, "sess-1", [
            {"type": "user_message", "text": "hello"},
        ])
        catalog.upsert("sess-1", status="completed")

        tasks = {}
        recovered = recover_orphan_sessions(tasks, event_store, catalog=catalog)
        assert recovered == 0

    async def test_recover_llm_session_messages_array(self, event_store):
        """LLM 세션의 messages 배열에서 프롬프트를 추출한다"""
        self._seed_events(event_store, "llm-1", [
            {
                "type": "user_message",
                "timestamp": 1.0,
                "messages": [
                    {"role": "user", "content": "Translate this text"},
                    {"role": "system", "content": "You are a translator"},
                ],
                "provider": "anthropic",
                "model": "claude-3-haiku",
                "max_tokens": 1024,
                "client_id": "bot-client",
            },
            {"type": "result", "success": True, "output": "done"},
        ])

        tasks = {}
        recovered = recover_orphan_sessions(tasks, event_store, catalog=None)
        assert recovered == 1
        assert tasks["llm-1"].prompt == "Translate this text"
        assert tasks["llm-1"].client_id == "bot-client"

    async def test_recover_client_id_from_user_field(self, event_store):
        """Claude 세션의 'user' 필드에서 client_id를 추출한다"""
        self._seed_events(event_store, "claude-1", [
            {"type": "user_message", "user": "slack-user", "text": "do something"},
            {"type": "complete", "result": "ok"},
        ])

        tasks = {}
        recover_orphan_sessions(tasks, event_store, catalog=None)
        assert tasks["claude-1"].client_id == "slack-user"
        assert tasks["claude-1"].prompt == "do something"

    async def test_recover_fallback_to_last_meaningful_event(self, event_store):
        """user_message에 text가 없으면 마지막 유의미 이벤트에서 폴백"""
        self._seed_events(event_store, "fallback-1", [
            {"type": "user_message"},  # text 없음
            {"type": "thinking", "thinking": "Let me analyze..."},
            {"type": "complete", "result": "analysis done"},
        ])

        tasks = {}
        recover_orphan_sessions(tasks, event_store, catalog=None)
        # last_meaningful은 complete의 result
        assert tasks["fallback-1"].prompt == "analysis done"
        assert "(복구됨" not in tasks["fallback-1"].prompt

    async def test_recover_no_meaningful_events_uses_fallback_string(self, event_store):
        """유의미한 이벤트도 없으면 폴백 문자열 사용"""
        self._seed_events(event_store, "empty-1", [
            {"type": "system", "session_id": "claude-abc"},
        ])

        tasks = {}
        recover_orphan_sessions(tasks, event_store, catalog=None)
        assert tasks["empty-1"].prompt == "(복구됨 — 원본 프롬프트 없음)"

    async def test_recover_llm_content_blocks_format(self, event_store):
        """Anthropic content blocks 형식에서도 프롬프트를 추출한다"""
        self._seed_events(event_store, "llm-blocks-1", [
            {
                "type": "user_message",
                "timestamp": 1.0,
                "messages": [
                    {
                        "role": "user",
                        "content": [
                            {"type": "text", "text": "Analyze this image"},
                            {"type": "image", "source": {"data": "..."}},
                        ],
                    },
                ],
                "client_id": "bot-client",
            },
            {"type": "result", "success": True, "output": "done"},
        ])

        tasks = {}
        recover_orphan_sessions(tasks, event_store, catalog=None)
        assert tasks["llm-blocks-1"].prompt == "Analyze this image"

    async def test_recover_llm_no_user_role_message(self, event_store):
        """messages 배열에 user role이 없으면 last_meaningful 폴백"""
        self._seed_events(event_store, "llm-no-user-1", [
            {
                "type": "user_message",
                "timestamp": 1.0,
                "messages": [
                    {"role": "system", "content": "You are a translator"},
                ],
                "client_id": "bot-client",
            },
            {"type": "result", "success": True, "result": "translated text"},
        ])

        tasks = {}
        recover_orphan_sessions(tasks, event_store, catalog=None)
        # user_message에서 추출 실패 → result의 result 필드가 last_meaningful
        assert tasks["llm-no-user-1"].prompt == "translated text"


class TestTaskStorageScheduleSave:
    """schedule_save 및 flush_pending_save 테스트"""

    async def test_schedule_save_saves_after_debounce(self, tmp_storage_path):
        """schedule_save는 debounce 후 저장한다"""
        storage = TaskStorage(tmp_storage_path)
        tasks = {"sess-1": Task(agent_session_id="sess-1", prompt="hello")}

        await storage.schedule_save(tasks)

        # 즉시 저장되지 않음
        assert not tmp_storage_path.exists()

        # debounce 대기 (500ms + 여유)
        await asyncio.sleep(0.6)

        # 저장 완료
        assert tmp_storage_path.exists()

    async def test_schedule_save_debounces_multiple_calls(self, tmp_storage_path):
        """여러 호출이 debounce 된다"""
        storage = TaskStorage(tmp_storage_path)

        tasks = {"sess-1": Task(agent_session_id="sess-1", prompt="hello")}
        await storage.schedule_save(tasks)

        # 두 번째 호출은 무시됨 (이미 예약됨)
        await storage.schedule_save(tasks)

        await asyncio.sleep(0.6)
        assert tmp_storage_path.exists()

    async def test_flush_pending_save_waits_for_save(self, tmp_storage_path):
        """flush_pending_save는 대기 중인 저장을 완료한다"""
        storage = TaskStorage(tmp_storage_path)
        tasks = {"sess-1": Task(agent_session_id="sess-1", prompt="hello")}

        await storage.schedule_save(tasks)
        assert not tmp_storage_path.exists()

        # flush로 저장 완료 대기
        await storage.flush_pending_save()

        # 저장 완료됨
        assert tmp_storage_path.exists()

    async def test_flush_pending_save_no_op_when_no_pending(self, tmp_storage_path):
        """대기 중인 저장이 없으면 즉시 반환"""
        storage = TaskStorage(tmp_storage_path)

        # schedule_save 호출 안 함
        await storage.flush_pending_save()

        # 에러 없이 완료
        assert not tmp_storage_path.exists()

    async def test_pending_save_task_cleared_after_completion(self, tmp_storage_path):
        """저장 완료 후 _pending_save_task가 None이 된다"""
        storage = TaskStorage(tmp_storage_path)
        tasks = {"sess-1": Task(agent_session_id="sess-1", prompt="hello")}

        await storage.schedule_save(tasks)

        # flush로 완료 대기
        await storage.flush_pending_save()

        # 완료 후 pending task가 None
        assert storage._pending_save_task is None
