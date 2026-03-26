"""profile_id 파이프라인 테스트 (task_manager, task_executor 레벨)"""
import pytest
from unittest.mock import AsyncMock
from soul_server.service.agent_registry import AgentProfile, AgentRegistry
from soul_server.service.task_manager import TaskManager


def _make_registry():
    return AgentRegistry([
        AgentProfile(
            id="seosoyoung",
            name="서소영",
            workspace_dir="/tmp/ssy",
            max_turns=None,
        )
    ])


def _make_mock_session_db():
    db = AsyncMock()
    db.get_session = AsyncMock(return_value=None)
    db.upsert_session = AsyncMock()
    db.get_default_folder = AsyncMock(return_value=None)
    db.assign_session_to_folder = AsyncMock()
    db.get_catalog = AsyncMock(return_value={"folders": [], "sessions": {}})
    db.node_id = "test-node"
    return db


class TestCreateTaskWithProfile:

    @pytest.fixture
    def mock_session_db(self):
        return _make_mock_session_db()

    @pytest.mark.asyncio
    async def test_profile_id_none_creates_task(self, mock_session_db):
        """profile_id=None → 정상 Task 생성"""
        manager = TaskManager(session_db=mock_session_db)
        task = await manager.create_task(prompt="test", profile_id=None)
        assert task.profile_id is None

    @pytest.mark.asyncio
    async def test_valid_profile_id_creates_task(self, mock_session_db):
        """유효한 profile_id → Task.profile_id 설정"""
        registry = _make_registry()
        manager = TaskManager(session_db=mock_session_db, agent_registry=registry)
        task = await manager.create_task(prompt="test", profile_id="seosoyoung")
        assert task.profile_id == "seosoyoung"

    @pytest.mark.asyncio
    async def test_invalid_profile_id_raises_value_error(self, mock_session_db):
        """존재하지 않는 profile_id → ValueError"""
        registry = _make_registry()
        manager = TaskManager(session_db=mock_session_db, agent_registry=registry)
        with pytest.raises(ValueError, match="존재하지 않는 에이전트 프로필"):
            await manager.create_task(prompt="test", profile_id="nonexistent")

    @pytest.mark.asyncio
    async def test_profile_id_without_registry_no_error(self, mock_session_db):
        """registry=None 상태에서 profile_id 전달 → 검사 없이 Task 생성 (degraded mode)"""
        manager = TaskManager(session_db=mock_session_db, agent_registry=None)
        task = await manager.create_task(prompt="test", profile_id="any_profile")
        assert task.profile_id == "any_profile"

    @pytest.mark.asyncio
    async def test_no_profile_id_no_registry_baseline(self, mock_session_db):
        """profile_id도 registry도 없는 기본 경로 — 기존 동작 유지"""
        manager = TaskManager(session_db=mock_session_db)
        task = await manager.create_task(prompt="hello", agent_session_id="sess-1")
        assert task.agent_session_id == "sess-1"
        assert task.profile_id is None
