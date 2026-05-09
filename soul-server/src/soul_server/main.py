"""
Soulstream - FastAPI Application

Claude Code 원격 실행 서비스.
멀티 클라이언트 지원 구조.

라이프사이클은 ``soul_server.bootstrap`` 모듈의 ``startup_lifespan`` /
``shutdown_lifespan``이 정본이며, 본 모듈의 ``lifespan``은 위임 형태이다.
"""

import asyncio
import os
import time
from pathlib import Path
from contextlib import asynccontextmanager
from fastapi import FastAPI, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from soul_server.api import attachments_router, dashboard_router, create_sessions_router
from soul_server.dashboard.api_router import router as dash_api_router
from soul_server.dashboard.auth_routes import create_soul_server_auth_router
from soul_server.api.tasks import router as tasks_router
from soul_server.api.claude_auth import create_claude_auth_router
from soul_server.service import resource_manager
from soul_server.service.task_manager import get_task_manager
from soul_server.service.session_query_service import get_session_query_service
from soul_server.service.postgres_session_db import get_session_db
from soul_server.models import HealthResponse
from cogito.endpoint import mount_cogito as _mount_cogito
from soul_server.cogito.mcp_tools import cogito_mcp, cogito_api_router
from soul_server.cogito.reflector_setup import reflect as _soulstream_reflector
from soul_server.config import get_settings, setup_logging
from soul_server.bootstrap_lifespan import startup_lifespan, shutdown_lifespan
from soul_common.auth.caller_info import build_system_caller_info

# 설정 로드
settings = get_settings()

# 로깅 설정
logger = setup_logging(settings)

# 서비스 시작 시간 (uptime 계산용)
_start_time = time.time()


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
        running_tasks = get_session_query_service().get_running_tasks()
        active_sessions = [
            {"agent_session_id": t.agent_session_id, "claude_session_id": t.claude_session_id}
            for t in running_tasks
        ]
        active_ids = [t.agent_session_id for t in running_tasks]
        await session_db.mark_running_at_shutdown(active_ids)
        logger.info(f"Graceful shutdown: {len(active_ids)}개 활성 세션 플래그 설정")

        # 각 세션에 종료 예고 intervention 전송
        # F-11D fix(2026-05-09, atom F-11): caller_info에 source="system" 박아 클라이언트가
        # 시스템 발신을 정확히 식별·표시하게 한다 (이전엔 caller_info=None → dashboard owner
        # portrait fallback 결함). avatar_url=None — 클라이언트가 자기 정적 자산으로 표시.
        message = "소울스트림 서버가 재시작될 예정입니다. 현재 작업을 중단하고 대기해주세요."
        system_caller_info = build_system_caller_info(node_id=settings.soulstream_node_id)
        for s in active_sessions:
            try:
                await task_manager.add_intervention(
                    s["agent_session_id"],
                    message,
                    user="system",
                    skip_resume=True,
                    caller_info=system_caller_info,
                )
            except Exception as e:
                logger.warning(f"개입 전송 실패 ({s['agent_session_id']}): {e}")

        # 세션 완료 대기 (최대 timeout 초)
        loop = asyncio.get_running_loop()
        deadline = loop.time() + timeout
        while get_session_query_service().get_running_tasks():
            if loop.time() > deadline:
                logger.warning("Graceful shutdown: timeout 초과, 잔여 세션 강제 취소")
                break
            await asyncio.sleep(1.0)

        # timeout 초과 후 잔여 RUNNING 세션 강제 취소
        if get_session_query_service().get_running_tasks():
            await task_manager.cancel_running_tasks(timeout=5.0)

    except Exception:
        if session_db is not None:
            await session_db.clear_shutdown_flags()
        app.state.is_draining = False
        raise


@asynccontextmanager
async def lifespan(app: FastAPI):
    """애플리케이션 라이프사이클 — 실제 startup/shutdown은 bootstrap 모듈이 정본."""
    state = await startup_lifespan(app, settings, logger)
    try:
        yield
    finally:
        await shutdown_lifespan(app, settings, state, logger)


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
    running_tasks = get_session_query_service().get_running_tasks()

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
