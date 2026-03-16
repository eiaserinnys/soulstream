"""
Soulstream - FastAPI Application

Claude Code 원격 실행 서비스.
멀티 클라이언트 지원 구조.
"""

import asyncio
import json
import time
import logging
from pathlib import Path
from contextlib import asynccontextmanager
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from soul_server.api import attachments_router, dashboard_router, create_sessions_router
from soul_server.api.tasks import router as tasks_router
from soul_server.api.credentials import create_credentials_router
from soul_server.api.llm import create_llm_router
from soul_server.api.claude_auth import create_claude_auth_router, AuthSessionManager
from soul_server.llm import OpenAIAdapter, AnthropicAdapter, LlmExecutor
from soul_server.service import resource_manager, file_manager
from soul_server.service.credential_store import CredentialStore
from soul_server.service.credential_swapper import CredentialSwapper
from soul_server.service.rate_limit_tracker import RateLimitTracker
from soul_server.service.engine_adapter import init_soul_engine, get_soul_engine
from soul_server.claude.agent_runner import ClaudeRunner
from soul_server.service.runner_pool import RunnerPool
from soul_server.service.task_manager import init_task_manager, get_task_manager
from soul_server.service.session_broadcaster import init_session_broadcaster
from soul_server.service.event_store import EventStore
from soul_server.models import HealthResponse
from cogito.endpoint import mount_cogito as _mount_cogito
from soul_server.cogito.mcp_tools import cogito_mcp, cogito_api_router, init as init_cogito_mcp
from soul_server.cogito.reflector_setup import reflect as _soulstream_reflector
from soul_server.config import get_settings, setup_logging

# 설정 로드
settings = get_settings()

# 로깅 설정
logger = setup_logging(settings)

# 서비스 시작 시간 (uptime 계산용)
_start_time = time.time()

# 백그라운드 태스크 참조
_cleanup_task = None

# 전역 풀 참조 (/status 엔드포인트에서 접근)
_runner_pool: RunnerPool | None = None

# 전역 LLM executor 참조
_llm_executor: LlmExecutor | None = None

# draining 상태 (신규 세션 거부 중 여부)
_is_draining: bool = False


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


async def graceful_shutdown(task_manager, timeout: float = 50.0):
    """Graceful shutdown 코루틴.

    세 종료 경로(supervisor POST /shutdown, lifespan SIGTERM)에서 공통으로 사용.
    이중 호출 가드로 동시 실행을 방지한다.

    1. draining 상태 설정 (신규 /execute 요청 503 반환)
    2. 활성 세션 목록을 pre_shutdown_sessions.json에 저장 (Phase 2 재기동 시 재개용)
    3. 각 세션에 종료 예고 intervention 전송 (dict 포맷 — engine_adapter가 dict를 기대)
    4. 세션 완료 대기 (최대 timeout 초)
    5. timeout 초과 후 잔여 RUNNING 세션 강제 취소
    """
    global _is_draining

    # 이중 호출 가드 (POST /shutdown과 lifespan 동시 수신 방어)
    if _is_draining:
        return
    _is_draining = True

    try:
        # 활성 세션 목록 저장 (즉시 완료 — 예기치 않은 SIGKILL이 와도 Phase 2 재개 데이터 보존)
        running_tasks = task_manager.get_running_tasks()
        active_sessions = [
            {"agent_session_id": t.agent_session_id, "claude_session_id": t.claude_session_id}
            for t in running_tasks
        ]
        save_path = Path(settings.data_dir) / "pre_shutdown_sessions.json"
        save_path.write_text(json.dumps(active_sessions))
        logger.info(f"Graceful shutdown: {len(active_sessions)}개 활성 세션 저장 → {save_path}")

        # 각 세션에 종료 예고 intervention 전송
        # skip_resume=True로 add_intervention을 호출하여 완료 세션의 auto-resume을 방지한다.
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
        # 예외 발생 시 draining 상태를 복원하여 서버가 영구적으로 /execute를 거부하지 않도록 한다
        save_path.unlink(missing_ok=True)  # 파일이 기록됐을 수 있으므로 정리
        _is_draining = False
        raise


