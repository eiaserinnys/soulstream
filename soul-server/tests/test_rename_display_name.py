"""Tests for PATCH /api/sessions/{session_id}/display-name endpoint.

soul-server에서 soulstream-server 호환 경로를 통해 세션 이름을 변경하는
엔드포인트를 검증한다.

기존 PUT /api/catalog/sessions/{id} (displayName 필드)는 별도 경로로 유지된다.
이 테스트는 새로 추가된 PATCH 경로만 검증한다.
"""

import pytest
from unittest.mock import AsyncMock, patch, MagicMock
from fastapi import FastAPI
from fastapi.testclient import TestClient

from soul_server.dashboard.api_router import router
from soul_server.dashboard.auth import require_dashboard_auth


@pytest.fixture
def mock_catalog():
    """CatalogService mock — get_catalog_service 소스 모듈에서 patch."""
    cs = MagicMock()
    cs.rename_session = AsyncMock()
    # api_router.py 내부에서 `from soul_server.service.catalog_service import get_catalog_service`
    # 로 로컬 임포트하므로 소스 모듈을 패치한다.
    with patch("soul_server.service.catalog_service.get_catalog_service", return_value=cs):
        yield cs


@pytest.fixture
def client(mock_catalog):
    """테스트용 AsyncClient with auth bypassed."""
    app = FastAPI()
    app.include_router(router)

    async def noop():
        pass

    app.dependency_overrides[require_dashboard_auth] = noop
    return TestClient(app)


class TestRenameSessionDisplayName:
    """PATCH /api/sessions/{session_id}/display-name tests."""

    def test_rename_session(self, client, mock_catalog):
        """Calls catalog_service.rename_session and returns success."""
        resp = client.patch(
            "/api/sessions/sess-abc/display-name",
            json={"displayName": "My New Name"},
        )

        assert resp.status_code == 200
        assert resp.json() == {"success": True}
        mock_catalog.rename_session.assert_called_once_with("sess-abc", "My New Name")

    def test_rename_session_null_clears_name(self, client, mock_catalog):
        """displayName=null clears the session name."""
        resp = client.patch(
            "/api/sessions/sess-xyz/display-name",
            json={"displayName": None},
        )

        assert resp.status_code == 200
        mock_catalog.rename_session.assert_called_once_with("sess-xyz", None)
