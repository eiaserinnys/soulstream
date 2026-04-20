"""
soulstream-server 메인 엔트리포인트.

FastAPI 앱 구성, 라이프스팬, 라우터 마운트.
"""

import logging
import time
from contextlib import asynccontextmanager

import uvicorn
from fastapi import Depends, FastAPI, WebSocket
from fastapi.middleware.cors import CORSMiddleware

from soul_common.catalog.catalog_service import CatalogService
from soul_common.db.session_db import PostgresSessionDB

from soulstream_server.api.attachments import create_attachments_router
from soulstream_server.api.atom import create_atom_router
from soulstream_server.api.auth import verify_auth
from soulstream_server.api.auth_bearer import router as auth_bearer_router
from soulstream_server.api.catalog import create_catalog_router
from soulstream_server.api.claude_auth import create_claude_auth_router
from soulstream_server.api.cogito import create_cogito_router
from soulstream_server.api.config import create_config_router
from soulstream_server.api.folders import create_folders_router
from soulstream_server.api.nodes import create_nodes_router
from soulstream_server.api.sessions import create_sessions_router
from soulstream_server.config import Settings, get_settings
from soulstream_server.dashboard.auth import create_auth_router
from soulstream_server.dashboard.serving import mount_dashboard
from soulstream_server.nodes.node_manager import NodeManager
from soulstream_server.nodes.ws_handler import handle_node_ws
from soulstream_server.service.session_broadcaster import SessionBroadcaster
from soulstream_server.service.session_router import SessionRouter

logger = logging.getLogger(__name__)

_start_time = time.time()


def _check_production_cors(settings: Settings) -> None:
    """프로덕션 CORS 가드 — `is_production`이면 cors_allowed_origins가 비어 있지 않아야 한다.

    lifespan 내부에서 DB 연결 전에 호출한다 (fail-fast). 테스트에서는 이 함수를 직접
    호출하여 lifespan 컨텍스트를 진입하지 않고도 동일 조건을 검증할 수 있다.
    """
    if settings.is_production and not settings.cors_allowed_origins:
        raise RuntimeError(
            "CORS_ALLOWED_ORIGINS must be set in production "
            "(set env var as CSV: https://a,https://b)"
        )


async def _on_node_change(
    broadcaster: SessionBroadcaster, event_type: str, node_id: str, data: dict | None
) -> None:
    """노드 변경 이벤트를 클라이언트 SSE 형식으로 변환하여 브로드캐스트.

    node_manager._on_session_change가 이벤트 타입을 'node_session_{change_type}'으로
    포장하므로, 클라이언트(useSessionListProvider.ts)가 인식하는 session_* 타입으로 언포장한다.
    모든 이벤트에 대해 broadcast_node_change도 함께 호출(node graph 등에서 사용).
    """
    if event_type == "node_session_session_created":
        # soul-server adapter._dispatch_broadcast_event는 session_created 이벤트를
        # {"type": "session_created", "agentSessionId": ..., "session": {full_info}} 형태로 전송.
        # "session" 키가 있으면 그것을 추출하고, 없으면 data 자체를 사용.
        session_info = (data or {}).get("session") or data
        # soul-server가 보내는 agentPortraitUrl은 soul-server 로컬 URL(/api/agents/{id}/portrait).
        # 브라우저는 soul-server에 직접 접근할 수 없으므로 프록시 URL로 교체한다.
        # {**session_info, key: value} 패턴은 기존 키도 덮어쓴다.
        agent_id = session_info.get("agentId") if isinstance(session_info, dict) else None
        if agent_id:
            session_info = {
                **session_info,
                "agentPortraitUrl": f"/api/nodes/{node_id}/agents/{agent_id}/portrait",
            }
        broadcast_data = {
            "type": "session_created",
            "session": session_info,
            "nodeId": node_id,
        }
        # folder_id가 있으면 SSE 이벤트에 포함 (클라이언트가 즉시 올바른 폴더에 배치)
        folder_id = (data or {}).get("folderId")
        if folder_id is not None:
            broadcast_data["folder_id"] = folder_id
        await broadcaster.broadcast(broadcast_data)
    elif event_type == "node_session_session_updated":
        # data에 agentSessionId(camelCase)가 오지만 클라이언트는 agent_session_id(snake_case)도 읽으므로
        # 두 키 모두 포함하여 안전하게 전달.
        session_id = (data or {}).get("agentSessionId") or (data or {}).get("agent_session_id")
        broadcast_data = {
            "type": "session_updated",
            **(data or {}),
            "agent_session_id": session_id,
            "nodeId": node_id,
        }
        # session_updated에도 agentPortraitUrl이 포함될 수 있으므로 동일하게 프록시 URL로 교체.
        agent_id = (data or {}).get("agentId")
        if agent_id:
            broadcast_data["agentPortraitUrl"] = f"/api/nodes/{node_id}/agents/{agent_id}/portrait"
        await broadcaster.broadcast(broadcast_data)
    elif event_type == "node_session_session_deleted":
        # data에 agentSessionId 또는 agent_session_id 두 가지 키가 올 수 있으므로 모두 시도.
        session_id = (data or {}).get("agentSessionId") or (data or {}).get("agent_session_id")
        if session_id:
            await broadcaster.broadcast({
                "type": "session_deleted",
                "agent_session_id": session_id,
            })

    # 노드 상태 변경은 기존대로 broadcast_node_change로 전달 (node graph 등에서 사용).
    await broadcaster.broadcast_node_change({
        "type": event_type,
        "nodeId": node_id,
        "data": data,
    })


