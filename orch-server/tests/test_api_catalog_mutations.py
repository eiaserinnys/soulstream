"""Tests for catalog mutation endpoints.

PATCH /api/folders/reorder
PUT /api/sessions/folder
PUT /api/sessions/{session_id}
DELETE /api/sessions/{session_id}
"""

import pytest


class TestReorderFolders:
    """PATCH /api/folders/reorder tests."""

    async def test_reorder_folders(self, client, mock_catalog_service):
        """Calls catalog_service.reorder_folders with correct payload."""
        payload = [
            {"id": "f1", "sortOrder": 0, "parentFolderId": None},
            {"id": "f2", "sortOrder": 1, "parentFolderId": "f1"},
            {"id": "f3", "sortOrder": 2},
        ]

        resp = await client.patch("/api/folders/reorder", json=payload)

        assert resp.status_code == 200
        assert resp.json() == {"success": True}
        mock_catalog_service.reorder_folders.assert_called_once_with(
            [
                {"id": "f1", "sortOrder": 0, "parentFolderId": None},
                {"id": "f2", "sortOrder": 1, "parentFolderId": "f1"},
                {"id": "f3", "sortOrder": 2},
            ]
        )

    async def test_reorder_folders_empty(self, client, mock_catalog_service):
        """Accepts empty list."""
        resp = await client.patch("/api/folders/reorder", json=[])

        assert resp.status_code == 200
        mock_catalog_service.reorder_folders.assert_called_once_with([])


class TestBatchMoveSessions:
    """PUT /api/sessions/folder tests."""

    async def test_batch_move_sessions(self, client, mock_catalog_service):
        """Calls catalog_service.move_sessions_to_folder with correct args."""
        payload = {"sessionIds": ["s1", "s2"], "folderId": "f-target"}

        resp = await client.put("/api/sessions/folder", json=payload)

        assert resp.status_code == 200
        assert resp.json() == {"success": True, "count": 2}
        mock_catalog_service.move_sessions_to_folder.assert_called_once_with(
            ["s1", "s2"], "f-target"
        )

    async def test_batch_move_sessions_to_unassigned(self, client, mock_catalog_service):
        """Moves sessions to unassigned (folderId=null)."""
        payload = {"sessionIds": ["s1"], "folderId": None}

        resp = await client.put("/api/sessions/folder", json=payload)

        assert resp.status_code == 200
        assert resp.json() == {"success": True, "count": 1}
        mock_catalog_service.move_sessions_to_folder.assert_called_once_with(["s1"], None)


class TestUpdateSessionCatalog:
    """PUT /api/sessions/{session_id} tests."""

    async def test_update_session_catalog_folder(self, client, mock_catalog_service):
        """Updates session folder assignment."""
        payload = {"folderId": "f-new"}

        resp = await client.put("/api/sessions/sess-123", json=payload)

        assert resp.status_code == 200
        assert resp.json() == {"ok": True}
        mock_catalog_service.move_sessions_to_folder.assert_called_once_with(
            ["sess-123"], "f-new"
        )
        mock_catalog_service.rename_session.assert_not_called()

    async def test_update_session_catalog_display_name(self, client, mock_catalog_service):
        """Updates session display name."""
        payload = {"displayName": "My Session"}

        resp = await client.put("/api/sessions/sess-456", json=payload)

        assert resp.status_code == 200
        assert resp.json() == {"ok": True}
        mock_catalog_service.rename_session.assert_called_once_with("sess-456", "My Session")
        mock_catalog_service.move_sessions_to_folder.assert_not_called()

    async def test_update_session_catalog_null_values(self, client, mock_catalog_service):
        """Explicit null clears folder and display name."""
        payload = {"folderId": None, "displayName": None}

        resp = await client.put("/api/sessions/sess-null", json=payload)

        assert resp.status_code == 200
        mock_catalog_service.move_sessions_to_folder.assert_called_once_with(["sess-null"], None)
        mock_catalog_service.rename_session.assert_called_once_with("sess-null", None)

    async def test_update_session_catalog_both(self, client, mock_catalog_service):
        """Updates both folder and display name."""
        payload = {"folderId": "f-x", "displayName": "Renamed"}

        resp = await client.put("/api/sessions/sess-789", json=payload)

        assert resp.status_code == 200
        mock_catalog_service.move_sessions_to_folder.assert_called_once_with(["sess-789"], "f-x")
        mock_catalog_service.rename_session.assert_called_once_with("sess-789", "Renamed")


class TestDeleteSession:
    """DELETE /api/sessions/{session_id} tests."""

    async def test_delete_session(self, client, mock_catalog_service):
        """Calls catalog_service.delete_session and returns 204."""
        resp = await client.delete("/api/sessions/sess-del")

        assert resp.status_code == 204
        mock_catalog_service.delete_session.assert_called_once_with("sess-del")