@asynccontextmanager
async def lifespan(app: FastAPI):
    """애플리케이션 라이프사이클 관리"""
    global _cleanup_task

    # Startup
    logger.info("Soulstream starting...")
    logger.info(f"  Version: {settings.version}")
    logger.info(f"  Environment: {settings.environment}")
    logger.info(f"  Max concurrent sessions: {resource_manager.max_concurrent}")
    logger.info(f"  Workspace: {settings.workspace_dir}")

    # RunnerPool 초기화
    global _runner_pool
    mcp_config_path = Path(settings.workspace_dir) / ".mcp.json"
    if not mcp_config_path.exists():
        logger.warning(f"  MCP config not found: {mcp_config_path}")
        mcp_config_path = None
    pool = RunnerPool(
        runner_factory=ClaudeRunner,
        max_size=settings.runner_pool_max_size,
        idle_ttl=settings.runner_pool_idle_ttl,
        workspace_dir=settings.workspace_dir,
        allowed_tools=settings.warmup_allowed_tools,
        disallowed_tools=settings.warmup_disallowed_tools,
        mcp_config_path=mcp_config_path,
        min_generic=settings.runner_pool_min_generic,
        maintenance_interval=settings.runner_pool_maintenance_interval,
    )
    _runner_pool = pool

    # Cogito brief composer (선택 사항)
    brief_composer = None
    if settings.cogito_manifest_path:
        from soul_server.cogito.brief_composer import BriefComposer

        cogito_output_dir = str(Path(settings.workspace_dir) / ".claude" / "rules" / "cogito")
        brief_composer = BriefComposer(
            manifest_path=settings.cogito_manifest_path,
            output_dir=cogito_output_dir,
        )
        init_cogito_mcp(
            brief_composer=brief_composer,
            manifest_path=settings.cogito_manifest_path,
        )
        logger.info(f"  Cogito brief composer: manifest={settings.cogito_manifest_path}")
        logger.info("  Cogito MCP tools: initialized")
    else:
        logger.info("  Cogito brief composer: disabled (COGITO_MANIFEST_PATH not set)")

    init_soul_engine(pool=pool, rate_limit_tracker=_rate_limit_tracker, brief_composer=brief_composer)
    logger.info(
        f"  Runner pool initialized: max_size={settings.runner_pool_max_size}, "
        f"idle_ttl={settings.runner_pool_idle_ttl}s, "
        f"min_generic={settings.runner_pool_min_generic}, "
        f"warmup_tools={settings.warmup_allowed_tools}"
    )

    # Pre-warm: generic runner 예열
    if settings.runner_pool_pre_warm > 0:
        warmed = await pool.pre_warm(settings.runner_pool_pre_warm)
        logger.info(f"  Runner pool pre-warmed: {warmed}/{settings.runner_pool_pre_warm}개")

    # 유지보수 루프 시작
    await pool.start_maintenance()
    logger.info(f"  Runner pool maintenance loop started (interval={settings.runner_pool_maintenance_interval}s)")

    # EventStore 초기화
    data_dir = Path(settings.data_dir)
    events_base_dir = data_dir / "events"
    event_store = EventStore(base_dir=events_base_dir)
    logger.info(f"  EventStore initialized: {events_base_dir}")

    # TaskManager 초기화 및 로드
    storage_path = data_dir / "tasks.json"
    task_manager = init_task_manager(
        storage_path=storage_path,
        event_store=event_store,
        eviction_ttl=settings.session_eviction_ttl_seconds,
    )
    loaded = await task_manager.load()
    logger.info(f"  Loaded {loaded} tasks from storage")

    # SessionBroadcaster 초기화
    # pre_shutdown_sessions 처리보다 먼저 초기화해야 한다.
    # add_intervention() → create_task() → get_session_broadcaster() 경로로 호출되므로,
    # broadcaster가 준비되지 않으면 세션 재개 시 emit 호출이 항상 실패한다.
    broadcaster = init_session_broadcaster()
    logger.info("  SessionBroadcaster initialized")

    # 이전 종료 시 저장된 세션 재개 (graceful_shutdown이 저장한 pre_shutdown_sessions.json)
    # 완료된 세션에 add_intervention()을 호출하면 task_manager의 auto-resume이 새 실행을 생성한다.
    pre_shutdown_file = data_dir / "pre_shutdown_sessions.json"
    if pre_shutdown_file.exists():
        try:
            sessions_to_resume = json.loads(pre_shutdown_file.read_text())
            for s in sessions_to_resume:
                try:
                    result = await task_manager.add_intervention(
                        s["agent_session_id"],
                        "소울스트림 서버 재시작이 완료되었습니다. 이전에 진행하던 작업을 재개해주세요.",
                        user="system",
                    )
                    if result.get("auto_resumed"):
                        await task_manager.start_execution(
                            agent_session_id=s["agent_session_id"],
                            claude_runner=get_soul_engine(),
                            resource_manager=resource_manager,
                        )
                        logger.info(f"  세션 재개 실행 시작: {s['agent_session_id']}")
                except Exception as e:
                    logger.warning(f"  세션 재개 실패 ({s['agent_session_id']}): {e}")
            pre_shutdown_file.unlink()
            logger.info(f"  이전 세션 재개 메시지 전송: {len(sessions_to_resume)}개")
        except Exception as e:
            logger.warning(f"  pre_shutdown_sessions.json 처리 실패: {e}")

    # LLM Proxy 초기화
    global _llm_executor
    llm_adapters: dict = {}
    if settings.llm_openai_api_key:
        llm_adapters["openai"] = OpenAIAdapter(api_key=settings.llm_openai_api_key)
        logger.info("  LLM adapter initialized: openai")
    if settings.llm_anthropic_api_key:
        llm_adapters["anthropic"] = AnthropicAdapter(api_key=settings.llm_anthropic_api_key)
        logger.info("  LLM adapter initialized: anthropic")

    if llm_adapters:
        _llm_executor = LlmExecutor(
            adapters=llm_adapters,
            task_manager=task_manager,
            event_store=event_store,
            session_broadcaster=broadcaster,
        )
        llm_router = create_llm_router(executor=_llm_executor)
        app.include_router(llm_router, tags=["llm"])
        logger.info(f"  LLM proxy initialized: providers={list(llm_adapters.keys())}")
    else:
        logger.info("  LLM proxy skipped: no API keys configured")

    # 주기적 정리 태스크 시작
    _cleanup_task = asyncio.create_task(periodic_cleanup())
    logger.info("  Started periodic cleanup task")

    yield

    # Shutdown
    logger.info("Soulstream shutting down...")

    # 주기적 정리 태스크 중지
    if _cleanup_task:
        _cleanup_task.cancel()
        try:
            await _cleanup_task
        except asyncio.CancelledError:
            pass

    # Graceful shutdown: 실행 중인 세션 정리 (pm2 SIGTERM 경로 — kill_timeout 60초 이내)
    try:
        task_manager = get_task_manager()
        await graceful_shutdown(task_manager, timeout=50.0)
        await task_manager.save()
        logger.info("  Saved tasks to storage")
    except RuntimeError:
        pass  # TaskManager가 초기화되지 않은 경우

    # Runner pool 종료
    shutdown_count = await pool.shutdown()
    if shutdown_count > 0:
        logger.info(f"  Shut down {shutdown_count} pooled runners")

    # 오래된 첨부 파일 정리
    cleaned = file_manager.cleanup_old_files(max_age_hours=1)
    if cleaned > 0:
        logger.info(f"  Cleaned up {cleaned} attachment directories")


