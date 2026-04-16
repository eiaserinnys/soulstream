"""
Soulstream - FastAPI Application

Claude Code 원격 실행 서비스.
멀티 클라이언트 지원 구조.
"""

import asyncio
import os
import time
import logging
from pathlib import Path
from contextlib import asynccontextmanager
from fastapi import FastAPI, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from soul_server.api import attachments_router, dashboard_router, create_sessions_router
from soul_server.dashboard.session_cache import SessionCache
from soul_server.dashboard.api_router import router as dash_api_router
from soul_server.dashboard.auth_routes import create_soul_server_auth_router
from soul_server.api.tasks import router as tasks_router
from soul_server.api.claude_auth import create_claude_auth_router
from soul_server.service import resource_manager, file_manager
from soul_server.service.rate_limit_tracker import RateLimitTracker
from soul_server.service.engine_adapter import init_soul_engine
from soul_server.service.task_manager import get_task_manager
from soul_server.service.session_broadcaster import init_session_broadcaster
from soul_server.service.postgres_session_db import get_session_db
from soul_server.models import HealthResponse
from cogito.endpoint import mount_cogito as _mount_cogito
from soul_server.cogito.mcp_tools import cogito_mcp, cogito_api_router
from soul_server.cogito.reflector_setup import reflect as _soulstream_reflector
from soul_server.config import get_settings, setup_logging
from soul_server.bootstrap import (
    bootstrap_runner_pool,
    bootstrap_cogito,
    bootstrap_session_db,
    bootstrap_metadata_extractor,
    bootstrap_agent_registry,
    bootstrap_task_manager,
    bootstrap_llm,
    bootstrap_upstream,
    resume_shutdown_sessions,
)

# 설정 로드
settings = get_settings()

# 로깅 설정
logger = setup_logging(settings)

# 서비스 시작 시간 (uptime 계산용)
_start_time = time.time()


async def periodic_cleanup():
    """주기적 고아 running 세션 보정 (24시간 이상 된 orphaned running 태스크)"""
    while True:
        try:
            await asyncio.sleep(3600)  # 1시간마다 실행
            task_manager = get_task_manager()
            fixed = await task_manager.cleanup_orphaned_running(max_age_hours=24)
            if fixed > 0:
                logger.info(f"Periodic cleanup: fixed {fixed} orphaned running sessions")
        except asyncio.CancelledError:
            break
        except Exception as e:
            logger.exception(f"Periodic cleanup error: {e}")


async def graceful_shutdown(app: FastAPI, task_manager, timeout: float = 50.0):
    """Graceful shutdown 코루틴.

    세 종료 경로(supervisor POST /shutdown, lifespan SIGTERM)에서 공통으로 사용.
    이중 호출 가드로 동시 실행을 방지한다.

    1. draining 상태 설정 (신규 /execute 요청 503 반환)
    2. 활성 세션 목록을 DB에 플래그로 저장 (재기동 시 재개용)
    3. 각 세션에 종료 예고 intervention 전송
    4. 세션 완료 대기 (최대 timeout 초)
    5. timeout 초과 후 잔여 RUNNING 세션 강제 취소
    """
    # 이중 호출 가드 (POST /shutdown과 lifespan 동시 수신 방어)
    if app.state.is_draining:
        return
    app.state.is_draining = True

    session_db = None
    try:
        session_db = get_session_db()

        # 활성 세션을 DB에 플래그로 기록 (SIGKILL이 와도 DB에 남음)
        running_tasks = task_manager.get_running_tasks()
        active_sessions = [
            {"agent_session_id": t.agent_session_id, "claude_session_id": t.claude_session_id}
            for t in running_tasks
        ]
        active_ids = [t.agent_session_id for t in running_tasks]
        await session_db.mark_running_at_shutdown(active_ids)
        logger.info(f"Graceful shutdown: {len(active_ids)}개 활성 세션 플래그 설정")

        # 각 세션에 종료 예고 intervention 전송
        message = "소울스트림 서버가 재시작될 예정입니다. 현재 작업을 중단하고 대기해주세요."
        for s in active_sessions:
            try:
                await task_manager.add_intervention(
                    s["agent_session_id"],
                    message,
                    user="system",
                    skip_resume=True,
                )
            except Exception as e:
                logger.warning(f"개입 전송 실패 ({s['agent_session_id']}): {e}")

        # 세션 완료 대기 (최대 timeout 초)
        loop = asyncio.get_running_loop()
        deadline = loop.time() + timeout
        while task_manager.get_running_tasks():
            if loop.time() > deadline:
                logger.warning("Graceful shutdown: timeout 초과, 잔여 세션 강제 취소")
                break
            await asyncio.sleep(1.0)

        # timeout 초과 후 잔여 RUNNING 세션 강제 취소
        if task_manager.get_running_tasks():
            await task_manager.cancel_running_tasks(timeout=5.0)

    except Exception:
        if session_db is not None:
            await session_db.clear_shutdown_flags()
        app.state.is_draining = False
        raise


