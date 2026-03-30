"""
soulstream-server 메인 엔트리포인트.

FastAPI 앱 구성, 라이프스팬, 라우터 마운트.
"""

import logging
import time
from contextlib import asynccontextmanager

import uvicorn
from fastapi import FastAPI, WebSocket
from fastapi.middleware.cors import CORSMiddleware

from soul_common.catalog.catalog_service import CatalogService
from soul_common.db.session_db import PostgresSessionDB

from soulstream_server.api.catalog import create_catalog_router
from soulstream_server.api.folders import create_folders_router
from soulstream_server.api.nodes import create_nodes_router
from soulstream_server.api.sessions import create_sessions_router
from soulstream_server.config import get_settings
from soulstream_server.dashboard.auth import create_auth_dep, create_auth_router
from soulstream_server.dashboard.serving import mount_dashboard
from soulstream_server.nodes.node_manager import NodeManager
from soulstream_server.nodes.ws_handler import handle_node_ws
from soulstream_server.service.session_broadcaster import SessionBroadcaster
from soulstream_server.service.session_router import SessionRouter

logger = logging.getLogger(__name__)

_start_time = time.time()


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
        await broadcaster.broadcast({
            "type": "session_created",
            "session": session_info,
            "nodeId": node_id,
        })
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


@asynccontextmanager
async def lifespan(app: FastAPI):
    """앱 라이프스팬: DB 연결, 서비스 초기화."""
    settings = get_settings()

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

    # 라우터 마운트
    app.include_router(
        create_sessions_router(
            db, node_manager, session_router, broadcaster, catalog_service
        )
    )
    app.include_router(create_nodes_router(node_manager, broadcaster))
    app.include_router(create_folders_router(catalog_service))
    app.include_router(create_catalog_router(catalog_service, db, node_manager))

    # Auth 라우터
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

    logger.info(
        "soulstream-server started on %s:%d", settings.host, settings.port
    )

    yield

    # 종료
    broadcaster.disconnect_all()
    await db.close()
    logger.info("soulstream-server stopped")


def create_app() -> FastAPI:
    """FastAPI 앱 생성."""
    app = FastAPI(
        title="soulstream-server",
        description="Claude Code 오케스트레이터",
        lifespan=lifespan,
    )

    # CORS
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # Dashboard (미들웨어 등록은 앱 시작 전에 해야 함)
    settings = get_settings()
    if settings.dashboard_dir:
        mount_dashboard(app, settings.dashboard_dir)

    # WebSocket 엔드포인트
    @app.websocket("/ws/node")
    async def ws_node(websocket: WebSocket):
        await handle_node_ws(websocket, app.state.node_manager)

    # 헬스 체크
    @app.get("/api/health")
    async def health():
        uptime = int(time.time() - _start_time)
        return {
            "status": "ok",
            "version": "0.1.0",
            "uptime_seconds": uptime,
        }

    # AppConfig — unified-dashboard 클라이언트 초기화용
    @app.get("/api/config")
    async def config():
        """대시보드 AppConfig.

        soulstream-server는 orchestrator 모드를 반환한다.
        searchModal은 cogito가 soulstream-server에 없으므로 false.
        """
        return {
            "mode": "orchestrator",
            "auth": {"enabled": settings.is_auth_enabled},
            "features": {
                "configModal": True,
                "searchModal": False,
                "nodePanel": True,
                "nodeGuard": False,
            },
        }

    # Dashboard status — unified-dashboard의 useServerStatus()가 3초마다 폴링하는 엔드포인트.
    # soulstream-server는 graceful_shutdown이 없으므로 is_draining은 항상 False.
    @app.get("/api/status")
    async def api_status():
        return {"is_draining": False, "healthy": True}

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
