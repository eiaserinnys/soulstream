"""
soul-server 라이프사이클 합성.

main.py lifespan()이 호출하는 startup/shutdown 합성을 모은다.
``soul_server.bootstrap``의 9개 단일-단계 bootstrap 함수와 책임이 다르므로 별도 모듈
(design-principles §2 분리 기준; module-size-limit ≤ 500줄 준수).

- ``periodic_cleanup`` — startup_lifespan에서 ``asyncio.create_task``로 띄우는 주기적 정리 코루틴.
- ``LifespanState`` — startup_lifespan → shutdown_lifespan 데이터 전달용 frozen dataclass.
- ``startup_lifespan`` — 17 step + app.state 주입.
- ``shutdown_lifespan`` — 7 step. graceful_shutdown은 main.py 잔류로 함수 레벨 import.
"""

import asyncio
import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from soul_server.bootstrap import (
    bootstrap_agent_registry,
    bootstrap_cogito,
    bootstrap_llm,
    bootstrap_metadata_extractor,
    bootstrap_runner_pool,
    bootstrap_session_db,
    bootstrap_task_manager,
    bootstrap_upstream,
    resume_shutdown_sessions,
)
from soul_server.config import Settings
from soul_server.dashboard.session_cache import SessionCache
from soul_server.service import file_manager, resource_manager
from soul_server.service.engine_adapter import init_soul_engine
from soul_server.service.rate_limit_tracker import RateLimitTracker
from soul_server.service.runner_pool import RunnerPool
from soul_server.service.session_broadcaster import init_session_broadcaster
from soul_server.service.task_manager import get_task_manager


# ── 라이프사이클 합성: periodic_cleanup ──────────────────────────


async def periodic_cleanup(logger: logging.Logger) -> None:
    """주기적 고아 running 세션 보정 (24시간 이상 된 orphaned running 태스크).

    main.py에서 이동. logger를 모듈 레벨 클로저 대신 인자로 받는다.
    startup_lifespan이 ``asyncio.create_task(periodic_cleanup(logger))``로 띄운다.
    """
    while True:
        try:
            await asyncio.sleep(3600)  # 1시간마다 실행
            task_manager = get_task_manager()
            fixed = await task_manager.cleanup_orphaned_running(max_age_hours=24)
            if fixed > 0:
                logger.info(
                    f"Periodic cleanup: fixed {fixed} orphaned running sessions"
                )
        except asyncio.CancelledError:
            break
        except Exception as e:  # noqa: BLE001 — 부가 기능, 실패 격리
            logger.exception(f"Periodic cleanup error: {e}")


# ── 라이프사이클 합성: LifespanState ─────────────────────────────


@dataclass(frozen=True)
class LifespanState:
    """startup_lifespan -> shutdown_lifespan 데이터 전달용.

    shutdown 단계에서 직접 사용되는 객체만 포함한다.

    task_manager는 ``set_task_manager(...)``로 글로벌 등록되어
    ``get_task_manager()``가 정본이므로 LifespanState에 추가하지 않는다
    (design-principles §3 "정본 하나" — state에 추가하면 정본이 둘이 됨).
    """

    pool: RunnerPool
    session_db: object  # SessionDBBase (Postgres or SQLite mixin assembly)
    upstream_adapter: Optional[object]
    upstream_task: Optional[asyncio.Task]
    cleanup_task: asyncio.Task


# ── 라이프사이클 합성: startup_lifespan (17 step) ────────────────