@asynccontextmanager
async def lifespan(app: FastAPI):
    """애플리케이션 라이프사이클 관리"""

    # Startup
    logger.info("Soulstream starting...")
    logger.info(f"  Version: {settings.version}")
    logger.info(f"  Environment: {settings.environment}")
    logger.info(f"  Max concurrent sessions: {resource_manager.max_concurrent}")
    logger.info(f"  Workspace: {settings.workspace_dir}")

    # 1. RunnerPool
    pool = bootstrap_runner_pool(settings)

    # 2. Cogito
    brief_composer = bootstrap_cogito(settings)

    # 3. SoulEngine (RunnerPool + RateLimitTracker + Cogito 조합)
    rate_limit_tracker = RateLimitTracker()
    init_soul_engine(pool=pool, rate_limit_tracker=rate_limit_tracker, brief_composer=brief_composer)

    # 4. Pre-warm + Maintenance
    if settings.runner_pool_pre_warm > 0:
        warmed = await pool.pre_warm(settings.runner_pool_pre_warm)
        logger.info(f"  Runner pool pre-warmed: {warmed}/{settings.runner_pool_pre_warm}개")
    await pool.start_maintenance()
    logger.info(f"  Runner pool maintenance loop started (interval={settings.runner_pool_maintenance_interval}s)")

    # 5. SessionDB
    session_db = await bootstrap_session_db(settings)

    # 6. MetadataExtractor
    data_dir = Path(settings.data_dir)
    metadata_extractor = bootstrap_metadata_extractor(data_dir)

    # 7. AgentRegistry
    agent_registry = bootstrap_agent_registry(settings)

    # 8. TaskManager
    task_manager = await bootstrap_task_manager(session_db, settings, metadata_extractor, agent_registry)

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
    app.include_router(catalog_router, prefix="/api/catalog", tags=["catalog"])
    logger.info("  Catalog API registered")

    # 11. 이전 종료 세션 재개
    await resume_shutdown_sessions(session_db, task_manager)

    # 12. LLM Proxy
    llm_executor = await bootstrap_llm(settings, task_manager, session_db, broadcaster, app)

    # 13. SPA 정적 파일 서빙 — LLM 라우터 등록 이후에 마운트
    _dashboard_dir = Path(settings.dashboard_dir)
    if not _dashboard_dir.is_absolute():
        _dashboard_dir = Path.cwd() / _dashboard_dir
    if _dashboard_dir.exists():
        app.mount("/", StaticFiles(directory=str(_dashboard_dir), html=True), name="spa")
        logger.info(f"  Dashboard SPA mounted: {_dashboard_dir}")

    # 14. app.state 초기화
    app.state.runner_pool = pool
    app.state.llm_executor = llm_executor
    app.state.is_draining = False

    # 15. SessionCache
    app.state.session_cache = SessionCache(settings.dashboard_cache_dir)
    logger.info(f"  SessionCache initialized: {settings.dashboard_cache_dir}")

    # 16. 주기적 정리 태스크
    cleanup_task = asyncio.create_task(periodic_cleanup())
    logger.info("  Started periodic cleanup task")

    # 17. UpstreamAdapter
    upstream_adapter, upstream_task = await bootstrap_upstream(
        settings, task_manager, broadcaster, session_db, agent_registry,
    )

    yield

    # ── Shutdown ──────────────────────────────────────────────
    logger.info("Soulstream shutting down...")

    # UpstreamAdapter 종료
    if upstream_adapter:
        await upstream_adapter.shutdown()
        if upstream_task:
            upstream_task.cancel()
            try:
                await upstream_task
            except asyncio.CancelledError:
                pass
        logger.info("  UpstreamAdapter stopped")

    # 주기적 정리 태스크 중지
    cleanup_task.cancel()
    try:
        await cleanup_task
    except asyncio.CancelledError:
        pass

    # Graceful shutdown
    try:
        await graceful_shutdown(app, get_task_manager(), timeout=50.0)
        logger.info("  Graceful shutdown complete")
    except RuntimeError:
        pass  # TaskManager가 초기화되지 않은 경우

    # Runner pool 종료
    shutdown_count = await pool.shutdown()
    if shutdown_count > 0:
        logger.info(f"  Shut down {shutdown_count} pooled runners")

    # DB 연결 종료
    try:
        await session_db.close()
        logger.info("  DB connection closed")
    except Exception:
        logger.warning("  Failed to close DB connection", exc_info=True)

    # 오래된 첨부 파일 정리
    cleaned = file_manager.cleanup_old_files(max_age_hours=1)
    if cleaned > 0:
        logger.info(f"  Cleaned up {cleaned} attachment directories")


app = FastAPI(
    title="Soulstream",
    description="Claude Code remote execution service",
    version=settings.version,
    lifespan=lifespan,
    docs_url="/docs" if not settings.is_production else None,
    redoc_url="/redoc" if not settings.is_production else None,
)

