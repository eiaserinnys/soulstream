"""
세션 상태 복원 테스트

T1. TaskManager.load()가 DB의 last_event_id/last_read_event_id를 Task에 복원
T2. _load_evicted_task()가 DB의 last_event_id/last_read_event_id를 Task에 복원
T3. update_read_position API가 Task 객체도 갱신
T4. 서버 시작 시 좀비 세션 정리 (was_running_at_shutdown=0인 running 세션)
T5. 서버 시작 시 꼬인 읽음 상태 복구
T6. Task.to_dict()/from_dict() 왕복 시 last_event_id/last_read_event_id 보존
"""

import asyncio
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest

from soul_server.service.session_db import SessionDB
from soul_server.service.task_models import Task, TaskStatus
from soul_server.service.task_manager import TaskManager
from soul_server.service.session_broadcaster import (
    SessionBroadcaster,
    set_session_broadcaster,
)


@pytest.fixture
def db(tmp_path):
    db_path = tmp_path / "test.db"
    sdb = SessionDB(db_path)
    yield sdb
    sdb.close()


@pytest.fixture(autouse=True)
def reset_broadcaster():
    set_session_broadcaster(None)
    yield
    set_session_broadcaster(None)


async def _cancel_eviction(tm: TaskManager) -> None:
    """테스트 후 eviction task를 정리한다."""
    if tm._eviction_task and not tm._eviction_task.done():
        tm._eviction_task.cancel()
        try:
            await tm._eviction_task
        except asyncio.CancelledError:
            pass


# ============================================================
# T1. TaskManager.load()가 read state 복원
# ============================================================


class TestLoadRestoresReadState:
    @pytest.mark.asyncio
    async def test_load_restores_read_state(self, db):
        """T1: load() 시 DB의 last_event_id, last_read_event_id가 Task에 복원된다"""
        # DB에 running 세션 생성 + 읽음 상태 설정 + was_running_at_shutdown=1 (정상 재개)
        db.upsert_session("s1", session_type="claude", status="running")
        db.append_event("s1", 10, "text_delta", '{"text":"hi"}', "hi", "2026-01-01T00:00:00Z")
        db.update_last_read_event_id("s1", 7)
        db._conn.execute("UPDATE sessions SET was_running_at_shutdown = 1 WHERE session_id = 's1'")
        db._conn.commit()

        tm = TaskManager(session_db=db, eviction_ttl=3600)
        await tm.load()

        task = tm._tasks.get("s1")
        assert task is not None
        assert task.last_event_id == 10
        assert task.last_read_event_id == 7

        await _cancel_eviction(tm)


# ============================================================
# T2. _load_evicted_task()가 read state 복원
# ============================================================


class TestLoadEvictedRestoresReadState:
    @pytest.mark.asyncio
    async def test_load_evicted_restores_read_state(self, db):
        """T2: _load_evicted_task()가 DB의 last_event_id, last_read_event_id를 Task에 복원한다"""
        # DB에 completed 세션 생성 (load()에서 _tasks에 올리지 않음)
        db.upsert_session("s1", session_type="claude", status="completed")
        db.append_event("s1", 20, "text_delta", '{"text":"done"}', "done", "2026-01-01T00:00:00Z")
        db.update_last_read_event_id("s1", 15)

        tm = TaskManager(session_db=db, eviction_ttl=3600)
        await tm.load()

        # completed 세션은 _tasks에 없으므로 get_task로 on-demand 로드
        task = await tm.get_task("s1")
        assert task is not None
        assert task.last_event_id == 20
        assert task.last_read_event_id == 15

        await _cancel_eviction(tm)


# ============================================================
# T3. update_read_position API → Task 객체 동기화
# ============================================================


class TestUpdateReadPositionSyncsTask:
    @pytest.mark.asyncio
    async def test_update_read_position_syncs_task(self, db):
        """T3: update_read_position API 호출 후 Task.last_read_event_id도 갱신된다"""
        from soul_server.api.sessions import create_sessions_router
        from soul_server.service.task_manager import set_task_manager
        from soul_server.service.session_db import init_session_db

        # TaskManager 설정 (was_running_at_shutdown=1로 설정하여 좀비 정리 회피)
        db.upsert_session("s1", session_type="claude", status="running")
        db.append_event("s1", 10, "text_delta", '{"text":"hi"}', "hi", "2026-01-01T00:00:00Z")
        db._conn.execute("UPDATE sessions SET was_running_at_shutdown = 1 WHERE session_id = 's1'")
        db._conn.commit()

        tm = TaskManager(session_db=db, eviction_ttl=3600)
        await tm.load()
        set_task_manager(tm)
        init_session_db(db)

        # Task의 초기 last_read_event_id 확인
        task = tm._tasks.get("s1")
        assert task is not None
        assert task.last_read_event_id == 0

        # broadcaster 설정
        broadcaster = SessionBroadcaster()
        set_session_broadcaster(broadcaster)

        # API 라우터 생성 (싱글톤 참조 방식)
        from fastapi import FastAPI
        app = FastAPI()
        router = create_sessions_router()
        app.include_router(router)

        # API 호출
        from httpx import AsyncClient, ASGITransport
        async with AsyncClient(
            transport=ASGITransport(app=app),
            base_url="http://test",
        ) as client:
            resp = await client.put(
                "/sessions/s1/read-position",
                json={"last_read_event_id": 10},
            )

        assert resp.status_code == 200

        # Task 객체도 갱신되었는지 확인
        assert task.last_read_event_id == 10

        # 싱글톤 정리
        set_task_manager(None)
        init_session_db(None)
        await _cancel_eviction(tm)


