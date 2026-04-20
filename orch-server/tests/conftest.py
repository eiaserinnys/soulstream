"""Common test fixtures for soulstream-server tests."""

import asyncio
import os
from unittest.mock import AsyncMock, MagicMock, patch


# === 테스트 환경 상수 ===
TEST_AUTH_TOKEN = "test-bearer-token-for-testing"


def pytest_configure(config):
    """Set required environment variables for Settings validation.

    셸에 어떤 값이 있든 무조건 덮어쓴다. 부모 프로세스에서 prod .env가 export된 경우
    (예: 봇 프로세스 하위에서 테스트 실행) `if KEY not in os.environ` 가드는 무력해지고,
    테스트가 prod 설정으로 동작하게 된다. 특히 DATABASE_URL이 prod로 새면
    test-db-safety.md 위반이며 데이터 손실 위험이 있다.
    """
    overrides = {
        "HOST": "0.0.0.0",
        "PORT": "5200",
        "DATABASE_URL": "postgresql://test:test@localhost:5432/test",
        # soul-server conftest와 대칭으로 "development"를 사용한다.
        # reset_settings_cache fixture의 assert가 이 값을 요구한다.
        "ENVIRONMENT": "development",
        "AUTH_BEARER_TOKEN": TEST_AUTH_TOKEN,
    }
    for key, value in overrides.items():
        os.environ[key] = value

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from soulstream_server.nodes.node_connection import NodeConnection
from soulstream_server.nodes.node_manager import NodeManager
from soulstream_server.service.session_broadcaster import SessionBroadcaster
from soulstream_server.service.session_router import SessionRouter


@pytest.fixture(scope="session", autouse=True)
def reset_settings_cache():
    """세션 시작 시 settings 캐시 초기화.

    lru_cache된 get_settings가 프로덕션 설정을 캐시했을 수 있으므로
    테스트 시작 전에 초기화한다. soul-server conftest와 동일한 정본 패턴.
    """
    from soulstream_server.config import get_settings

    # 캐시 초기화
    get_settings.cache_clear()

    # 테스트 환경 설정이 적용되었는지 확인
    settings = get_settings()
    assert settings.environment == "development", (
        f"테스트 환경이 development가 아닙니다: {settings.environment}"
    )

    yield

    # 테스트 종료 후 캐시 정리
    get_settings.cache_clear()


@pytest.fixture
def auth_token() -> str:
    """테스트용 인증 토큰 반환."""
    return TEST_AUTH_TOKEN


@pytest.fixture
def auth_headers(auth_token: str) -> dict:
    """인증된 요청을 위한 Authorization 헤더 반환."""
    return {"Authorization": f"Bearer {auth_token}"}


@pytest.fixture
def mock_db():
    """Mock PostgresSessionDB with async methods."""
    db = MagicMock()
    db.get_all_sessions = AsyncMock(return_value=([], 0))
    db.get_session = AsyncMock(return_value=None)
    db.read_events = AsyncMock(return_value=[])
    db.assign_session_to_folder = AsyncMock()
    db.get_all_folders = AsyncMock(return_value=[])
    db.create_folder = AsyncMock()
    db.update_folder = AsyncMock()
    db.delete_folder = AsyncMock()
    db.get_catalog = AsyncMock(return_value={"folders": [], "sessions": {}})
    return db


@pytest.fixture
def mock_ws():
    """Mock FastAPI WebSocket."""
    ws = AsyncMock()
    ws.send_json = AsyncMock()
    ws.close = AsyncMock()
    ws.accept = AsyncMock()
    ws.receive_text = AsyncMock()
    return ws


@pytest.fixture
def mock_node_connection(mock_ws):
    """A NodeConnection with a mock WebSocket."""
    return NodeConnection(
        ws=mock_ws,
        node_id="test-node-1",
        host="localhost",
        port=4100,
        capabilities=["session"],
    )


@pytest.fixture
def node_manager():
    """A real NodeManager instance."""
    return NodeManager()


@pytest.fixture
def session_router(node_manager):
    """SessionRouter with a real NodeManager."""
    return SessionRouter(node_manager)


@pytest.fixture
def mock_catalog_service():
    """Mock CatalogService with async methods."""
    cs = MagicMock()
    cs.list_folders = AsyncMock(return_value=[])
    cs.create_folder = AsyncMock(return_value={"id": "f1", "name": "Test", "sortOrder": 0})
    cs.rename_folder = AsyncMock()
    cs.update_folder = AsyncMock()
    cs.delete_folder = AsyncMock()
    cs.reorder_folders = AsyncMock()
    cs.broadcast_catalog = AsyncMock()
    cs.move_sessions_to_folder = AsyncMock()
    cs.rename_session = AsyncMock()
    cs.delete_session = AsyncMock()
    cs.get_catalog = AsyncMock(return_value={"folders": [], "sessions": {}})
    return cs


@pytest.fixture
def broadcaster():
    """A real SessionBroadcaster instance."""
    return SessionBroadcaster()


@pytest.fixture
def test_app(mock_db, node_manager, session_router, mock_catalog_service, broadcaster):
    """FastAPI test app with all API routers mounted (auth guard included).

    main.create_app을 테스트 모드로 호출하여 프로덕션과 동일한 라우터 구성과
    인증 가드를 재사용한다 ("정본은 하나" 원칙).
    """
    from soulstream_server.main import create_app

    return create_app(
        db=mock_db,
        node_manager=node_manager,
        session_router=session_router,
        broadcaster=broadcaster,
        catalog_service=mock_catalog_service,
    )


@pytest.fixture
async def client(test_app):
    """Async HTTP client for test app.

    기본 Bearer 토큰을 헤더에 포함한다 — 대부분의 테스트는 인증된 요청을
    가정하므로, AsyncClient의 기본 헤더로 인증을 주입하여 개별 호출마다
    headers=auth_headers를 명시하지 않아도 되도록 한다.

    인증 실패 시나리오(test_auth.py)는 `c.headers.pop("Authorization")` 또는
    `headers={"Authorization": "..."}`로 명시적 오버라이드하여 사용한다.
    """
    transport = ASGITransport(app=test_app)
    async with AsyncClient(
        transport=transport,
        base_url="http://test",
        headers={"Authorization": f"Bearer {TEST_AUTH_TOKEN}"},
    ) as c:
        yield c