class TestBoardItems:
    """PATCH /api/board-items/{id}/position tests."""

    async def test_list_board_items_scoped_to_folder(self, client, mock_catalog_service):
        mock_catalog_service.list_board_items.return_value = [
            {
                "id": "session:s1",
                "folderId": "f1",
                "itemType": "session",
                "itemId": "s1",
                "x": 40,
                "y": 80,
                "metadata": {},
            }
        ]

        resp = await client.get("/api/board-items?folder_id=f1")

        assert resp.status_code == 200
        assert resp.json()["boardItems"] == [
            {
                "id": "session:s1",
                "folderId": "f1",
                "itemType": "session",
                "itemId": "s1",
                "x": 40,
                "y": 80,
                "metadata": {},
            }
        ]
        mock_catalog_service.list_board_items.assert_called_once_with("f1")

    async def test_update_board_item_position(self, client, mock_catalog_service):
        resp = await client.patch(
            "/api/board-items/session:s1/position",
            json={"x": 59, "y": 101},
        )

        assert resp.status_code == 200
        assert resp.json() == {"ok": True}
        mock_catalog_service.update_board_item_position.assert_called_once_with("session:s1", 59, 101)


class TestBoardAssets:
    """Board asset direct-upload routes."""

    async def test_init_board_asset_returns_presigned_put(self, client, mock_catalog_service):
        resp = await client.post(
            "/api/board/f1/assets/init",
            json={"name": "photo.png", "mime": "image/png", "size": 123},
        )

        assert resp.status_code == 201
        assert resp.json()["uploadMode"] == "single"
        assert resp.json()["uploadUrl"] == "https://r2.example/upload"
        mock_catalog_service.init_file_asset.assert_called_once_with(
            folder_id="f1",
            name="photo.png",
            mime_type="image/png",
            byte_size=123,
        )

    async def test_init_board_asset_size_rejection_is_413(self, client, mock_catalog_service):
        mock_catalog_service.init_file_asset.side_effect = ValueError("file size exceeds board asset limit")

        resp = await client.post(
            "/api/board/f1/assets/init",
            json={"name": "large.mov", "mime": "video/quicktime", "size": 999999999},
        )

        assert resp.status_code == 413
        assert "size" in resp.json()["detail"]

    async def test_init_board_asset_without_storage_is_503(self, client, mock_catalog_service):
        mock_catalog_service.init_file_asset.side_effect = RuntimeError("board asset storage is not configured")

        resp = await client.post(
            "/api/board/f1/assets/init",
            json={"name": "photo.png", "mime": "image/png", "size": 123},
        )

        assert resp.status_code == 503
        assert "not configured" in resp.json()["detail"]

    async def test_commit_board_asset_passes_metadata_and_multipart_parts(self, client, mock_catalog_service):
        resp = await client.post(
            "/api/board/f1/assets/asset-1/commit",
            json={
                "x": 41,
                "y": 79,
                "width": 640,
                "height": 480,
                "durationSeconds": 3.5,
                "parts": [
                    {"partNumber": 1, "etag": "etag-1"},
                    {"partNumber": 2, "etag": "etag-2"},
                ],
            },
        )

        assert resp.status_code == 200
        assert resp.json()["boardItem"]["itemType"] == "asset"
        mock_catalog_service.commit_file_asset.assert_called_once_with(
            folder_id="f1",
            asset_id="asset-1",
            x=41,
            y=79,
            width=640,
            height=480,
            duration_seconds=3.5,
            parts=[
                {"partNumber": 1, "etag": "etag-1"},
                {"partNumber": 2, "etag": "etag-2"},
            ],
        )


class TestMarkdownDocuments:
    """Markdown document CRUD routes."""

    async def test_create_markdown_document(self, client, mock_catalog_service):
        resp = await client.post(
            "/api/markdown-documents",
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

    async def test_get_markdown_document(self, client, mock_catalog_service):
        resp = await client.get("/api/markdown-documents/doc-1")

        assert resp.status_code == 200
        assert resp.json()["title"] == "Note"
        mock_catalog_service.get_markdown_document.assert_called_once_with("doc-1")

    async def test_get_markdown_document_404(self, client, mock_catalog_service):
        mock_catalog_service.get_markdown_document.return_value = None

        resp = await client.get("/api/markdown-documents/missing")

        assert resp.status_code == 404

    async def test_update_markdown_document(self, client, mock_catalog_service):
        resp = await client.put(
            "/api/markdown-documents/doc-1",
            json={"title": "New"},
        )

        assert resp.status_code == 200
        assert resp.json()["title"] == "New"
        mock_catalog_service.update_markdown_document.assert_called_once_with(
            "doc-1",
            title="New",
            body=None,
        )

    async def test_update_markdown_document_empty_body_returns_400(self, client, mock_catalog_service):
        resp = await client.put("/api/markdown-documents/doc-1", json={})

        assert resp.status_code == 400
        mock_catalog_service.update_markdown_document.assert_not_called()

    async def test_delete_markdown_document(self, client, mock_catalog_service):
        resp = await client.delete("/api/markdown-documents/doc-1")

        assert resp.status_code == 204
        mock_catalog_service.delete_markdown_document.assert_called_once_with("doc-1")