# CORS 설정
if settings.is_production:
    _allowed_origins = [
        "http://localhost:8080",
        "http://localhost:3000",
        "http://127.0.0.1:8080",
        "http://127.0.0.1:3000",
    ]
    extra = [o.strip() for o in os.environ.get("SOUL_ALLOWED_ORIGINS", "").split(",") if o.strip()]
    _allowed_origins = list(set(_allowed_origins + extra))
else:
    _allowed_origins = ["*"]

app.add_middleware(
    CORSMiddleware,
    allow_origins=_allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 순수 ASGI 미들웨어 등록
from soul_server.middleware import CheckDrainingMiddleware, SPAFallbackMiddleware

app.add_middleware(CheckDrainingMiddleware, is_draining_fn=lambda: getattr(app.state, "is_draining", False))
app.add_middleware(SPAFallbackMiddleware, dashboard_dir=settings.dashboard_dir)


# === Cogito: /reflect endpoints + MCP SSE + REST API ===

_mount_cogito(app, _soulstream_reflector)

_cogito_sse_app = cogito_mcp.http_app(transport="sse")
app.mount("/cogito-mcp", _cogito_sse_app)

app.include_router(cogito_api_router)


# === Health & Status Endpoints ===

@app.post("/shutdown", tags=["health"])
async def shutdown(request: Request):
    """Graceful shutdown 엔드포인트 (supervisor 전용)"""
    import os

    logger.info("Graceful shutdown 요청 수신")
    _app = request.app

    async def _do_shutdown():
        try:
            task_manager = get_task_manager()
            await graceful_shutdown(_app, task_manager, timeout=50.0)
        except Exception as e:
            logger.warning(f"Shutdown cleanup error: {e}", exc_info=True)

        os._exit(0)

    asyncio.create_task(_do_shutdown())
    return {"status": "shutting_down"}


@app.get("/health", response_model=HealthResponse, tags=["health"])
async def health_check():
    """헬스 체크 엔드포인트"""
    return HealthResponse(
        status="healthy",
        version=settings.version,
        uptime_seconds=int(time.time() - _start_time),
        environment=settings.environment,
    )


@app.get("/status", tags=["health"])
async def get_status(request: Request):
    """서비스 상태 조회"""
    task_manager = get_task_manager()
    running_tasks = task_manager.get_running_tasks()

    response: dict = {
        "active_tasks": len(running_tasks),
        "max_concurrent": resource_manager.max_concurrent,
        "is_draining": getattr(request.app.state, "is_draining", False),
        "tasks": [
            {
                "client_id": t.client_id,
                "agent_session_id": t.agent_session_id,
                "status": t.status,
                "created_at": t.created_at.isoformat(),
            }
            for t in running_tasks
        ],
    }

    # 풀 통계 추가
    runner_pool = getattr(request.app.state, "runner_pool", None)
    if runner_pool is not None:
        response["runner_pool"] = runner_pool.stats()

    return response


# === API Routers ===

app.include_router(attachments_router, prefix="/attachments", tags=["attachments"])

sessions_router = create_sessions_router()
app.include_router(sessions_router, tags=["sessions"])
app.include_router(tasks_router, tags=["tasks"])

app.include_router(dashboard_router, prefix="/api", tags=["dashboard"])

claude_auth_router = create_claude_auth_router()
app.include_router(claude_auth_router, prefix="/auth/claude", tags=["claude-auth"])

app.include_router(create_soul_server_auth_router())

app.include_router(dash_api_router)

from soul_server.api import agents as agents_module
app.include_router(agents_module.router, tags=["agents"])


# GET / 전용 라우트 — StaticFiles보다 먼저 등록되어 index.html에 no-cache 헤더를 보장한다.
@app.get("/", include_in_schema=False)
async def serve_index_html() -> Response:
    """/ 요청에 index.html을 Cache-Control: no-cache와 함께 반환한다."""
    _d = settings.dashboard_dir
    _p = Path(_d) if Path(_d).is_absolute() else Path.cwd() / _d
    _idx = _p / "index.html"
    if _idx.exists():
        from starlette.responses import HTMLResponse
        return HTMLResponse(
            _idx.read_text(),
            headers={"Cache-Control": "no-cache, no-store, must-revalidate", "Pragma": "no-cache"},
        )
    return Response("Not Found", status_code=404)


# === Exception Handlers ===

@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    """전역 예외 핸들러"""
    logger.exception(f"Unhandled exception: {exc}")

    error_message = (
        "Internal server error"
        if settings.is_production
        else str(exc)
    )

    return JSONResponse(
        status_code=500,
        content={
            "error": {
                "code": "INTERNAL_ERROR",
                "message": error_message,
                "details": {},
            }
        },
    )


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "soul_server.main:app",
        host=settings.host,
        port=settings.port,
        reload=False,
        access_log=not settings.is_production,
    )
