"""
test_session_catalog - SessionCatalog 단위 테스트
"""

import asyncio
import json
from pathlib import Path

import pytest

from soul_server.service.session_catalog import SessionCatalog
from soul_server.service.task_models import Task, TaskStatus, utc_now, datetime_to_str


@pytest.fixture
def catalog_path(tmp_path: Path) -> Path:
    """임시 카탈로그 파일 경로"""
    return tmp_path / "session_catalog.json"


@pytest.fixture
def catalog(catalog_path: Path) -> SessionCatalog:
    """테스트용 SessionCatalog"""
    return SessionCatalog(catalog_path)


@pytest.fixture
def catalog_no_persist() -> SessionCatalog:
    """영속화 없는 SessionCatalog"""
    return SessionCatalog(catalog_path=None)


def _make_task(session_id: str, status: TaskStatus = TaskStatus.RUNNING, **kwargs) -> Task:
    """테스트용 Task 생성"""
    return Task(
        agent_session_id=session_id,
        prompt=kwargs.get("prompt", f"prompt-{session_id}"),
        status=status,
        client_id=kwargs.get("client_id", "test-client"),
        session_type=kwargs.get("session_type", "claude"),
        claude_session_id=kwargs.get("claude_session_id"),
        created_at=kwargs.get("created_at", utc_now()),
        completed_at=kwargs.get("completed_at"),
    )


class TestBuildFromTasks:
    async def test_build_creates_entries(self, catalog: SessionCatalog):
        """Task dict에서 카탈로그 엔트리를 생성"""
        tasks = {
            "sess-1": _make_task("sess-1"),
            "sess-2": _make_task("sess-2", TaskStatus.COMPLETED),
        }
        await catalog.build_from_tasks(tasks)

        entry1 = catalog.get("sess-1")
        assert entry1 is not None
        assert entry1["status"] == "running"
        assert entry1["prompt"] == "prompt-sess-1"

        entry2 = catalog.get("sess-2")
        assert entry2 is not None
        assert entry2["status"] == "completed"

    async def test_build_preserves_existing_last_message(self, catalog: SessionCatalog):
        """기존 카탈로그의 last_message를 보존"""
        # 먼저 카탈로그에 last_message가 있는 엔트리 생성
        catalog.upsert("sess-1", status="running", prompt="old", created_at="2026-01-01T00:00:00+00:00")
        catalog.update_last_message("sess-1", "complete", "결과입니다", "2026-01-01T01:00:00+00:00")

        # Task로 rebuild
        tasks = {"sess-1": _make_task("sess-1")}
        await catalog.build_from_tasks(tasks)

        entry = catalog.get("sess-1")
        assert entry["last_message"] is not None
        assert entry["last_message"]["type"] == "complete"
        assert entry["last_message"]["preview"] == "결과입니다"

    async def test_build_clears_stale_entries(self, catalog: SessionCatalog):
        """rebuild 시 Task에 없는 엔트리는 제거"""
        catalog.upsert("sess-old", status="completed", prompt="old", created_at="2026-01-01T00:00:00+00:00")

        tasks = {"sess-new": _make_task("sess-new")}
        await catalog.build_from_tasks(tasks)

        assert catalog.get("sess-old") is None
        assert catalog.get("sess-new") is not None


class TestUpsert:
    def test_upsert_creates_new(self, catalog_no_persist: SessionCatalog):
        """새 엔트리 생성"""
        catalog_no_persist.upsert("sess-1", status="running", prompt="hello")
        entry = catalog_no_persist.get("sess-1")
        assert entry is not None
        assert entry["status"] == "running"
        assert entry["prompt"] == "hello"

    def test_upsert_updates_existing(self, catalog_no_persist: SessionCatalog):
        """기존 엔트리 업데이트"""
        catalog_no_persist.upsert("sess-1", status="running", prompt="hello")
        catalog_no_persist.upsert("sess-1", status="completed")

        entry = catalog_no_persist.get("sess-1")
        assert entry["status"] == "completed"
        assert entry["prompt"] == "hello"  # 변경하지 않은 필드 유지


