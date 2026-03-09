"""
test_event_store - EventStore JSONL 이벤트 저장소 테스트

TDD 방식으로 작성:
1. append: 이벤트 추가 + 단조증가 ID
2. read_all: 전체 이벤트 반환
3. read_since: Last-Event-ID 이후 이벤트
4. list_sessions: 저장된 세션 목록
5. TaskExecutor 통합: broadcast 시 event_store.append 호출
"""

import asyncio
import json
import pytest
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

from soul_server.service.event_store import EventStore
from soul_server.service.task_executor import TaskExecutor
from soul_server.service.task_listener import TaskListenerManager
from soul_server.service.task_models import Task, TaskStatus


@pytest.fixture
def store(tmp_path):
    """임시 디렉토리에 EventStore 생성"""
    return EventStore(base_dir=tmp_path)


# === append ===

class TestAppend:
    def test_append_returns_monotonic_id(self, store):
        """append는 단조증가 ID를 반환한다"""
        id1 = store.append("sess-1", {"type": "progress", "text": "hello"})
        id2 = store.append("sess-1", {"type": "progress", "text": "world"})
        assert id1 == 1
        assert id2 == 2

    def test_append_separate_sessions_have_independent_ids(self, store):
        """서로 다른 세션은 독립적인 ID 카운터를 갖는다"""
        id_a = store.append("sess-1", {"type": "progress", "text": "a"})
        id_b = store.append("sess-2", {"type": "progress", "text": "b"})
        assert id_a == 1
        assert id_b == 1

    def test_append_creates_jsonl_file(self, store, tmp_path):
        """append는 JSONL 파일을 생성한다"""
        store.append("sess-1", {"type": "progress", "text": "hello"})
        # 파일이 존재해야 한다
        files = list(tmp_path.rglob("*.jsonl"))
        assert len(files) == 1

    def test_append_writes_valid_jsonl(self, store, tmp_path):
        """JSONL 파일의 각 줄은 유효한 JSON이어야 한다"""
        store.append("sess-1", {"type": "progress", "text": "first"})
        store.append("sess-1", {"type": "complete", "result": "done"})

        files = list(tmp_path.rglob("*.jsonl"))
        lines = files[0].read_text(encoding="utf-8").strip().split("\n")
        assert len(lines) == 2

        for line in lines:
            data = json.loads(line)
            assert "id" in data
            assert "event" in data

    def test_append_preserves_event_data(self, store):
        """저장된 이벤트 데이터가 원본과 일치해야 한다"""
        event = {"type": "progress", "text": "hello", "extra": 42}
        store.append("sess-1", event)

        events = store.read_all("sess-1")
        assert len(events) == 1
        assert events[0]["event"] == event


# === read_all ===

class TestReadAll:
    def test_read_all_empty(self, store):
        """이벤트가 없으면 빈 리스트를 반환한다"""
        result = store.read_all("sess-1")
        assert result == []

    def test_read_all_returns_all_events(self, store):
        """모든 이벤트를 순서대로 반환한다"""
        store.append("sess-1", {"type": "progress", "text": "1"})
        store.append("sess-1", {"type": "progress", "text": "2"})
        store.append("sess-1", {"type": "complete", "result": "done"})

        events = store.read_all("sess-1")
        assert len(events) == 3
        assert events[0]["id"] == 1
        assert events[1]["id"] == 2
        assert events[2]["id"] == 3

    def test_read_all_different_sessions_isolated(self, store):
        """서로 다른 세션의 이벤트는 분리된다"""
        store.append("sess-1", {"type": "progress", "text": "session1"})
        store.append("sess-2", {"type": "progress", "text": "session2"})

        events_1 = store.read_all("sess-1")
        events_2 = store.read_all("sess-2")
        assert len(events_1) == 1
        assert len(events_2) == 1
        assert events_1[0]["event"]["text"] == "session1"
        assert events_2[0]["event"]["text"] == "session2"


# === read_since ===