def _mount_api_routers(
    app: FastAPI,
    *,
    db: PostgresSessionDB,
    node_manager: NodeManager,
    session_router: SessionRouter,
    broadcaster: SessionBroadcaster,
    catalog_service: CatalogService,
    settings: Settings,
) -> None:
    """API 라우터들을 `dependencies=[Depends(verify_auth)]`와 함께 앱에 마운트한다.

    lifespan(프로덕션)과 테스트 fixture 양쪽에서 동일한 라우터 구성을 사용하도록
    분리했다 — 정본은 이 함수 하나다.

    OAuth 라우터(create_auth_router)는 로그인 자체가 인증 전 단계이므로 면제된다.
    """
    api_deps = [Depends(verify_auth)]

    app.include_router(
        create_sessions_router(
            db, node_manager, session_router, broadcaster, catalog_service,
            dependencies=api_deps,
        )
    )
    app.include_router(create_nodes_router(node_manager, broadcaster, dependencies=api_deps))
    app.include_router(create_config_router(node_manager, dependencies=api_deps))
    app.include_router(create_claude_auth_router(node_manager, dependencies=api_deps))
    app.include_router(create_folders_router(catalog_service, dependencies=api_deps))
    app.include_router(create_catalog_router(catalog_service, db, node_manager, dependencies=api_deps))
    app.include_router(create_attachments_router(node_manager, dependencies=api_deps))
    app.include_router(create_cogito_router(node_manager, dependencies=api_deps))
    app.include_router(create_atom_router(dependencies=api_deps))

    # /api/auth/token — 네이티브 JWT handoff.
    # 라우터 내부에서 이미 verify_auth로 보호하므로 여기서 추가 dep을 주입하지 않는다
    # (정본은 하나 — 보호 수준을 라우터가 소유). OAuth 라우터와 유사한 외부 mount 패턴.
    app.include_router(auth_bearer_router)

    # Auth 라우터 (OAuth 로그인 — /api/auth/* 면제 대상)
    if settings.is_auth_enabled:
        auth_router = create_auth_router(
            google_client_id=settings.google_client_id,
            google_client_secret=settings.google_client_secret,
            callback_url=settings.google_callback_url,
            allowed_email=settings.allowed_email,
            jwt_secret=settings.jwt_secret,
            is_development=settings.is_development,
        )
        app.include_router(auth_router)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """앱 라이프스팬: DB 연결, 서비스 초기화, API 라우터 마운트."""
    settings = get_settings()

    # 프로덕션 CORS 가드 — DB 연결 전 fail-fast
    _check_production_cors(settings)

    # DB 연결 (node_id=None → 전역 뷰)
    db = PostgresSessionDB(database_url=settings.database_url, node_id=None)
    await db.connect()
    await db.ensure_default_folders()

    # 서비스 초기화
    node_manager = NodeManager()
    broadcaster = SessionBroadcaster()
    session_router = SessionRouter(node_manager)
    catalog_service = CatalogService(session_db=db, broadcaster=broadcaster)

    # 노드 변경 시 브로드캐스트
    async def on_node_change(
        event_type: str, node_id: str, data: dict | None
    ) -> None:
        await _on_node_change(broadcaster, event_type, node_id, data)

    node_manager.add_change_listener(on_node_change)

    # 앱 상태에 서비스 저장
    app.state.db = db
    app.state.node_manager = node_manager
    app.state.broadcaster = broadcaster
    app.state.session_router = session_router
    app.state.catalog_service = catalog_service

    # 라우터 마운트 (인증 가드 포함)
    _mount_api_routers(
        app,
        db=db,
        node_manager=node_manager,
        session_router=session_router,
        broadcaster=broadcaster,
        catalog_service=catalog_service,
        settings=settings,
    )

    logger.info(
        "soulstream-orch-server started on %s:%d", settings.host, settings.port
    )

    yield

    # 종료
    broadcaster.disconnect_all()
    await db.close()
    logger.info("soulstream-orch-server stopped")


