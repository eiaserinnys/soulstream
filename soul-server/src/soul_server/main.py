"""
Soulstream - FastAPI Application

Claude Code 원격 실행 서비스.
멀티 클라이언트 지원 구조.
"""

import asyncio
import json
import os
import time
import logging
from pathlib import Path
from contextlib import asynccontextmanager
from typing import Optional
from fastapi import FastAPI, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from soul_server.api import attachments_router, dashboard_router, create_sessions_router
from soul_server.dashboard.session_cache import SessionCache
from soul_server.dashboard.api_router import router as dash_api_router
from soul_server.dashboard.auth_routes import create_soul_server_auth_router
from soul_server.api.tasks import router as tasks_router
from soul_server.api.llm import create_llm_router
from soul_server.api.claude_auth import create_claude_auth_router, AuthSessionManager
from soul_server.llm import OpenAIAdapter, AnthropicAdapter, LlmExecutor
from soul_server.service import resource_manager, file_manager
from soul_server.service.rate_limit_tracker import RateLimitTracker
from soul_server.service.engine_adapter import init_soul_engine, get_soul_engine
from soul_server.claude.agent_runner import ClaudeRunner
from soul_server.service.runner_pool import RunnerPool
from soul_server.service.task_manager import get_task_manager, TaskManager, set_task_manager
from soul_server.service.agent_registry import AgentRegistry, load_agent_registry
from soul_server.service.oauth_token_registry import OAuthTokenRegistry, load_oauth_token_registry
from soul_server.service.session_broadcaster import init_session_broadcaster
from soul_server.service.postgres_session_db import (
    PostgresSessionDB, SqliteSessionDB,
    create_soul_server_session_db, create_soul_server_sqlite_db,
    init_session_db, get_session_db,
)
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

# 전역 AgentRegistry 참조
_agent_registry: Optional[AgentRegistry] = None


def get_agent_registry() -> AgentRegistry:
    """lifespan 이후에는 항상 AgentRegistry 인스턴스가 보장됨."""
    if _agent_registry is None:
        raise RuntimeError("AgentRegistry가 초기화되지 않았습니다. lifespan 이전에 호출되었습니다.")
    return _agent_registry


def set_agent_registry(registry: AgentRegistry) -> None:
    global _agent_registry
    _agent_registry = registry


# 전역 OAuthTokenRegistry 참조
_oauth_token_registry: OAuthTokenRegistry = OAuthTokenRegistry([])


def get_oauth_token_registry() -> OAuthTokenRegistry:
    """OAuthTokenRegistry 인스턴스를 반환한다. degraded mode에서는 빈 레지스트리."""
    return _oauth_token_registry