class TestReadSince:
    def test_read_since_returns_events_after_id(self, store):
        """after_id 이후의 이벤트만 반환한다"""
        store.append("sess-1", {"type": "progress", "text": "1"})
        store.append("sess-1", {"type": "progress", "text": "2"})
        store.append("sess-1", {"type": "progress", "text": "3"})

        events = store.read_since("sess-1", after_id=1)
        assert len(events) == 2
        assert events[0]["id"] == 2
        assert events[1]["id"] == 3

    def test_read_since_zero_returns_all(self, store):
        """after_id=0이면 모든 이벤트를 반환한다"""
        store.append("sess-1", {"type": "progress", "text": "1"})
        store.append("sess-1", {"type": "progress", "text": "2"})

        events = store.read_since("sess-1", after_id=0)
        assert len(events) == 2

    def test_read_since_beyond_last_returns_empty(self, store):
        """after_id가 마지막 ID 이상이면 빈 리스트를 반환한다"""
        store.append("sess-1", {"type": "progress", "text": "1"})
        store.append("sess-1", {"type": "progress", "text": "2"})

        events = store.read_since("sess-1", after_id=2)
        assert events == []

    def test_read_since_no_session_returns_empty(self, store):
        """세션이 없으면 빈 리스트를 반환한다"""
        events = store.read_since("sess-1", after_id=0)
        assert events == []


# === list_sessions ===

class TestListSessions:
    def test_list_sessions_empty(self, store):
        """세션이 없으면 빈 리스트를 반환한다"""
        result = store.list_sessions()
        assert result == []

    def test_list_sessions_returns_metadata(self, store):
        """세션 메타데이터(agent_session_id, event_count)를 반환한다"""
        store.append("sess-1", {"type": "progress", "text": "1"})
        store.append("sess-1", {"type": "complete", "result": "done"})
        store.append("sess-2", {"type": "progress", "text": "2"})

        sessions = store.list_sessions()
        assert len(sessions) == 2

        # agent_session_id 정보가 있어야 한다
        session_ids = {s["agent_session_id"] for s in sessions}
        assert "sess-1" in session_ids
        assert "sess-2" in session_ids

    def test_list_sessions_includes_event_count(self, store):
        """세션 메타데이터에 event_count가 포함된다"""
        store.append("sess-1", {"type": "progress", "text": "1"})
        store.append("sess-1", {"type": "complete", "result": "done"})

        sessions = store.list_sessions()
        session = sessions[0]
        assert session["event_count"] == 2

    def test_list_sessions_includes_last_event_type(self, store):
        """세션 메타데이터에 마지막 이벤트 타입이 포함된다"""
        store.append("sess-1", {"type": "progress", "text": "1"})
        store.append("sess-1", {"type": "complete", "result": "done"})

        sessions = store.list_sessions()
        session = sessions[0]
        assert session["last_event_type"] == "complete"


# === 엣지 케이스 ===