def create_app(
    *,
    db: PostgresSessionDB | None = None,
    node_manager: NodeManager | None = None,
    session_router: SessionRouter | None = None,
    broadcaster: SessionBroadcaster | None = None,
    catalog_service: CatalogService | None = None,
) -> FastAPI:
    """FastAPI 앱 생성.

    - 프로덕션 경로: 의존성 인자 없이 호출 → lifespan이 DB/서비스 생성 후 라우터 마운트.
    - 테스트 경로: mock 의존성을 모두 전달 → lifespan을 우회하고 즉시 라우터 마운트.
      이렇게 하면 conftest.py의 test_app fixture가 프로덕션과 동일한 _mount_api_routers를
      재사용하여 "정본은 하나" 원칙을 지킨다.
    """
    test_mode = all(
        obj is not None
        for obj in (db, node_manager, session_router, broadcaster, catalog_service)
    )

    app = FastAPI(
        title="soulstream-orch-server",
        description="Claude Code 오케스트레이터",
        lifespan=None if test_mode else lifespan,
    )

    settings = get_settings()

    # CORS — 환경변수 기반 허용 origin 목록 + JWT 쿠키 전달을 위한 credentials 허용.
    # 프로덕션에서 빈 값이면 lifespan의 _check_production_cors가 startup을 실패시킨다.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_allowed_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # Dashboard (미들웨어 등록은 앱 시작 전에 해야 함)
    if settings.dashboard_dir:
        mount_dashboard(app, settings.dashboard_dir)

    # WebSocket 엔드포인트 (Phase 2에서 토큰 인증 추가)
    @app.websocket("/ws/node")
    async def ws_node(websocket: WebSocket):
        await handle_node_ws(websocket, app.state.node_manager)

    # 헬스 체크 — 인증 필수 (로드밸런서 헬스체크는 /ws/node 또는 별도 경로 사용 가정)
    @app.get("/api/health", dependencies=[Depends(verify_auth)])
    async def health():
        uptime = int(time.time() - _start_time)
        return {
            "status": "ok",
            "version": "0.1.0",
            "uptime_seconds": uptime,
        }

    # AppConfig — unified-dashboard 클라이언트 초기화용
    @app.get("/api/config", dependencies=[Depends(verify_auth)])
    async def config():
        """대시보드 AppConfig.

        soulstream-server는 orchestrator 모드를 반환한다.
        searchModal은 cogito가 soulstream-server에 없으므로 false.
        """
        return {
            "mode": "orchestrator",
            "nodeId": settings.node_name,  # NODE_NAME env var. 다른 노드 세션 판별에 사용
            "auth": {"enabled": settings.is_auth_enabled},
            "features": {
                "configModal": True,
                "searchModal": True,
                "nodePanel": True,
                "nodeGuard": False,
            },
        }

    # Dashboard status — unified-dashboard의 useServerStatus()가 3초마다 폴링하는 엔드포인트.
    # soulstream-server는 graceful_shutdown이 없으므로 is_draining은 항상 False.
    @app.get("/api/status", dependencies=[Depends(verify_auth)])
    async def api_status():
        return {
            "is_draining": False,
            "healthy": True,
            "atom_enabled": settings.atom_enabled,
        }

    # 테스트 모드: lifespan 우회하고 즉시 라우터 마운트
    if test_mode:
        app.state.db = db
        app.state.node_manager = node_manager
        app.state.broadcaster = broadcaster
        app.state.session_router = session_router
        app.state.catalog_service = catalog_service
        _mount_api_routers(
            app,
            db=db,
            node_manager=node_manager,
            session_router=session_router,
            broadcaster=broadcaster,
            catalog_service=catalog_service,
            settings=settings,
        )

    return app


app = create_app()


def main() -> None:
    """CLI 엔트리포인트."""
    settings = get_settings()
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )
    uvicorn.run(
        "soulstream_server.main:app",
        host=settings.host,
        port=settings.port,
        log_level="info",
    )


if __name__ == "__main__":
    main()