class TestUpdateLastMessage:
    def test_update_existing_entry(self, catalog_no_persist: SessionCatalog):
        """기존 엔트리의 last_message 업데이트"""
        catalog_no_persist.upsert("sess-1", status="running", prompt="hello")
        catalog_no_persist.update_last_message("sess-1", "thinking", "생각 중...", "2026-01-01T00:00:00+00:00")

        entry = catalog_no_persist.get("sess-1")
        assert entry["last_message"]["type"] == "thinking"
        assert entry["last_message"]["preview"] == "생각 중..."

    def test_update_nonexistent_entry_noop(self, catalog_no_persist: SessionCatalog):
        """존재하지 않는 엔트리에 대한 업데이트는 무시"""
        catalog_no_persist.update_last_message("nonexistent", "thinking", "test", "2026-01-01T00:00:00+00:00")
        assert catalog_no_persist.get("nonexistent") is None

    def test_preview_truncated_to_200(self, catalog_no_persist: SessionCatalog):
        """미리보기 텍스트는 200자로 잘림"""
        catalog_no_persist.upsert("sess-1", status="running")
        long_text = "가" * 300
        catalog_no_persist.update_last_message("sess-1", "result", long_text, "2026-01-01T00:00:00+00:00")

        entry = catalog_no_persist.get("sess-1")
        assert len(entry["last_message"]["preview"]) == 200


class TestRemove:
    def test_remove_existing(self, catalog_no_persist: SessionCatalog):
        """엔트리 삭제"""
        catalog_no_persist.upsert("sess-1", status="running")
        catalog_no_persist.remove("sess-1")
        assert catalog_no_persist.get("sess-1") is None

    def test_remove_nonexistent_noop(self, catalog_no_persist: SessionCatalog):
        """존재하지 않는 엔트리 삭제는 에러 없음"""
        catalog_no_persist.remove("nonexistent")


class TestGetAll:
    def test_get_all_sorted_by_created_at(self, catalog_no_persist: SessionCatalog):
        """created_at 내림차순 정렬"""
        catalog_no_persist.upsert("sess-1", status="running", created_at="2026-01-01T00:00:00+00:00")
        catalog_no_persist.upsert("sess-3", status="running", created_at="2026-01-03T00:00:00+00:00")
        catalog_no_persist.upsert("sess-2", status="running", created_at="2026-01-02T00:00:00+00:00")

        entries, total = catalog_no_persist.get_all()
        assert total == 3
        assert [e["agent_session_id"] for e in entries] == ["sess-3", "sess-2", "sess-1"]

    def test_get_all_with_offset(self, catalog_no_persist: SessionCatalog):
        """offset 적용"""
        for i in range(5):
            catalog_no_persist.upsert(f"sess-{i}", status="running", created_at=f"2026-01-0{i+1}T00:00:00+00:00")

        entries, total = catalog_no_persist.get_all(offset=2)
        assert total == 5
        assert len(entries) == 3

    def test_get_all_with_limit(self, catalog_no_persist: SessionCatalog):
        """limit 적용"""
        for i in range(5):
            catalog_no_persist.upsert(f"sess-{i}", status="running", created_at=f"2026-01-0{i+1}T00:00:00+00:00")

        entries, total = catalog_no_persist.get_all(limit=2)
        assert total == 5
        assert len(entries) == 2

    def test_get_all_with_offset_and_limit(self, catalog_no_persist: SessionCatalog):
        """offset + limit 동시 적용"""
        for i in range(5):
            catalog_no_persist.upsert(f"sess-{i}", status="running", created_at=f"2026-01-0{i+1}T00:00:00+00:00")

        entries, total = catalog_no_persist.get_all(offset=1, limit=2)
        assert total == 5
        assert len(entries) == 2


class TestPersistence:
    async def test_save_and_load(self, catalog_path: Path):
        """저장 후 새 인스턴스에서 로드"""
        cat1 = SessionCatalog(catalog_path)
        cat1.upsert("sess-1", status="completed", prompt="hello", created_at="2026-01-01T00:00:00+00:00")
        cat1.update_last_message("sess-1", "complete", "결과", "2026-01-01T01:00:00+00:00")
        await cat1.save_now()

        assert catalog_path.exists()

        cat2 = SessionCatalog(catalog_path)
        await cat2.load()

        entry = cat2.get("sess-1")
        assert entry is not None
        assert entry["status"] == "completed"
        assert entry["prompt"] == "hello"
        assert entry["last_message"]["type"] == "complete"

    async def test_atomic_write(self, catalog_path: Path):
        """원자적 쓰기 — .tmp 파일이 남아있지 않음"""
        cat = SessionCatalog(catalog_path)
        cat.upsert("sess-1", status="running")
        await cat.save_now()

        assert catalog_path.exists()
        assert not catalog_path.with_suffix(".tmp").exists()

    async def test_no_persist_when_path_is_none(self):
        """catalog_path=None이면 영속화 안 함"""
        cat = SessionCatalog(catalog_path=None)
        cat.upsert("sess-1", status="running")
        await cat.save_now()
        # 에러 없이 완료되어야 함

    async def test_load_nonexistent_file(self, tmp_path: Path):
        """파일이 없으면 빈 상태"""
        cat = SessionCatalog(tmp_path / "nonexistent.json")
        await cat.load()
        entries, total = cat.get_all()
        assert total == 0