class TestEdgeCases:
    def test_special_characters_in_ids(self, store):
        """agent_session_id에 특수문자가 있어도 동작한다"""
        store.append("sess-1234567890.123456", {"type": "progress", "text": "ok"})
        events = store.read_all("sess-1234567890.123456")
        assert len(events) == 1

    def test_unicode_event_data(self, store):
        """유니코드 데이터가 올바르게 저장/복원된다"""
        event = {"type": "progress", "text": "한글 테스트 데이터"}
        store.append("sess-1", event)
        events = store.read_all("sess-1")
        assert events[0]["event"]["text"] == "한글 테스트 데이터"

    def test_large_event_data(self, store):
        """큰 이벤트 데이터도 정상 처리된다"""
        large_text = "x" * 100_000
        event = {"type": "text_delta", "text": large_text}
        store.append("sess-1", event)
        events = store.read_all("sess-1")
        assert len(events[0]["event"]["text"]) == 100_000

    def test_concurrent_appends_to_different_sessions(self, store):
        """서로 다른 세션에 동시에 append해도 데이터가 섞이지 않는다"""
        for i in range(50):
            store.append("sess-1", {"type": "progress", "text": f"s1-{i}"})
            store.append("sess-2", {"type": "progress", "text": f"s2-{i}"})

        events_1 = store.read_all("sess-1")
        events_2 = store.read_all("sess-2")
        assert len(events_1) == 50
        assert len(events_2) == 50

        # 각 세션의 이벤트가 올바른지 확인
        for i, ev in enumerate(events_1):
            assert ev["event"]["text"] == f"s1-{i}"
        for i, ev in enumerate(events_2):
            assert ev["event"]["text"] == f"s2-{i}"

    def test_persistence_across_instances(self, tmp_path):
        """새 EventStore 인스턴스로 이전 데이터를 읽을 수 있다"""
        store1 = EventStore(base_dir=tmp_path)
        store1.append("sess-1", {"type": "progress", "text": "persisted"})
        store1.append("sess-1", {"type": "complete", "result": "done"})

        # 새 인스턴스 생성
        store2 = EventStore(base_dir=tmp_path)
        events = store2.read_all("sess-1")
        assert len(events) == 2
        assert events[0]["event"]["text"] == "persisted"

    def test_append_after_reload_continues_id_sequence(self, tmp_path):
        """재로드 후 append하면 ID가 이어서 증가한다"""
        store1 = EventStore(base_dir=tmp_path)
        store1.append("sess-1", {"type": "progress", "text": "1"})
        store1.append("sess-1", {"type": "progress", "text": "2"})

        # 새 인스턴스에서 append
        store2 = EventStore(base_dir=tmp_path)
        id3 = store2.append("sess-1", {"type": "complete", "result": "done"})
        assert id3 == 3

    def test_concurrent_appends_same_session(self, store):
        """여러 스레드가 같은 세션에 동시에 append해도 ID가 유일하게 증가한다"""
        import threading

        errors = []

        def append_n(n):
            try:
                for i in range(100):
                    store.append("sess-1", {"type": "progress", "idx": n * 100 + i})
            except Exception as e:
                errors.append(e)

        threads = [threading.Thread(target=append_n, args=(i,)) for i in range(5)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        assert not errors
        events = store.read_all("sess-1")
        assert len(events) == 500
        # 모든 ID가 유일하고 순차적으로 증가
        ids = [e["id"] for e in events]
        assert ids == list(range(1, 501))

    def test_corrupted_line_skipped(self, store, tmp_path):
        """손상된 줄이 있어도 나머지 이벤트를 정상 반환한다"""
        store.append("sess-1", {"type": "progress", "text": "1"})
        store.append("sess-1", {"type": "progress", "text": "2"})

        # JSONL 파일에 손상된 줄 삽입
        files = list(tmp_path.rglob("*.jsonl"))
        content = files[0].read_text(encoding="utf-8")
        lines = content.strip().split("\n")
        lines.insert(1, "THIS IS NOT JSON")
        files[0].write_text("\n".join(lines) + "\n", encoding="utf-8")

        events = store.read_all("sess-1")
        assert len(events) == 2  # 손상된 줄은 건너뛰고 2개만 반환

    def test_cleanup_session_removes_next_id_cache(self, store):
        """cleanup_session이 _next_id 캐시를 제거한다 (Lock은 유지)"""
        store.append("sess-1", {"type": "progress", "text": "1"})
        assert "sess-1" in store._next_id
        assert "sess-1" in store._locks

        store.cleanup_session("sess-1")
        assert "sess-1" not in store._next_id
        # Lock은 race condition 방지를 위해 유지됨
        assert "sess-1" in store._locks

    def test_concurrent_append_and_cleanup_no_error(self, store):
        """동시에 append와 cleanup이 호출되어도 오류가 발생하지 않는다"""
        import threading
        import time

        errors = []
        stop_flag = threading.Event()

        def append_loop():
            """append를 반복 호출"""
            try:
                for i in range(100):
                    if stop_flag.is_set():
                        break
                    store.append("sess-concurrent", {"type": "progress", "idx": i})
                    time.sleep(0.001)
            except Exception as e:
                errors.append(e)

        def cleanup_loop():
            """cleanup을 반복 호출"""
            try:
                for _ in range(50):
                    if stop_flag.is_set():
                        break
                    store.cleanup_session("sess-concurrent")
                    time.sleep(0.002)
            except Exception as e:
                errors.append(e)

        threads = [
            threading.Thread(target=append_loop),
            threading.Thread(target=cleanup_loop),
        ]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        # 어떤 오류도 발생하지 않아야 함
        assert not errors

    def test_delete_session_removes_file(self, store, tmp_path):
        """delete_session이 JSONL 파일과 _next_id 캐시를 제거한다 (Lock은 유지)"""
        store.append("sess-1", {"type": "progress", "text": "1"})
        files = list(tmp_path.rglob("*.jsonl"))
        assert len(files) == 1

        store.delete_session("sess-1")
        files_after = list(tmp_path.rglob("*.jsonl"))
        assert len(files_after) == 0
        assert "sess-1" not in store._next_id
        # Lock은 race condition 방지를 위해 유지됨
        assert "sess-1" in store._locks

    def test_path_traversal_blocked(self, store):
        """경로 탈출을 시도하는 agent_session_id가 안전하게 처리된다"""
        # 특수문자가 포함된 agent_session_id가 안전하게 변환된다
        store.append("../../etc/passwd", {"type": "progress", "text": "test"})
        events = store.read_all("../../etc/passwd")
        assert len(events) == 1

    def test_flat_file_structure(self, store, tmp_path):
        """JSONL 파일이 base_dir 직하에 플랫으로 생성된다"""
        store.append("sess-aaa", {"type": "progress", "text": "1"})
        store.append("sess-bbb", {"type": "progress", "text": "2"})

        # base_dir 직하에 파일이 생성되어야 한다 (서브디렉토리 없음)
        files = list(tmp_path.glob("*.jsonl"))
        assert len(files) == 2
        assert (tmp_path / "sess-aaa.jsonl").exists()
        assert (tmp_path / "sess-bbb.jsonl").exists()

        # 서브디렉토리가 없어야 한다
        dirs = [p for p in tmp_path.iterdir() if p.is_dir()]
        assert len(dirs) == 0


# === TaskExecutor 통합 ===

class TestTaskExecutorIntegration:
    """TaskExecutor가 broadcast 시 EventStore.append를 호출하는지 검증"""

    @pytest.fixture
    def setup(self, tmp_path):
        """TaskExecutor + EventStore 통합 fixture"""
        tasks = {}
        event_store = EventStore(base_dir=tmp_path)
        listener_mgr = TaskListenerManager(tasks)

        async def complete_fn(agent_session_id, result, claude_session_id=None):
            task = tasks.get(agent_session_id)
            if task:
                task.status = TaskStatus.COMPLETED
                task.result = result
            return task

        async def error_fn(agent_session_id, error):
            task = tasks.get(agent_session_id)
            if task:
                task.status = TaskStatus.ERROR
                task.error = error
            return task

        executor = TaskExecutor(
            tasks=tasks,
            listener_manager=listener_mgr,
            get_intervention_func=AsyncMock(return_value=None),
            complete_task_func=complete_fn,
            error_task_func=error_fn,
            event_store=event_store,
        )

        return tasks, executor, event_store, listener_mgr

    async def test_events_persisted_during_execution(self, setup):
        """실행 중 이벤트가 EventStore에 저장된다"""
        tasks, executor, event_store, listener_mgr = setup

        # 태스크 생성 (현재 API: agent_session_id, prompt)
        task = Task(agent_session_id="sess-test", prompt="test", client_id="bot")
        tasks[task.key] = task

        # 가짜 claude_runner (progress -> complete 순서로 이벤트 발행)
        progress_event = MagicMock()
        progress_event.type = "progress"
        progress_event.model_dump.return_value = {"type": "progress", "text": "working..."}

        complete_event = MagicMock()
        complete_event.type = "complete"
        complete_event.result = "done"
        complete_event.claude_session_id = "claude-sess-1"
        complete_event.model_dump.return_value = {
            "type": "complete",
            "result": "done",
            "claude_session_id": "claude-sess-1",
            "attachments": [],
        }

        async def fake_execute(**kwargs):
            yield progress_event
            yield complete_event

        mock_runner = MagicMock()
        mock_runner.execute = fake_execute

        # 리소스 매니저 mock
        mock_resource = MagicMock()
        mock_resource.acquire.return_value = AsyncMock()
        mock_resource.acquire.return_value.__aenter__ = AsyncMock()
        mock_resource.acquire.return_value.__aexit__ = AsyncMock(return_value=False)

        # 실행 (현재 API: agent_session_id, runner, resource_manager)
        await executor.start_execution("sess-test", mock_runner, mock_resource)
        # 비동기 태스크 완료 대기
        await asyncio.sleep(0.1)
        if task.execution_task:
            await task.execution_task

        # EventStore에 이벤트가 저장되었는지 확인 (agent_session_id 기준)
        events = event_store.read_all("sess-test")
        # user_message(prompt) + progress + complete = 최소 2개 이상
        assert len(events) >= 2
        event_types = [e["event"]["type"] for e in events]
        assert "progress" in event_types
        assert "complete" in event_types

    async def test_event_store_none_no_error(self):
        """event_store=None이면 저장 없이 동작한다 (하위호환)"""
        tasks = {}
        listener_mgr = TaskListenerManager(tasks)

        executor = TaskExecutor(
            tasks=tasks,
            listener_manager=listener_mgr,
            get_intervention_func=AsyncMock(return_value=None),
            complete_task_func=AsyncMock(return_value=None),
            error_task_func=AsyncMock(return_value=None),
            event_store=None,  # None이어도 에러 없이 동작
        )

        task = Task(agent_session_id="sess-test", prompt="test", client_id="bot")
        tasks[task.key] = task

        complete_event = MagicMock()
        complete_event.type = "complete"
        complete_event.result = "done"
        complete_event.claude_session_id = None
        complete_event.model_dump.return_value = {
            "type": "complete",
            "result": "done",
            "attachments": [],
        }

        async def fake_execute(**kwargs):
            yield complete_event

        mock_runner = MagicMock()
        mock_runner.execute = fake_execute

        mock_resource = MagicMock()
        mock_resource.acquire.return_value = AsyncMock()
        mock_resource.acquire.return_value.__aenter__ = AsyncMock()
        mock_resource.acquire.return_value.__aexit__ = AsyncMock(return_value=False)

        await executor.start_execution("sess-test", mock_runner, mock_resource)
        await asyncio.sleep(0.1)
        if task.execution_task:
            await task.execution_task

        # 에러 없이 완료되면 성공

    async def test_reconnect_replays_from_event_store(self, setup):
        """재연결 시 EventStore의 read_since로 미수신 이벤트를 정규화하여 재전송한다"""
        tasks, executor, event_store, listener_mgr = setup

        task = Task(agent_session_id="sess-test", prompt="test", client_id="bot")
        tasks[task.key] = task

        # 이벤트 직접 저장 (agent_session_id 기준)
        event_store.append("sess-test", {"type": "progress", "text": "step 1"})
        event_store.append("sess-test", {"type": "progress", "text": "step 2"})
        event_store.append("sess-test", {"type": "progress", "text": "step 3"})

        # 재연결: after_id=2 이후 이벤트만 조회
        queue = asyncio.Queue()
        await executor.send_reconnect_status("sess-test", queue, last_event_id=2)

        # 큐에서 이벤트 수집
        received = []
        while not queue.empty():
            received.append(await queue.get())

        # reconnected 이벤트 + 미수신 이벤트(id=3)
        assert any(ev.get("type") == "reconnected" for ev in received)
        replayed = [ev for ev in received if ev.get("type") != "reconnected"]
        assert len(replayed) == 1
        # 정규화된 포맷: {"type": "progress", "text": "step 3", "_event_id": 3}
        assert replayed[0]["type"] == "progress"
        assert replayed[0]["text"] == "step 3"
        assert replayed[0]["_event_id"] == 3
