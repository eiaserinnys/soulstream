"""
Catalog API 라우트 핸들러 테스트.

catalog.py 8개 라우트의 HTTP 레벨 동작을 검증한다.
CatalogService 레이어는 mock하고 라우트 핸들러의 역할만 테스트한다:
  - 올바른 서비스 메서드 호출
  - HTTP 상태 코드
  - 요청 파싱 및 응답 포맷

패턴: FastAPI TestClient + mock CatalogService (test_rename_display_name.py 참조).
"""

import pytest
from unittest.mock import AsyncMock, MagicMock
from fastapi import FastAPI
from fastapi.testclient import TestClient

from soul_server.api.catalog import create_catalog_router


@pytest.fixture
def mock_catalog_service():
    """CatalogService mock — catalog.py가 사용하는 메서드만 정의."""
    cs = MagicMock()
    cs.get_catalog = AsyncMock(return_value={"folders": [], "sessions": {}})
    cs.create_folder = AsyncMock(return_value={"id": "f1", "name": "New", "sort_order": 0})
    cs.update_folder = AsyncMock()
    cs.reorder_folders = AsyncMock()
    cs.delete_folder = AsyncMock()
    cs.move_sessions_to_folder = AsyncMock()
    cs.rename_session = AsyncMock()
    cs.delete_session = AsyncMock()
    return cs


@pytest.fixture
def client(mock_catalog_service):
    """TestClient with catalog router mounted at /catalog."""
    app = FastAPI()
    router = create_catalog_router(mock_catalog_service)
    app.include_router(router, prefix="/catalog")
    return TestClient(app)


class TestGetCatalog:
    def test_get_catalog(self, client, mock_catalog_service):
        """GET /catalog → 200 + get_catalog 호출"""
        resp = client.get("/catalog")

        assert resp.status_code == 200
        assert resp.json() == {"folders": [], "sessions": {}}
        mock_catalog_service.get_catalog.assert_called_once()


class TestCreateFolder:
    def test_create_folder(self, client, mock_catalog_service):
        """POST /catalog/folders → 201 + create_folder(name, sort_order)"""
        resp = client.post(
            "/catalog/folders",
            json={"name": "Work", "sort_order": 3},
        )

        assert resp.status_code == 201
        assert resp.json() == {"id": "f1", "name": "New", "sort_order": 0}
        mock_catalog_service.create_folder.assert_called_once_with("Work", 3)


class TestUpdateFolder:
    def test_update_folder_name(self, client, mock_catalog_service):
        """PUT /catalog/folders/f1 {name: "X"} → 200"""
        resp = client.put(
            "/catalog/folders/f1",
            json={"name": "Renamed"},
        )

        assert resp.status_code == 200
        assert resp.json() == {"ok": True}
        mock_catalog_service.update_folder.assert_called_once_with(
            "f1", name="Renamed", sort_order=None, settings=None,
        )

    def test_update_folder_all_none_returns_400(self, client, mock_catalog_service):
        """PUT /catalog/folders/f1 {} → 400 (🔵 에지 #7: 모든 필드 None)"""
        resp = client.put(
            "/catalog/folders/f1",
            json={},
        )

        assert resp.status_code == 400
        assert "No fields to update" in resp.json()["detail"]
        mock_catalog_service.update_folder.assert_not_called()


class TestReorderFolders:
    def test_reorder_folders(self, client, mock_catalog_service):
        """PATCH /catalog/folders/reorder → 200"""
        resp = client.patch(
            "/catalog/folders/reorder",
            json=[
                {"id": "f1", "sortOrder": 0},
                {"id": "f2", "sortOrder": 1},
            ],
        )

        assert resp.status_code == 200
        assert resp.json() == {"ok": True}
        mock_catalog_service.reorder_folders.assert_called_once_with([
            {"id": "f1", "sortOrder": 0},
            {"id": "f2", "sortOrder": 1},
        ])


class TestDeleteFolder:
    def test_delete_folder(self, client, mock_catalog_service):
        """DELETE /catalog/folders/f1 → 204"""
        resp = client.delete("/catalog/folders/f1")

        assert resp.status_code == 204
        mock_catalog_service.delete_folder.assert_called_once_with("f1")


class TestBatchMoveSessions:
    def test_batch_move_sessions(self, client, mock_catalog_service):
        """PUT /catalog/sessions/batch → 200 (🔵 에지 #6: batch가 {session_id}보다 먼저 매칭)"""
        resp = client.put(
            "/catalog/sessions/batch",
            json={"sessionIds": ["s1", "s2"], "folderId": "f1"},
        )

        assert resp.status_code == 200
        assert resp.json() == {"ok": True}
        mock_catalog_service.move_sessions_to_folder.assert_called_once_with(
            ["s1", "s2"], "f1",
        )


class TestUpdateSession:
    def test_update_session_folder(self, client, mock_catalog_service):
        """PUT /catalog/sessions/s1 {folderId: "f1"} → 200"""
        resp = client.put(
            "/catalog/sessions/s1",
            json={"folderId": "f1"},
        )

        assert resp.status_code == 200
        assert resp.json() == {"ok": True}
        mock_catalog_service.move_sessions_to_folder.assert_called_once_with(
            ["s1"], "f1",
        )

    def test_update_session_display_name(self, client, mock_catalog_service):
        """PUT /catalog/sessions/s1 {displayName: "X"} → 200"""
        resp = client.put(
            "/catalog/sessions/s1",
            json={"displayName": "My Session"},
        )

        assert resp.status_code == 200
        assert resp.json() == {"ok": True}
        mock_catalog_service.rename_session.assert_called_once_with("s1", "My Session")


class TestDeleteSession:
    def test_delete_session(self, client, mock_catalog_service):
        """DELETE /catalog/sessions/s1 → 204"""
        resp = client.delete("/catalog/sessions/s1")

        assert resp.status_code == 204
        mock_catalog_service.delete_session.assert_called_once_with("s1")