async def startup_lifespan(
    app: FastAPI,
    settings: Settings,
    logger: logging.Logger,
) -> LifespanState:
    """main.py lifespan() startup 단계 (17 steps).

    호출 순서·app.state 주입을 모두 이 함수가 책임진다.

    반환된 LifespanState는 shutdown_lifespan에 그대로 전달된다.
    """
    # 0. starting log
    logger.info("Soulstream starting...")
    logger.info(f"  Version: {settings.version}")
    logger.info(f"  Environment: {settings.environment}")
    logger.info(f"  Max concurrent sessions: {resource_manager.max_concurrent}")
    logger.info(f"  Workspace: {settings.workspace_dir}")

    # 1. RunnerPool
    pool = bootstrap_runner_pool(settings)

    # 2. Cogito runtime reflection tools
    bootstrap_cogito(settings)

    # 3. SoulEngine (RunnerPool + RateLimitTracker 조합)
    rate_limit_tracker = RateLimitTracker()
    init_soul_engine(
        pool=pool,
        rate_limit_tracker=rate_limit_tracker,
    )

    # 4. Pre-warm + Maintenance
    if settings.runner_pool_pre_warm > 0:
        warmed = await pool.pre_warm(settings.runner_pool_pre_warm)
        logger.info(
            f"  Runner pool pre-warmed: {warmed}/{settings.runner_pool_pre_warm}개"
        )
    await pool.start_maintenance()
    logger.info(
        f"  Runner pool maintenance loop started "
        f"(interval={settings.runner_pool_maintenance_interval}s)"
    )

    # 5. SessionDB
    session_db = await bootstrap_session_db(settings)

    # 6. MetadataExtractor
    data_dir = Path(settings.data_dir)
    metadata_extractor = bootstrap_metadata_extractor(data_dir)

    # 7. AgentRegistry
    agent_registry = bootstrap_agent_registry(settings)

    # 8. TaskManager
    task_manager = await bootstrap_task_manager(
        session_db, settings, metadata_extractor, agent_registry
    )

    # 9. SessionBroadcaster
    broadcaster = init_session_broadcaster(agent_registry=agent_registry)
    logger.info("  SessionBroadcaster initialized")

    # 10. CatalogService + 라우터 등록
    from soul_server.service.catalog_service import init_catalog_service

    catalog_service = init_catalog_service(session_db, broadcaster)
    logger.info("  CatalogService initialized")
    from soul_server.api.catalog import create_catalog_router

    catalog_router = create_catalog_router(catalog_service)
    app.include_router(catalog_router, prefix="/catalog", tags=["catalog"])
    logger.info("  Catalog API registered")

    # 11. 이전 종료 세션 재개
    # F-11D fix: settings 인자 추가 (system caller_info 조립용 — soulstream_node_id 필요)
    await resume_shutdown_sessions(session_db, task_manager, settings)

    # 12. LLM Proxy
    llm_executor = await bootstrap_llm(
        settings, task_manager, session_db, broadcaster, app
    )

    # 13. SPA 정적 파일 서빙 — LLM 라우터 등록 이후에 마운트
    _dashboard_dir = Path(settings.dashboard_dir)
    if not _dashboard_dir.is_absolute():
        _dashboard_dir = Path.cwd() / _dashboard_dir
    if _dashboard_dir.exists():
        app.mount(
            "/",
            StaticFiles(directory=str(_dashboard_dir), html=True),
            name="spa",
        )
        logger.info(f"  Dashboard SPA mounted: {_dashboard_dir}")

    # 14. app.state 초기화
    app.state.runner_pool = pool
    app.state.llm_executor = llm_executor
    app.state.is_draining = False

    # 15. SessionCache
    app.state.session_cache = SessionCache(settings.dashboard_cache_dir)
    logger.info(f"  SessionCache initialized: {settings.dashboard_cache_dir}")

    # 16. 주기적 정리 태스크
    cleanup_task = asyncio.create_task(periodic_cleanup(logger))
    logger.info("  Started periodic cleanup task")

    # 17. UpstreamAdapter
    upstream_adapter, upstream_task = await bootstrap_upstream(
        settings, task_manager, broadcaster, session_db, agent_registry,
    )

    return LifespanState(
        pool=pool,
        session_db=session_db,
        upstream_adapter=upstream_adapter,
        upstream_task=upstream_task,
        cleanup_task=cleanup_task,
    )


# ── 라이프사이클 합성: shutdown_lifespan (7 step) ────────────────


async def shutdown_lifespan(
    app: FastAPI,
    settings: Settings,  # 미사용 — startup_lifespan과 시그니처 대칭 (design-principles §9)
    state: LifespanState,
    logger: logging.Logger,
) -> None:
    """main.py lifespan() shutdown 단계 (7 steps).

    graceful_shutdown은 main.py 잔류이므로 함수 레벨 import로 순환 차단.
    """
    # 함수 레벨 import — 모듈 import 시점 순환을 차단 (main.py가 bootstrap 모듈을 import하므로
    # bootstrap이 모듈 상단에서 main을 import하면 순환).
    from soul_server.main import graceful_shutdown

    logger.info("Soulstream shutting down...")

    # UpstreamAdapter 종료
    if state.upstream_adapter:
        await state.upstream_adapter.shutdown()
        if state.upstream_task:
            state.upstream_task.cancel()
            try:
                await state.upstream_task
            except asyncio.CancelledError:
                pass
        logger.info("  UpstreamAdapter stopped")

    # 주기적 정리 태스크 중지
    state.cleanup_task.cancel()
    try:
        await state.cleanup_task
    except asyncio.CancelledError:
        pass

    # Graceful shutdown
    try:
        await graceful_shutdown(app, get_task_manager(), timeout=50.0)
        logger.info("  Graceful shutdown complete")
    except RuntimeError:
        pass  # TaskManager가 초기화되지 않은 경우 (startup 부분 실패 안전 분기)

    # Runner pool 종료
    shutdown_count = await state.pool.shutdown()
    if shutdown_count > 0:
        logger.info(f"  Shut down {shutdown_count} pooled runners")

    # DB 연결 종료
    try:
        await state.session_db.close()
        logger.info("  DB connection closed")
    except Exception:  # noqa: BLE001 — 종료 경로 — 실패 격리
        logger.warning("  Failed to close DB connection", exc_info=True)

    # 오래된 첨부 파일 정리
    cleaned = file_manager.cleanup_old_files(max_age_hours=1)
    if cleaned > 0:
        logger.info(f"  Cleaned up {cleaned} attachment directories")
