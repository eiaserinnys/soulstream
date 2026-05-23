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
from soulstream_server.api.session_serializer import (
    apply_agent_enrichment,
    apply_user_profile_enrichment,
)
from soulstream_server.api.auth_bearer import router as auth_bearer_router
from soulstream_server.api.auth_native import create_native_auth_router
from soulstream_server.api.execute_proxy import create_execute_proxy_router
from soulstream_server.api.catalog import create_catalog_router
from soulstream_server.api.claude_auth import create_claude_auth_router
from soulstream_server.api.cogito import create_cogito_router
from soulstream_server.api.config import create_config_router
from soulstream_server.api.folders import create_folders_router
from soulstream_server.api.nodes import create_nodes_router
from soulstream_server.api.provider_usage import create_provider_usage_router
from soulstream_server.api.push import create_push_router
from soulstream_server.api.sessions import create_sessions_router
from soulstream_server.api.system_portraits import create_system_portraits_router
from soulstream_server.push import ExpoPushProvider, PushNotifier, PushRepository
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
    broadcaster: SessionBroadcaster,
    node_manager: NodeManager,
    event_type: str,
    node_id: str,
    data: dict | None,
) -> None:
    """노드 변경 이벤트를 클라이언트 SSE 형식으로 변환하여 브로드캐스트.

    node_manager._on_session_change가 이벤트 타입을 'node_session_{change_type}'으로
    포장하므로, 클라이언트(useSessionListProvider.ts)가 인식하는 session_* 타입으로 언포장한다.
    모든 이벤트에 대해 broadcast_node_change도 함께 호출(node graph 등에서 사용).

    R-1 fix(2026-05-08): session_created/session_updated wire에 user 프로필
    enrichment를 적용한다. caller_info가 부실한 세션이 라이브로 도착할 때
    노드 owner 정보로 채워 catalog REST와 정합 — 클라이언트 폴백 표시 차단.
    """
    if event_type == "node_session_session_created":
        raw_data = data or {}
        folder_key_present = "folder_id" in raw_data or "folderId" in raw_data
        folder_id = (
            raw_data.get("folder_id")
            if "folder_id" in raw_data
            else raw_data.get("folderId")
        )
        # soul-server adapter._dispatch_broadcast_event는 session_created 이벤트를
        # {"type": "session_created", "agentSessionId": ..., "session": {full_info}} 형태로 전송.
        # "session" 키가 있으면 그것을 추출하고, 없으면 data 자체를 사용.
        session_info = raw_data.get("session") or data
        if isinstance(session_info, dict):
            session_info = {**session_info}
            if folder_key_present:
                session_info["folder_id"] = folder_id
                session_info["folderId"] = folder_id
            # soul-server가 보내는 agentPortraitUrl은 soul-server 로컬 URL(/api/agents/{id}/portrait).
            # 브라우저는 soul-server에 직접 접근할 수 없으므로 프록시 URL로 교체한다.
            # {**session_info, key: value} 패턴은 기존 키도 덮어쓴다.
            agent_id = session_info.get("agentId")
            if agent_id:
                session_info = {
                    **session_info,
                    "agentPortraitUrl": f"/api/nodes/{node_id}/agents/{agent_id}/portrait",
                }
            # R-1 fix: user 프로필 enrichment (catalog REST와 정합).
            # session_info[userName]이 truthy면 헬퍼 NOOP — caller_info 정체성 보존.
            # R-2 fix: emit_session_created가 R-2부터 top-level caller_source를 wire에 박는다
            # (atom b558ca3b). 헬퍼에 forward — 정체성 명시 source는 owner 덮어쓰기 차단.
            apply_user_profile_enrichment(
                session_info,
                node_id=node_id,
                node_manager=node_manager,
                caller_source=(data or {}).get("caller_source"),
            )
            # Phase A backend 정본 단일화 (X-3, atom d7a1ad86 정본 둘 안티패턴 차단):
            # session_created live wire가 _session_to_response와 같은 apply_agent_enrichment
            # helper를 통과하도록 한다. agentId가 truthy일 때 node_manager에서 profile lookup
            # → backend 보강. TS broadcaster(X-1·X-2)가 박은 "claude" default는 lookup 실패
            # 시 보존.
            apply_agent_enrichment(
                session_info,
                agent_id=session_info.get("agentId"),
                node_id=node_id,
                node_manager=node_manager,
            )
        broadcast_data = {
            "type": "session_created",
            "session": session_info,
            "nodeId": node_id,
        }
        # folder_id가 있으면 SSE 이벤트에 포함 (클라이언트가 즉시 올바른 폴더에 배치)
        # Node wire 정본은 snake_case이고, camelCase는 기존 호출자 호환으로 수용한다.
        if folder_key_present:
            broadcast_data["folder_id"] = folder_id
            broadcast_data["folderId"] = folder_id
        recipient_count = await broadcaster.broadcast(broadcast_data)
        # F-B(2026-05-17): broadcast 발사·수신자 수 INFO 로그. 회귀 진단 시 broadcast가
        # 실제로 발사되었는지 결정적으로 확인 가능 (분석 캐시 §7.1 "broadcaster.broadcast
        # 발사 자체 확정 불가" 한계 회피).
        sid_for_log = (
            session_info.get("agentSessionId") if isinstance(session_info, dict) else None
        )
        logger.info(
            "[broadcast] session_created sid=%s node=%s recipients=%d",
            sid_for_log, node_id, recipient_count,
        )
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
        # R-1 fix: emit_session_updated/emit_session_phase 둘 다 type=session_updated wire라
        # NodeConnection._on_session_updated → 같은 분기. 한 곳 fix로 P4·P5 모두 닫힘.
        # spread **(data or {}) 후 호출 — data.userName(soul-server task가 caller_info에서 추출)이
        # truthy면 헬퍼 NOOP (mix-fallback 금지 보존).
        # R-2 fix: spread된 broadcast_data.caller_source(emit_session_updated/phase가 박음)를
        # 헬퍼에 forward — 정체성 명시 source는 owner 덮어쓰기 차단.
        # G-19 fix(2026-05-11): emit_session_message_updated wire는 `last_message` 키를 보유한다
        # (wire payload 키 정본: atom b558ca3b). 본 wire는 메시지 단위 갱신이라 세션 메타
        # (userName/userPortraitUrl)를 의도적으로 비워 보낸다 (P6 결정, session_broadcaster.py
        # `emit_session_message_updated` docstring). 그러나 R-1/R-2 시점에 추가된 본 enrichment
        # 호출은 wire 종류를 구분하지 않아 caller_source=None + userName falsy 조합이 노드 owner
        # fallback을 발동, SessionSummary.userName이 dashboard owner로 매 메시지마다 덮어쓰이던
        # 회로(라이브 재현 sess-20260511075138-3696750a · 327567ed-...).
        # 식별 마커는 `last_message` 키 존재 — emit_session_message_updated wire의 *유일 고유 키*
        # (emit_session_updated/phase는 last_assistant_text/last_progress_text는 박지만 last_message는
        # 절대 박지 않음). 본 가드는 wire payload의 자연적 의미 구조에 기반 — broadcaster는 자기
        # payload 의미만 책임, orch가 해석 (design-principles §1 지식 경계).
        # 회귀 테스트: test_main_on_node_change.py::test_t13/test_t14, N.4 D-2 가이드(atom 9d47010b).
        # data=None 에지: `(data or {}) → {}` → 가드 통과 → enrichment 발동 (baseline T1~T6과 동일).
        if "last_message" not in (data or {}):
            apply_user_profile_enrichment(
                broadcast_data,
                node_id=node_id,
                node_manager=node_manager,
                caller_source=broadcast_data.get("caller_source"),
            )
        recipient_count = await broadcaster.broadcast(broadcast_data)
        # F-B(2026-05-17): broadcast INFO 로그.
        logger.info(
            "[broadcast] session_updated sid=%s node=%s recipients=%d",
            session_id, node_id, recipient_count,
        )
    elif event_type == "node_session_session_deleted":
        # data에 agentSessionId 또는 agent_session_id 두 가지 키가 올 수 있으므로 모두 시도.
        session_id = (data or {}).get("agentSessionId") or (data or {}).get("agent_session_id")
        if session_id:
            recipient_count = await broadcaster.broadcast({
                "type": "session_deleted",
                "agent_session_id": session_id,
            })
            # F-B(2026-05-17): broadcast INFO 로그.
            logger.info(
                "[broadcast] session_deleted sid=%s node=%s recipients=%d",
                session_id, node_id, recipient_count,
            )
        else:
            # F-B(2026-05-17): session_id 누락 시 broadcast skip을 WARN 로그로 노출 — silent
            # skip이 회귀 진단을 막던 회로 차단.
            logger.warning(
                "[broadcast] session_deleted SKIPPED: no session_id from node=%s data_keys=%s",
                node_id, list((data or {}).keys()),
            )

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
    push_repo: PushRepository | None = None,
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
    # R-3 (atom G-5, 2026-05-11): 시스템·봇 source 정체성 아이콘 정적 호스팅 — caller_info.avatar_url
    # 정본 라우트. agent portrait와 §9 대칭으로 verify_auth 의존성 포함.
    app.include_router(create_system_portraits_router(dependencies=api_deps))
    app.include_router(create_config_router(node_manager, dependencies=api_deps))
    app.include_router(create_claude_auth_router(node_manager, dependencies=api_deps))
    app.include_router(create_provider_usage_router(node_manager, dependencies=api_deps))
    app.include_router(create_folders_router(catalog_service, dependencies=api_deps))
    app.include_router(create_catalog_router(catalog_service, db, node_manager, dependencies=api_deps))
    app.include_router(create_attachments_router(node_manager, dependencies=api_deps))
    app.include_router(create_cogito_router(node_manager, dependencies=api_deps))
    app.include_router(create_atom_router(dependencies=api_deps))
    app.include_router(
        create_execute_proxy_router(
            db, node_manager, session_router, catalog_service,
            dependencies=api_deps,
        )
    )

    # 빌드 20: Push 토큰 등록/해제. push_repo가 None이면 라우터를 마운트하지 않음
    # (테스트에서 명시 주입 안 한 경우 — 기존 테스트는 push 기능을 사용하지 않음).
    if push_repo is not None:
        app.include_router(create_push_router(push_repo, dependencies=api_deps))

    # /api/auth/token — 네이티브 JWT handoff.
    # 라우터 내부에서 이미 verify_auth로 보호하므로 여기서 추가 dep을 주입하지 않는다
    # (정본은 하나 — 보호 수준을 라우터가 소유). OAuth 라우터와 유사한 외부 mount 패턴.
    app.include_router(auth_bearer_router)

    # /api/auth/google/native — 모바일 PKCE 인증 (인증 전 단계, dep 면제).
    # google_ios_client_id가 비어 있으면 라우터 미등록 (모바일 미사용 환경 호환).
    if settings.is_auth_enabled and settings.google_ios_client_id:
        app.include_router(
            create_native_auth_router(
                google_ios_client_id=settings.google_ios_client_id,
                jwt_secret=settings.jwt_secret,
            )
        )

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
    # 빌드 20: NodeManager에 allowed_email을 fallback user_email로 전달.
    # soul-server `/api/dashboard/config` 응답이 email을 포함하지 않는 케이스에서
    # PushNotifier가 push_tokens 조회 키로 매칭할 수 있도록 함.
    node_manager = NodeManager(default_user_email=settings.allowed_email)
    broadcaster = SessionBroadcaster()
    session_router = SessionRouter(node_manager)
    catalog_service = CatalogService(session_db=db, broadcaster=broadcaster)

    # 노드 변경 시 브로드캐스트
    async def on_node_change(
        event_type: str, node_id: str, data: dict | None
    ) -> None:
        await _on_node_change(broadcaster, node_manager, event_type, node_id, data)

    node_manager.add_change_listener(on_node_change)

    # 빌드 20: Push 알림 인프라 초기화 + listener 등록.
    # PostgresSessionDB의 pool을 공유하여 새 connection pool을 만들지 않는다.
    push_provider = ExpoPushProvider()
    push_repo = PushRepository(db.pool)
    push_notifier = PushNotifier(
        provider=push_provider, repo=push_repo, node_manager=node_manager
    )
    push_notifier.start()  # node_manager listener 등록

    # 앱 상태에 서비스 저장
    app.state.db = db
    app.state.node_manager = node_manager
    app.state.broadcaster = broadcaster
    app.state.session_router = session_router
    app.state.catalog_service = catalog_service
    app.state.push_repo = push_repo
    app.state.push_notifier = push_notifier

    # 라우터 마운트 (인증 가드 포함)
    _mount_api_routers(
        app,
        db=db,
        node_manager=node_manager,
        session_router=session_router,
        broadcaster=broadcaster,
        catalog_service=catalog_service,
        settings=settings,
        push_repo=push_repo,
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
    push_repo: PushRepository | None = None,
) -> FastAPI:
    """FastAPI 앱 생성.

    - 프로덕션 경로: 의존성 인자 없이 호출 → lifespan이 DB/서비스 생성 후 라우터 마운트.
    - 테스트 경로: mock 의존성을 모두 전달 → lifespan을 우회하고 즉시 라우터 마운트.
      이렇게 하면 conftest.py의 test_app fixture가 프로덕션과 동일한 _mount_api_routers를
      재사용하여 "정본은 하나" 원칙을 지킨다.
    """
    # logging 정본 — uvicorn이 main:app을 직접 import하는 운영 경로에서도 application
    # logger가 INFO로 동작하도록 여기서 root logger를 설정한다. main()의 basicConfig는
    # uvicorn.run을 거치는 CLI 경로에서만 호출되어 운영 경로(start.sh의 python -m uvicorn)
    # 에서는 적용되지 않는다 — 그래서 [push] 등 INFO 로그가 pm2 stderr에 캡처되지 않던 결함을
    # 본 위치에서 종결한다. force=True는 uvicorn이 자체 root handler를 미리 설정한 경우에도
    # 덮어쓰기 위함. uvicorn의 named logger(uvicorn.access/uvicorn.error)는 별도 handler라
    # 영향 받지 않는다. 테스트 경로에서도 동일 설정이 적용되며 멱등.
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        force=True,
    )

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

    # 헬스 체크 — 공개 엔드포인트.
    # 응답에 민감 정보가 없고, 로드밸런서·CI의 표준적 무인증 헬스체크 관행을 따른다.
    @app.get("/api/health")
    async def health():
        uptime = int(time.time() - _start_time)
        return {
            "status": "ok",
            "version": "0.1.0",
            "uptime_seconds": uptime,
        }

    # AppConfig — unified-dashboard 클라이언트 초기화용 (공개 엔드포인트).
    # AppConfigProvider가 로그인 UI를 그리기 위한 설정(mode, nodeId, features.*)을 얻는 경로로,
    # 로그인 전에 호출되어야 한다. 응답 본문에 민감정보 없음.
    @app.get("/api/config")
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
            push_repo=push_repo,
        )

    return app


app = create_app()


def main() -> None:
    """CLI 엔트리포인트.

    logging 설정은 create_app()에서 처리한다 (정본은 하나). uvicorn.run이
    soulstream_server.main:app을 import할 때 모듈 레벨에서 create_app()이
    실행되어 root logger가 설정된다.
    """
    settings = get_settings()
    uvicorn.run(
        "soulstream_server.main:app",
        host=settings.host,
        port=settings.port,
        log_level="info",
    )


if __name__ == "__main__":
    main()