def set_oauth_token_registry(registry: OAuthTokenRegistry) -> None:
    global _oauth_token_registry
    _oauth_token_registry = registry


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
    app.state.is_draining = True  # /api/status (dashboard)가 이 값을 폴링함

    # session_db를 None으로 초기화하여 except 블록의 None 체크가 가능하게 한다.
    # try 내부에서 get_session_db()를 호출하고 실패 시 session_db가 바인딩되지 않으면
    # except 블록에서 NameError가 발생한다.
    # session_db = None으로 초기화 후 None 체크를 사용하면 이 문제를 해결할 수 있다.
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
        # session_db가 None이면 get_session_db() 자체가 실패한 것이므로 플래그 정리를 건너뛴다
        if session_db is not None:
            await session_db.clear_shutdown_flags()
        _is_draining = False
        app.state.is_draining = False  # except 복구 경로에서도 동기화
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

    # SessionDB 초기화 — database_url 유무로 PostgreSQL / SQLite 분기
    data_dir = Path(settings.data_dir)
    if settings.database_url:
        session_db = create_soul_server_session_db(
            database_url=settings.database_url,
            node_id=settings.soulstream_node_id,
        )
        await session_db.connect()
        await session_db.ensure_default_folders()
        init_session_db(session_db)
        logger.info(f"  PostgresSessionDB initialized: node_id={settings.soulstream_node_id}")

        # 레거시 데이터 자동 이관 (SQLite/JSONL → PostgreSQL) — PostgreSQL 모드에서만 실행
        from soul_server.service.legacy_migrator import auto_migrate

        await auto_migrate(session_db, settings.data_dir)
    else:
        sqlite_path = settings.sqlite_path
        data_dir.mkdir(parents=True, exist_ok=True)
        session_db = create_soul_server_sqlite_db(
            sqlite_path=sqlite_path,
            node_id=settings.soulstream_node_id,
        )
        await session_db.connect()
        await session_db.ensure_default_folders()
        init_session_db(session_db)
        logger.info(f"  SqliteSessionDB initialized: path={sqlite_path}, node_id={settings.soulstream_node_id}")

    # MetadataExtractor 초기화 (부가 기능 — 로드 실패해도 서비스 기동에 영향 없음)
    # DATA_DIR에 환경 특화 규칙이 있으면 우선 사용, 없으면 패키지 기본 규칙으로 폴백
    metadata_extractor = None
    metadata_rules_path = data_dir / "metadata_rules.yaml"
    if not metadata_rules_path.exists():
        metadata_rules_path = Path(__file__).parent.parent.parent / "data" / "metadata_rules.yaml"
    try:
        from soul_server.service.metadata_extractor import MetadataExtractor
        metadata_extractor = MetadataExtractor(metadata_rules_path)
        logger.info(f"  MetadataExtractor loaded: {metadata_rules_path}")
    except FileNotFoundError:
        logger.info(f"  MetadataExtractor skipped: {metadata_rules_path} not found")
    except Exception:
        logger.warning("  MetadataExtractor initialization failed", exc_info=True)

    # AgentRegistry 초기화 (TaskManager보다 먼저 — TaskManager에 주입해야 함)
    if settings.agents_config_file:
        registry = load_agent_registry(settings.agents_config_file)
    else:
        registry = AgentRegistry([])  # degraded mode
    set_agent_registry(registry)
    logger.info(f"  AgentRegistry initialized: {len(registry.list())}개 에이전트")

    # OAuthTokenRegistry 초기화 (TaskManager보다 먼저 — TaskManager/TaskExecutor에 주입해야 함)
    oauth_registry = load_oauth_token_registry(settings.oauth_tokens_config_file)
    set_oauth_token_registry(oauth_registry)
    logger.info(f"  OAuthTokenRegistry initialized: {len(oauth_registry.list_names())}개 프로필")

    # TaskManager 초기화 및 로드
    task_manager = TaskManager(
        session_db=session_db,
        eviction_ttl=settings.session_eviction_ttl_seconds,
        metadata_extractor=metadata_extractor,
        agent_registry=get_agent_registry(),
        oauth_token_registry=get_oauth_token_registry(),
    )
    set_task_manager(task_manager)

    loaded = await task_manager.load()
    logger.info(f"  Loaded {loaded} sessions from DB")

    # 꼬인 읽음 상태 복구 (완료 세션의 last_read_event_id=0 → last_event_id로)
    # 순서 의존: load()가 좀비 세션을 completed로 전환한 뒤에 실행해야
    # 좀비→completed 전환된 세션도 함께 복구된다.
    await session_db.repair_broken_read_positions()

    # SessionBroadcaster 초기화
    # pre_shutdown_sessions 처리보다 먼저 초기화해야 한다.
    # add_intervention() → create_task() → get_session_broadcaster() 경로로 호출되므로,
    # broadcaster가 준비되지 않으면 세션 재개 시 emit 호출이 항상 실패한다.
    broadcaster = init_session_broadcaster(agent_registry=get_agent_registry())
    logger.info("  SessionBroadcaster initialized")

    # CatalogService 초기화
    from soul_server.service.catalog_service import init_catalog_service
    catalog_service = init_catalog_service(session_db, broadcaster)
    logger.info("  CatalogService initialized")

    # 카탈로그 API 라우터 등록
    from soul_server.api.catalog import create_catalog_router
    catalog_router = create_catalog_router(catalog_service)
    app.include_router(catalog_router, prefix="/catalog", tags=["catalog"])
    app.include_router(catalog_router, prefix="/api/catalog", tags=["catalog"])
    logger.info("  Catalog API registered")

    # 이전 종료 시 저장된 세션 재개 (graceful_shutdown이 DB에 플래그로 저장)
    shutdown_sessions = await session_db.get_shutdown_sessions()
    if shutdown_sessions:
        try:
            for s in shutdown_sessions:
                try:
                    result = await task_manager.add_intervention(
                        s["session_id"],
                        "소울스트림 서버 재시작이 완료되었습니다. 이전에 진행하던 작업을 재개해주세요.",
                        user="system",
                    )
                    if result.get("auto_resumed"):
                        await task_manager.start_execution(
                            agent_session_id=s["session_id"],
                            claude_runner=get_soul_engine(),
                            resource_manager=resource_manager,
                        )
                        logger.info(f"  세션 재개 실행 시작: {s['session_id']}")
                except Exception as e:
                    logger.warning(f"  세션 재개 실패 ({s['session_id']}): {e}")
            logger.info(f"  이전 세션 재개 메시지 전송: {len(shutdown_sessions)}개")
        except Exception as e:
            logger.warning(f"  shutdown session resume 실패: {e}")
        finally:
            await session_db.clear_shutdown_flags()

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
            session_db=session_db,
            session_broadcaster=broadcaster,
        )
        llm_router = create_llm_router(executor=_llm_executor)
        app.include_router(llm_router, tags=["llm"])
        logger.info(f"  LLM proxy initialized: providers={list(llm_adapters.keys())}")
    else:
        logger.info("  LLM proxy skipped: no API keys configured")

    # SPA 정적 파일 서빙 — LLM 라우터 등록 이후에 마운트한다.
    # StaticFiles를 "/" 에 먼저 마운트하면 Starlette 라우팅이 삽입 순서대로 매칭하므로
    # POST /llm/completions 같은 API 요청을 StaticFiles가 가로채 405를 반환하게 된다.
    _dashboard_dir_str = settings.dashboard_dir
    _dashboard_dir = Path(_dashboard_dir_str)
    if not _dashboard_dir.is_absolute():
        _dashboard_dir = Path.cwd() / _dashboard_dir
    if _dashboard_dir.exists():
        app.mount("/", StaticFiles(directory=str(_dashboard_dir), html=True), name="spa")
        logger.info(f"  Dashboard SPA mounted: {_dashboard_dir}")

    # Dashboard app.state 초기화 (api_router.py에서 접근)
    app.state.runner_pool = pool
    app.state.llm_executor = _llm_executor if llm_adapters else None
    app.state.is_draining = False  # /api/status (dashboard) 엔드포인트가 이 값을 읽음

    # SessionCache 초기화
    _cache_dir = settings.dashboard_cache_dir
    app.state.session_cache = SessionCache(_cache_dir)
    logger.info(f"  SessionCache initialized: {_cache_dir}")

    # 주기적 정리 태스크 시작
    _cleanup_task = asyncio.create_task(periodic_cleanup())
    logger.info("  Started periodic cleanup task")

    # UpstreamAdapter 시작 (소울스트림 연결)
    upstream_adapter = None
    upstream_task = None
    if settings.soulstream_upstream_enabled:
        from soul_server.cogito.mcp_tools import init_multi_node_tools
        init_multi_node_tools(settings)  # _orch_base 설정 (Phase 2에서 multi-node 툴 등록 추가)
        from soul_server.upstream import UpstreamAdapter

        upstream_adapter = UpstreamAdapter(
            task_manager=task_manager,
            soul_engine=get_soul_engine(),
            resource_manager=resource_manager,
            session_broadcaster=broadcaster,
            upstream_url=settings.soulstream_upstream_url,
            node_id=settings.soulstream_node_id,
            session_db=session_db,
            host=settings.host,
            port=settings.port,
            agent_registry=get_agent_registry(),
            user_name=settings.dash_user_name,
            user_portrait_path=settings.dash_user_portrait,
        )
        upstream_task = asyncio.create_task(upstream_adapter.run())
        logger.info(
            "  UpstreamAdapter started: url=%s, node_id=%s",
            settings.soulstream_upstream_url,
            settings.soulstream_node_id,
        )
    else:
        logger.info("  UpstreamAdapter disabled (standalone mode)")

    yield

    # Shutdown
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
        logger.info("  Graceful shutdown complete")
    except RuntimeError:
        pass  # TaskManager가 초기화되지 않은 경우

    # Runner pool 종료
    shutdown_count = await pool.shutdown()
    if shutdown_count > 0:
        logger.info(f"  Shut down {shutdown_count} pooled runners")

    # PostgreSQL 연결 풀 종료
    try:
        await session_db.close()
        logger.info("  PostgreSQL connection pool closed")
    except Exception:
        logger.warning("  Failed to close PostgreSQL pool", exc_info=True)

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
    # SOUL_ALLOWED_ORIGINS 환경변수에서 추가 오리진 합산
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