# ============================================================
# T4. 좀비 세션 정리
# ============================================================


class TestZombieSessionCleanup:
    @pytest.mark.asyncio
    async def test_zombie_session_cleaned_up(self, db):
        """T4: was_running_at_shutdown=0인 running 세션은 load() 시 completed로 전환"""
        # was_running_at_shutdown=0인 running 세션 (좀비)
        db.upsert_session("zombie1", session_type="claude", status="running")

        # was_running_at_shutdown=1인 running 세션 (정상 재개 대상)
        db.upsert_session("legit1", session_type="claude", status="running")
        db._conn.execute(
            "UPDATE sessions SET was_running_at_shutdown = 1 WHERE session_id = 'legit1'"
        )
        db._conn.commit()

        tm = TaskManager(session_db=db, eviction_ttl=3600)
        await tm.load()

        # 좀비 세션은 completed로 전환
        zombie = db.get_session("zombie1")
        assert zombie["status"] == "completed"
        assert "zombie1" not in tm._tasks

        # 정상 세션은 running 유지
        legit = db.get_session("legit1")
        assert legit["status"] == "running"
        assert "legit1" in tm._tasks

        await _cancel_eviction(tm)


# ============================================================
# T5. 꼬인 읽음 상태 복구
# ============================================================


class TestBrokenReadPositionRecovery:
    def test_repair_broken_read_positions(self, db):
        """T5: completed 세션의 last_read_event_id=0 → last_event_id로 복구"""
        # completed 세션: last_event_id=20, last_read_event_id=0 (꼬인 상태)
        db.upsert_session("broken1", session_type="claude", status="completed")
        db.append_event("broken1", 20, "text_delta", '{"text":"x"}', "x", "2026-01-01T00:00:00Z")

        # running 세션: last_read_event_id=0이지만 복구 대상이 아님
        db.upsert_session("running1", session_type="claude", status="running")
        db.append_event("running1", 5, "text_delta", '{"text":"y"}', "y", "2026-01-01T00:00:00Z")

        # completed 세션: last_read_event_id가 이미 설정됨 (정상)
        db.upsert_session("ok1", session_type="claude", status="completed")
        db.append_event("ok1", 10, "text_delta", '{"text":"z"}', "z", "2026-01-01T00:00:00Z")
        db.update_last_read_event_id("ok1", 10)

        db.repair_broken_read_positions()

        # 꼬인 세션 복구 확인
        s1 = db.get_session("broken1")
        assert s1["last_read_event_id"] == 20

        # running 세션은 그대로
        s2 = db.get_session("running1")
        assert s2["last_read_event_id"] == 0

        # 이미 정상인 세션은 그대로
        s3 = db.get_session("ok1")
        assert s3["last_read_event_id"] == 10


# ============================================================
# T6. to_dict/from_dict 왕복
# ============================================================


class TestToDictFromDictRoundtrip:
    def test_roundtrip_preserves_read_state(self):
        """T6: to_dict → from_dict 왕복 시 last_event_id, last_read_event_id 보존"""
        task = Task(
            agent_session_id="s1",
            prompt="test",
            status=TaskStatus.RUNNING,
            last_event_id=42,
            last_read_event_id=30,
        )

        data = task.to_dict()
        assert data["last_event_id"] == 42
        assert data["last_read_event_id"] == 30

        restored = Task.from_dict(data)
        assert restored.last_event_id == 42
        assert restored.last_read_event_id == 30

    def test_from_dict_defaults_for_legacy(self):
        """T6b: 기존 데이터에 필드가 없으면 0으로 기본값"""
        data = {
            "agent_session_id": "s1",
            "prompt": "test",
            "status": "running",
            "created_at": "2026-01-01T00:00:00+00:00",
        }
        restored = Task.from_dict(data)
        assert restored.last_event_id == 0
        assert restored.last_read_event_id == 0