app = FastAPI(
    title="Soulstream",
    description="Claude Code remote execution service",
    version=settings.version,
    lifespan=lifespan,
    # 프로덕션에서는 OpenAPI 문서 비활성화
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
else:
    _allowed_origins = ["*"]

app.add_middleware(
    CORSMiddleware,
    allow_origins=_allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def check_draining(request: Request, call_next):
    """드레이닝 중 신규 세션 실행 요청을 거부한다."""
    if _is_draining and request.url.path == "/execute":
        return JSONResponse(
            {"error": "server_draining", "message": "서버 재시작 중입니다. 잠시 후 다시 시도하세요."},
            status_code=503,
        )
    return await call_next(request)


# === Cogito: /reflect endpoints + MCP SSE + REST API ===

# Soulstream 자체 /reflect 엔드포인트 (cogito-manifest.yaml에 등록됨)
_mount_cogito(app, _soulstream_reflector)

# Cogito MCP SSE 서브마운트 (포트 추가 불필요, 기존 4105에 서브경로)
_cogito_sse_app = cogito_mcp.http_app(transport="sse")
app.mount("/cogito-mcp", _cogito_sse_app)

# Cogito REST API (브리프 갱신 등)
app.include_router(cogito_api_router)


# === Health & Status Endpoints ===

@app.post("/shutdown", tags=["health"])
async def shutdown():
    """Graceful shutdown 엔드포인트 (supervisor 전용)"""
    import os

    logger.info("Graceful shutdown 요청 수신")

    async def _do_shutdown():
        # Graceful shutdown + save (lifespan이 실행되지 않는 Windows 경로이므로 직접 처리)
        try:
            task_manager = get_task_manager()
            await graceful_shutdown(task_manager, timeout=50.0)
            await task_manager.save()
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
async def get_status():
    """서비스 상태 조회"""
    task_manager = get_task_manager()
    running_tasks = task_manager.get_running_tasks()

    response: dict = {
        "active_tasks": len(running_tasks),
        "max_concurrent": resource_manager.max_concurrent,
        "is_draining": _is_draining,
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
    if _runner_pool is not None:
        response["runner_pool"] = _runner_pool.stats()

    return response


# === Credential Profile 모듈 ===
# 라우터 등록에 필요하므로 모듈 레벨에서 초기화합니다.
# CredentialStore.__init__은 mkdir만 수행하며, CredentialSwapper.__init__은 참조만 저장합니다.
# (비동기 초기화가 필요한 runner_pool, task_manager 등과는 달리 동기적 초기화만 필요)

_profiles_dir = Path(settings.data_dir) / "profiles"
_credentials_path = Path.home() / ".claude" / ".credentials.json"

_credential_store = CredentialStore(profiles_dir=_profiles_dir)
_credential_swapper = CredentialSwapper(
    store=_credential_store, credentials_path=_credentials_path
)
_rate_limit_tracker = RateLimitTracker(
    store=_credential_store, state_path=_profiles_dir / "_rate_limits.json"
)

# === API Routers ===

# NOTE: tasks_router는 sessions_router 이후에 등록합니다. (아래 참조)

# Attachments API
app.include_router(attachments_router, prefix="/attachments", tags=["attachments"])

# Credentials API - 프로필 관리
credentials_router = create_credentials_router(
    store=_credential_store,
    swapper=_credential_swapper,
    rate_limit_tracker=_rate_limit_tracker,
)
app.include_router(credentials_router, prefix="/profiles", tags=["credentials"])


# Sessions API - 세션 목록 조회/스트리밍
# create_sessions_router() 내부에서 get_task_manager/get_session_broadcaster를
# lazy 싱글톤으로 참조하므로, lifespan 이후 초기화 순서에 무관하게 동작합니다.
sessions_router = create_sessions_router()

# Sessions API를 Task API보다 먼저 등록해야 합니다.
# tasks_router의 GET /sessions/{id}가 sessions_router의 GET /sessions/stream을
# 가로채지 않도록 고정 경로가 먼저 매칭되어야 합니다.
app.include_router(sessions_router, tags=["sessions"])
app.include_router(tasks_router, tags=["tasks"])

# Dashboard API - 프로필 설정 및 초상화 서빙
app.include_router(dashboard_router, prefix="/api", tags=["dashboard"])

# Claude OAuth 토큰 API
auth_session_manager = AuthSessionManager()
claude_auth_router = create_claude_auth_router(session_manager=auth_session_manager)
app.include_router(claude_auth_router, prefix="/auth/claude", tags=["claude-auth"])


# === Exception Handlers ===

@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    """전역 예외 핸들러"""
    logger.exception(f"Unhandled exception: {exc}")

    # 프로덕션에서는 내부 정보 노출 방지
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

    # reload=False 고정: start-dev.ps1이 프로세스를 직접 관리하므로
    # uvicorn reload 불필요. Windows에서 reload=True는 SelectorEventLoop을
    # 강제하여 subprocess(claude_agent_sdk)가 NotImplementedError 발생.
    uvicorn.run(
        "soul_server.main:app",
        host=settings.host,
        port=settings.port,
        reload=False,
        access_log=not settings.is_production,
    )
