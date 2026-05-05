"""
test_bootstrap_lifespan - bootstrap.startup_lifespan/shutdown_lifespan 단위 테스트.

main.py lifespan 분해(atom 작업 이력 260505.15.lifespan-decomp) 결과 도입된
LifespanState / startup_lifespan / shutdown_lifespan / periodic_cleanup의 단위 검증.
분리 결정: bootstrap.py 500줄 한도 + 책임 분리(design-principles §2)로 별도 모듈 신설.

patch 경로 (구현 캐시 §4 정본):
- soul_server.bootstrap_lifespan.bootstrap_* : bootstrap_lifespan이 import한 9개 함수 patch
- soul_server.main.graceful_shutdown   : shutdown_lifespan 내부 함수 레벨 import
- soul_server.bootstrap_lifespan.get_task_manager : 모듈 상단 import
- soul_server.bootstrap_lifespan.file_manager.* : 모듈 상단 import한 file_manager 모듈
"""

import asyncio
import dataclasses
import inspect
import logging
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


@pytest.fixture
def mock_app():
    app = MagicMock()
    app.state = MagicMock()
    return app


@pytest.fixture
def mock_settings(tmp_path):
    settings = MagicMock()
    settings.version = "test"
    settings.environment = "test"
    settings.workspace_dir = str(tmp_path / "workspace")
    settings.runner_pool_pre_warm = 0  # pre_warm 분기 회피
    settings.runner_pool_maintenance_interval = 60
    settings.data_dir = str(tmp_path / "data")
    # 존재하지 않는 디렉토리 → SPA mount 분기 회피 (StaticFiles 호출 안 됨)
    settings.dashboard_dir = str(tmp_path / "nonexistent_dashboard")
    settings.dashboard_cache_dir = str(tmp_path / "cache")
    return settings


@pytest.fixture
def mock_logger():
    return MagicMock(spec=logging.Logger)


# ── 1. LifespanState frozen dataclass + 5필드 ────────────────────


class TestLifespanStateFrozen:
    def test_is_frozen_dataclass(self):
        from soul_server.bootstrap_lifespan import LifespanState

        assert dataclasses.is_dataclass(LifespanState)

        instance = LifespanState(
            pool=MagicMock(),
            session_db=MagicMock(),
            upstream_adapter=None,
            upstream_task=None,
            cleanup_task=MagicMock(),
        )
        with pytest.raises(dataclasses.FrozenInstanceError):
            instance.pool = MagicMock()  # type: ignore[misc]

    def test_has_five_fields(self):
        from soul_server.bootstrap_lifespan import LifespanState

        names = {f.name for f in dataclasses.fields(LifespanState)}
        assert names == {
            "pool",
            "session_db",
            "upstream_adapter",
            "upstream_task",
            "cleanup_task",
        }


# ── 2. periodic_cleanup이 bootstrap_lifespan.py로 이동 ───────────


class TestPeriodicCleanupMovedToBootstrap:
    def test_importable_from_bootstrap(self):
        from soul_server.bootstrap_lifespan import periodic_cleanup  # noqa: F401

    def test_takes_logger_arg(self):
        from soul_server.bootstrap_lifespan import periodic_cleanup

        sig = inspect.signature(periodic_cleanup)
        assert "logger" in sig.parameters


# ── 3. startup_lifespan: LifespanState 반환 + app.state 주입 ─────


def _patch_bootstrap_deps():
    """startup_lifespan의 외부 의존 9개 + 부수 의존을 모두 patch.

    반환: (cm_list, captured) — cm_list는 with 블록에서 enter/exit 자동 처리용,
    captured는 mock 객체들 dict.
    """
    pool = MagicMock()
    pool.pre_warm = AsyncMock(return_value=0)
    pool.start_maintenance = AsyncMock()

    session_db = MagicMock()
    agent_registry = MagicMock()
    task_manager = MagicMock()
    llm_executor = MagicMock()
    upstream_adapter = MagicMock()
    upstream_task = MagicMock()

    captured = {
        "pool": pool,
        "session_db": session_db,
        "agent_registry": agent_registry,
        "task_manager": task_manager,
        "llm_executor": llm_executor,
        "upstream_adapter": upstream_adapter,
        "upstream_task": upstream_task,
    }
    return captured