# === Rate Limit Tracker ===
_rate_limit_tracker = RateLimitTracker()

# === API Routers ===

# NOTE: tasks_router는 sessions_router 이후에 등록합니다. (아래 참조)

# Attachments API
app.include_router(attachments_router, prefix="/attachments", tags=["attachments"])


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

# Dashboard Auth 라우터 (인증 불필요 — 공개 엔드포인트)
app.include_router(create_soul_server_auth_router())

# Dashboard /api/* 라우터 (기존 dashboard_router와 별개 변수명)
# 등록 순서: GET /api/sessions/stream이 GET /api/sessions/{id}/events보다 먼저 매칭되도록
# api_router.py 내부에서 이미 올바른 순서로 정의되어 있음
app.include_router(dash_api_router)

# Agents API
from soul_server.api import agents as agents_module
app.include_router(agents_module.router, tags=["agents"])

# OAuth Profiles API
from soul_server.api import oauth_profiles as oauth_profiles_module
app.include_router(oauth_profiles_module.router, tags=["oauth-profiles"])

# SPA fallback 미들웨어 — /sess-xxx 같은 클라이언트 라우트에서 index.html을 반환한다.
# StaticFiles(html=True)가 /sess-xxx 에 대해 404를 반환할 때 index.html로 폴백한다.
@app.middleware("http")
async def spa_fallback(request: Request, call_next):
    """SPA fallback — /api/* 이외의 경로에서 404 발생 시 index.html을 반환한다."""
    response = await call_next(request)
    if (
        response.status_code == 404
        and request.method == "GET"
        and not request.url.path.startswith("/api/")
    ):
        _d = settings.dashboard_dir
        _p = Path(_d) if Path(_d).is_absolute() else Path.cwd() / _d
        _idx = _p / "index.html"
        if _idx.exists():
            from starlette.responses import HTMLResponse
            return HTMLResponse(
                _idx.read_text(),
                headers={"Cache-Control": "no-cache, no-store, must-revalidate", "Pragma": "no-cache"},
            )
    return response


# GET / 전용 라우트 — StaticFiles보다 먼저 등록되어 index.html에 no-cache 헤더를 보장한다.
# StaticFiles(html=True)는 FileResponse를 반환하므로 미들웨어에서 헤더 수정이 불가능하다.
# 이 라우트는 StaticFiles Mount보다 등록 순서상 앞에 있으므로 우선 매칭된다.
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
