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
    cs.update_board_item_position = AsyncMock()
    cs.create_markdown_document = AsyncMock(return_value={
        "document": {"id": "doc-1", "title": "Note", "body": "Body"},
        "boardItem": {
            "id": "markdown:doc-1",
            "folderId": "f1",
            "itemType": "markdown",
            "itemId": "doc-1",
            "x": 40,
            "y": 80,
            "metadata": {"title": "Note", "preview": "Body"},
        },
    })
    cs.get_markdown_document = AsyncMock(return_value={"id": "doc-1", "title": "Note", "body": "Body"})
    cs.update_markdown_document = AsyncMock(return_value={"id": "doc-1", "title": "New", "body": "Body"})
    cs.delete_markdown_document = AsyncMock()
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
        mock_catalog_service.create_folder.assert_called_once_with(
            "Work", 3, parent_folder_id=None,
        )

    def test_create_child_folder(self, client, mock_catalog_service):
        """POST /catalog/folders parentFolderId → create_folder에 parent_folder_id 전달"""
        resp = client.post(
            "/catalog/folders",
            json={"name": "Child", "sort_order": 1, "parentFolderId": "parent"},
        )

        assert resp.status_code == 201
        mock_catalog_service.create_folder.assert_called_once_with(
            "Child", 1, parent_folder_id="parent",
        )


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

    def test_update_parent_folder_to_null(self, client, mock_catalog_service):
        """PUT /catalog/folders/f1 {parentFolderId: null} → 루트 승격을 명시 전달"""
        resp = client.put(
            "/catalog/folders/f1",
            json={"parentFolderId": None},
        )

        assert resp.status_code == 200
        mock_catalog_service.update_folder.assert_called_once_with(
            "f1", name=None, sort_order=None, settings=None, parent_folder_id=None,
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
                {"id": "f1", "sortOrder": 0, "parentFolderId": None},
                {"id": "f2", "sortOrder": 1, "parentFolderId": "f1"},
            ],
        )

        assert resp.status_code == 200
        assert resp.json() == {"ok": True}
        mock_catalog_service.reorder_folders.assert_called_once_with([
            {"id": "f1", "sortOrder": 0, "parentFolderId": None},
            {"id": "f2", "sortOrder": 1, "parentFolderId": "f1"},
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


class TestBoardItems:
    def test_update_board_item_position(self, client, mock_catalog_service):
        resp = client.patch(
            "/catalog/board-items/session:s1/position",
            json={"x": 59, "y": 101},
        )

        assert resp.status_code == 200
        assert resp.json() == {"ok": True}
        mock_catalog_service.update_board_item_position.assert_called_once_with("session:s1", 59, 101)


class TestMarkdownDocuments:
    def test_create_markdown_document(self, client, mock_catalog_service):
        resp = client.post(
            "/catalog/markdown-documents",
            json={"folderId": "f1", "title": "Note", "body": "Body", "x": 40, "y": 80},
        )

        assert resp.status_code == 201
        assert resp.json()["document"]["id"] == "doc-1"
        mock_catalog_service.create_markdown_document.assert_called_once_with(
            folder_id="f1",
            title="Note",
            body="Body",
            x=40,
            y=80,
        )

    def test_get_markdown_document(self, client, mock_catalog_service):
        resp = client.get("/catalog/markdown-documents/doc-1")

        assert resp.status_code == 200
        assert resp.json()["title"] == "Note"
        mock_catalog_service.get_markdown_document.assert_called_once_with("doc-1")

    def test_get_markdown_document_404(self, client, mock_catalog_service):
        mock_catalog_service.get_markdown_document.return_value = None

        resp = client.get("/catalog/markdown-documents/missing")

        assert resp.status_code == 404

    def test_update_markdown_document(self, client, mock_catalog_service):
        resp = client.put(
            "/catalog/markdown-documents/doc-1",
            json={"title": "New"},
        )

        assert resp.status_code == 200
        assert resp.json()["title"] == "New"
        mock_catalog_service.update_markdown_document.assert_called_once_with(
            "doc-1",
            title="New",
            body=None,
        )

    def test_update_markdown_document_empty_body_returns_400(self, client, mock_catalog_service):
        resp = client.put("/catalog/markdown-documents/doc-1", json={})

        assert resp.status_code == 400
        mock_catalog_service.update_markdown_document.assert_not_called()

    def test_delete_markdown_document(self, client, mock_catalog_service):
        resp = client.delete("/catalog/markdown-documents/doc-1")

        assert resp.status_code == 204
        mock_catalog_service.delete_markdown_document.assert_called_once_with("doc-1")