class TestStartupLifespanReturnsState:
    @pytest.mark.asyncio
    async def test_returns_lifespan_state_with_app_state_set(
        self, mock_app, mock_settings, mock_logger
    ):
        from soul_server.bootstrap_lifespan import startup_lifespan, LifespanState

        cap = _patch_bootstrap_deps()

        with (
            patch("soul_server.bootstrap_lifespan.bootstrap_runner_pool", return_value=cap["pool"]),
            patch("soul_server.bootstrap_lifespan.bootstrap_cogito", return_value=None),
            patch(
                "soul_server.bootstrap_lifespan.bootstrap_session_db",
                new=AsyncMock(return_value=cap["session_db"]),
            ),
            patch(
                "soul_server.bootstrap_lifespan.bootstrap_metadata_extractor", return_value=None
            ),
            patch(
                "soul_server.bootstrap_lifespan.bootstrap_agent_registry",
                return_value=cap["agent_registry"],
            ),
            patch(
                "soul_server.bootstrap_lifespan.bootstrap_task_manager",
                new=AsyncMock(return_value=cap["task_manager"]),
            ),
            patch(
                "soul_server.bootstrap_lifespan.resume_shutdown_sessions", new=AsyncMock()
            ),
            patch(
                "soul_server.bootstrap_lifespan.bootstrap_llm",
                new=AsyncMock(return_value=cap["llm_executor"]),
            ),
            patch(
                "soul_server.bootstrap_lifespan.bootstrap_upstream",
                new=AsyncMock(
                    return_value=(cap["upstream_adapter"], cap["upstream_task"])
                ),
            ),
            patch("soul_server.bootstrap_lifespan.RateLimitTracker"),
            patch("soul_server.bootstrap_lifespan.init_soul_engine"),
            patch(
                "soul_server.bootstrap_lifespan.init_session_broadcaster", return_value=MagicMock()
            ),
            patch(
                "soul_server.service.catalog_service.init_catalog_service",
                return_value=MagicMock(),
            ),
            patch(
                "soul_server.api.catalog.create_catalog_router", return_value=MagicMock()
            ),
            patch("soul_server.bootstrap_lifespan.SessionCache", return_value=MagicMock()),
        ):
            state = await startup_lifespan(mock_app, mock_settings, mock_logger)

        try:
            # LifespanState 반환
            assert isinstance(state, LifespanState)
            assert state.pool is cap["pool"]
            assert state.session_db is cap["session_db"]
            assert state.upstream_adapter is cap["upstream_adapter"]
            assert state.upstream_task is cap["upstream_task"]
            assert state.cleanup_task is not None

            # app.state 주입 (정확히 4개 필드)
            assert mock_app.state.runner_pool is cap["pool"]
            assert mock_app.state.llm_executor is cap["llm_executor"]
            assert mock_app.state.is_draining is False
            # SessionCache 인스턴스가 주입됨
            assert mock_app.state.session_cache is not None
        finally:
            # cleanup_task 정리 (테스트 격리)
            state.cleanup_task.cancel()
            try:
                await state.cleanup_task
            except asyncio.CancelledError:
                pass


# ── 4. startup_lifespan 호출 순서 검증 ────────────────────────────


