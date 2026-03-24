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
        await broadcaster.broadcast_node_change({
            "type": event_type,
            "nodeId": node_id,
            "data": data,
        })

    node_manager.add_change_listener(on_node_change)

    # 앱 상태에 서비스 저장
    app.state.db = db
    app.state.node_manager = node_manager
    app.state.broadcaster = broadcaster
    app.state.session_router = session_router
    app.state.catalog_service = catalog_service

    # 라우터 마운트
    app.include_router(
        create_sessions_router(db, node_manager, session_router, broadcaster)
    )
    app.include_router(create_nodes_router(node_manager, broadcaster))
    app.include_router(create_folders_router(catalog_service))
    app.include_router(create_catalog_router(catalog_service))

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
