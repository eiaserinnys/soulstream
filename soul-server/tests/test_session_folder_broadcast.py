"""
test_session_folder_broadcast - 세션 생성 시 폴더 배정 + catalog_updated 브로드캐스트 검증

create_or_reuse_task와 register_external_task 모두에서:
1. 새 세션이 기본 폴더에 자동 배정되는지
2. catalog_updated가 session_created 전에 브로드캐스트되는지
"""

import asyncio
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, call

import pytest

from soul_server.service.session_broadcaster import (
    SessionBroadcaster,
    set_session_broadcaster,
)
from soul_server.service.session_db import SessionDB
from soul_server.service.task_manager import TaskManager, set_task_manager
from soul_server.service.task_models import Task, TaskStatus


@pytest.fixture
def broadcaster():
    """Mock broadcaster that records all broadcast calls"""
    mock = MagicMock(spec=SessionBroadcaster)
    mock.broadcast = AsyncMock(return_value=1)
    mock.emit_session_created = AsyncMock(return_value=1)
    mock.emit_session_updated = AsyncMock(return_value=1)
    set_session_broadcaster(mock)
    yield mock
    set_session_broadcaster(None)


@pytest.fixture
def manager(tmp_path, broadcaster):
    """TaskManager with broadcaster and in-memory SQLite"""
    db = SessionDB(tmp_path / "test_sessions.db")
    db.ensure_default_folders()
    m = TaskManager(session_db=db)
    yield m
    set_task_manager(None)
    db.close()


class TestCreateTaskCatalogBroadcast:
    """create_task (→ create_or_reuse_task) 경로의 catalog_updated 검증"""

    async def test_new_session_broadcasts_catalog_before_session_created(
        self, manager, broadcaster
    ):
        """새 세션 생성 시 catalog_updated가 session_created 전에 발행된다"""
        await manager.create_task(
            prompt="hello",
            agent_session_id="sess-broadcast-1",
        )

        # broadcast (catalog_updated)와 emit_session_created 모두 호출됨
        assert broadcaster.broadcast.call_count == 1
        assert broadcaster.emit_session_created.call_count == 1

        # catalog_updated 이벤트 내용 검증
        catalog_call = broadcaster.broadcast.call_args
        event = catalog_call[0][0]
        assert event["type"] == "catalog_updated"
        assert "catalog" in event

        # 호출 순서 검증: catalog_updated가 session_created보다 먼저
        # mock의 call 순서로 검증
        all_calls = broadcaster.method_calls
        catalog_idx = next(
            i for i, c in enumerate(all_calls) if c[0] == "broadcast"
        )
        created_idx = next(
            i
            for i, c in enumerate(all_calls)
            if c[0] == "emit_session_created"
        )
        assert catalog_idx < created_idx, (
            "catalog_updated must be broadcast before session_created"
        )

    async def test_resumed_session_does_not_broadcast_catalog(
        self, manager, broadcaster
    ):
        """resume된 세션은 catalog_updated를 발행하지 않는다"""
        await manager.create_task(
            prompt="hello",
            agent_session_id="sess-resume-1",
        )
        await manager.complete_task("sess-resume-1", "done")

        # 카운터 리셋
        broadcaster.broadcast.reset_mock()
        broadcaster.emit_session_created.reset_mock()
        broadcaster.emit_session_updated.reset_mock()

        # resume
        await manager.create_task(
            prompt="resume prompt",
            agent_session_id="sess-resume-1",
        )

        # resume은 session_updated를 발행하고, catalog_updated는 발행하지 않음
        assert broadcaster.broadcast.call_count == 0
        assert broadcaster.emit_session_updated.call_count == 1

    async def test_new_session_assigned_to_claude_folder(self, manager):
        """새 claude 세션이 '클로드 코드 세션' 폴더에 배정된다"""
        await manager.create_task(
            prompt="hello",
            agent_session_id="sess-folder-1",
        )

        catalog = manager._db.get_catalog()
        session_entry = catalog["sessions"].get("sess-folder-1")
        assert session_entry is not None
        assert session_entry["folderId"] is not None

        # 폴더 이름 확인
        folder_id = session_entry["folderId"]
        folder = next(
            (f for f in catalog["folders"] if f["id"] == folder_id), None
        )
        assert folder is not None
        assert folder["name"] == "클로드 코드 세션"


class TestRegisterExternalTaskCatalogBroadcast:
    """register_external_task 경로의 폴더 배정 + catalog_updated 검증"""

    async def test_external_task_assigned_to_llm_folder(
        self, manager, broadcaster
    ):
        """LLM 세션이 'LLM 세션' 폴더에 자동 배정된다"""
        task = Task(
            agent_session_id="llm-sess-1",
            prompt="test",
            status=TaskStatus.RUNNING,
            session_type="llm",
        )
        await manager.register_external_task(task)

        catalog = manager._db.get_catalog()
        session_entry = catalog["sessions"].get("llm-sess-1")
        assert session_entry is not None
        assert session_entry["folderId"] is not None

        folder_id = session_entry["folderId"]
        folder = next(
            (f for f in catalog["folders"] if f["id"] == folder_id), None
        )
        assert folder is not None
        assert folder["name"] == "LLM 세션"

    async def test_external_task_broadcasts_catalog(
        self, manager, broadcaster
    ):
        """register_external_task가 catalog_updated를 브로드캐스트한다"""
        task = Task(
            agent_session_id="llm-sess-2",
            prompt="test",
            status=TaskStatus.RUNNING,
            session_type="llm",
        )
        await manager.register_external_task(task)

        assert broadcaster.broadcast.call_count == 1
        catalog_call = broadcaster.broadcast.call_args
        event = catalog_call[0][0]
        assert event["type"] == "catalog_updated"
        assert "catalog" in event

    async def test_external_task_unknown_type_falls_back_to_claude_folder(
        self, manager, broadcaster
    ):
        """알 수 없는 session_type은 '클로드 코드 세션' 폴더로 fallback"""
        task = Task(
            agent_session_id="unknown-sess-1",
            prompt="test",
            status=TaskStatus.RUNNING,
            session_type="unknown_type",
        )
        await manager.register_external_task(task)

        catalog = manager._db.get_catalog()
        session_entry = catalog["sessions"].get("unknown-sess-1")
        assert session_entry is not None

        folder_id = session_entry["folderId"]
        folder = next(
            (f for f in catalog["folders"] if f["id"] == folder_id), None
        )
        assert folder is not None
        assert folder["name"] == "클로드 코드 세션"