class TestStartupLifespanCallsInOrder:
    @pytest.mark.asyncio
    async def test_bootstrap_calls_in_documented_order(
        self, mock_app, mock_settings, mock_logger
    ):
        from soul_server.bootstrap_lifespan import startup_lifespan

        order: list[str] = []

        pool = MagicMock()
        pool.pre_warm = AsyncMock(return_value=0)
        pool.start_maintenance = AsyncMock()

        async def fake_session_db(s):
            order.append("session_db")
            return MagicMock()

        async def fake_task_manager(*args, **kwargs):
            order.append("task_manager")
            return MagicMock()

        async def fake_resume(*args):
            order.append("resume")

        async def fake_llm(*args):
            order.append("llm")
            return MagicMock()

        async def fake_upstream(*args):
            order.append("upstream")
            return (MagicMock(), MagicMock())

        with (
            patch(
                "soul_server.bootstrap_lifespan.bootstrap_runner_pool",
                side_effect=lambda s: order.append("pool") or pool,
            ),
            patch(
                "soul_server.bootstrap_lifespan.bootstrap_cogito",
                side_effect=lambda s: order.append("cogito"),
            ),
            patch("soul_server.bootstrap_lifespan.bootstrap_session_db", new=fake_session_db),
            patch(
                "soul_server.bootstrap_lifespan.bootstrap_metadata_extractor",
                side_effect=lambda d: order.append("metadata"),
            ),
            patch(
                "soul_server.bootstrap_lifespan.bootstrap_agent_registry",
                side_effect=lambda s: order.append("agent_registry") or MagicMock(),
            ),
            patch("soul_server.bootstrap_lifespan.bootstrap_task_manager", new=fake_task_manager),
            patch("soul_server.bootstrap_lifespan.resume_shutdown_sessions", new=fake_resume),
            patch("soul_server.bootstrap_lifespan.bootstrap_llm", new=fake_llm),
            patch("soul_server.bootstrap_lifespan.bootstrap_upstream", new=fake_upstream),
            patch("soul_server.bootstrap_lifespan.RateLimitTracker"),
            patch("soul_server.bootstrap_lifespan.init_soul_engine"),
            patch(
                "soul_server.bootstrap_lifespan.init_session_broadcaster", return_value=MagicMock()
            ),
            patch(
                "soul_server.service.catalog_service.init_catalog_service",
                return_value=MagicMock(),
            ),
            patch(
                "soul_server.api.catalog.create_catalog_router", return_value=MagicMock()
            ),
            patch("soul_server.bootstrap_lifespan.SessionCache", return_value=MagicMock()),
        ):
            state = await startup_lifespan(mock_app, mock_settings, mock_logger)

        try:
            # 명세에 명시된 호출 순서 (진단 캐시 17 step 매핑 참조)
            assert order == [
                "pool",
                "cogito",
                "session_db",
                "metadata",
                "agent_registry",
                "task_manager",
                "resume",
                "llm",
                "upstream",
            ]
        finally:
            state.cleanup_task.cancel()
            try:
                await state.cleanup_task
            except asyncio.CancelledError:
                pass


# ── 5. shutdown_lifespan: 6개 서브시스템 호출 ───────────────────


class TestShutdownLifespanCallsSubsystems:
    @pytest.mark.asyncio
    async def test_shutdown_invokes_all_subsystems(
        self, mock_app, mock_settings, mock_logger
    ):
        from soul_server.bootstrap_lifespan import shutdown_lifespan, LifespanState

        # 실제 task로 cancel/await 사이클 통과
        cleanup_task = asyncio.create_task(asyncio.sleep(3600))
        upstream_task = asyncio.create_task(asyncio.sleep(3600))

        upstream_adapter = MagicMock()
        upstream_adapter.shutdown = AsyncMock()

        pool = MagicMock()
        pool.shutdown = AsyncMock(return_value=2)
        session_db = MagicMock()
        session_db.close = AsyncMock()

        state = LifespanState(
            pool=pool,
            session_db=session_db,
            upstream_adapter=upstream_adapter,
            upstream_task=upstream_task,
            cleanup_task=cleanup_task,
        )

        graceful_mock = AsyncMock()

        with (
            # 함수 레벨 import 경로 — soul_server.bootstrap이 아니라 soul_server.main
            patch("soul_server.main.graceful_shutdown", new=graceful_mock),
            patch(
                "soul_server.bootstrap_lifespan.get_task_manager", return_value=MagicMock()
            ),
            patch("soul_server.bootstrap_lifespan.file_manager") as fm,
        ):
            fm.cleanup_old_files = MagicMock(return_value=3)
            await shutdown_lifespan(mock_app, mock_settings, state, mock_logger)

        # 모든 서브시스템 호출 검증
        upstream_adapter.shutdown.assert_awaited_once()
        assert upstream_task.cancelled() or upstream_task.done()
        assert cleanup_task.cancelled() or cleanup_task.done()
        graceful_mock.assert_awaited_once()
        pool.shutdown.assert_awaited_once()
        session_db.close.assert_awaited_once()
        fm.cleanup_old_files.assert_called_once_with(max_age_hours=1)
