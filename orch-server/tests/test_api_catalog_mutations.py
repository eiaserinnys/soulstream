"""Tests for catalog mutation endpoints.

PATCH /api/folders/reorder
PUT /api/sessions/folder
PUT /api/sessions/{session_id}
DELETE /api/sessions/{session_id}
"""

import pytest
from unittest.mock import AsyncMock, MagicMock, patch

from soul_common.catalog.catalog_service import MarkdownDocumentVersionConflictError

TEST_AUTH_TOKEN = "test-bearer-token-for-testing"


def _make_response(status_code: int, json_body: dict, content_type: str = "application/json"):
    resp = MagicMock()
    resp.status_code = status_code
    resp.content = b"{}"
    resp.headers = {"content-type": content_type}
    resp.json = MagicMock(return_value=json_body)
    return resp


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

    async def test_rejects_system_folder_reorder(self, client, mock_catalog_service):
        """System folders cannot be moved or reordered at the server boundary."""
        payload = [{"id": "claude", "sortOrder": 99}]

        resp = await client.patch("/api/folders/reorder", json=payload)

        assert resp.status_code == 400
        assert "system folder" in resp.json()["detail"].lower()
        mock_catalog_service.reorder_folders.assert_not_called()


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


class TestRunbooks:
    """Runbook read API tests."""

    async def test_get_runbook_my_turn_overview(self, client, mock_db, mock_catalog_service):
        overview = {
            "my_turn_items": [
                {
                    "runbook_id": "rb-1",
                    "runbook_title": "Launch",
                    "board_item_id": "runbook:rb-1",
                    "folder_id": "f1",
                    "section_id": "sec-1",
                    "section_title": "Release",
                    "item_id": "item-1",
                    "item_title": "Operator approval",
                    "how_to": "",
                    "status": "pending",
                    "item_version": 1,
                    "effective_assignee_kind": "human",
                    "effective_assignee_agent_id": None,
                    "effective_assignee_session_id": None,
                    "effective_assignee_user_id": None,
                }
            ],
            "runbooks": [],
        }
        mock_db.get_runbook_overview.return_value = overview

        resp = await client.get("/api/runbooks/my-turn")

        assert resp.status_code == 200
        assert resp.json() == overview
        mock_db.get_runbook_overview.assert_called_once_with(user_id=None, limit=100)
        mock_db.get_runbook_snapshot.assert_not_called()
        mock_catalog_service.list_folders.assert_called_once()

    async def test_get_runbook_snapshot(self, client, mock_db, mock_catalog_service):
        snapshot = {
            "runbook": {
                "id": "rb-1",
                "board_item_id": "runbook:rb-1",
                "folder_id": "f1",
                "title": "Launch",
                "archived": False,
                "version": 1,
                "created_session_id": None,
                "created_event_id": None,
                "created_at": "2026-06-16T00:00:00+00:00",
                "updated_at": "2026-06-16T00:00:00+00:00",
            },
            "sections": [],
            "items": [],
        }
        mock_db.get_runbook_snapshot.return_value = snapshot

        resp = await client.get("/api/runbooks/rb-1")

        assert resp.status_code == 200
        assert resp.json() == snapshot
        mock_db.get_runbook_snapshot.assert_called_once_with("rb-1")
        mock_catalog_service.list_folders.assert_called_once()

    async def test_get_runbook_snapshot_404(self, client, mock_db):
        mock_db.get_runbook_snapshot.return_value = None

        resp = await client.get("/api/runbooks/missing")

        assert resp.status_code == 404
        assert resp.json()["detail"] == "Runbook not found"

    async def test_proxy_runbook_item_status_to_owner_node_with_auth_headers(
        self,
        client,
        mock_db,
        mock_catalog_service,
        node_manager,
    ):
        ws = AsyncMock()
        ws.send_json = AsyncMock()
        ws.close = AsyncMock()
        node = await node_manager.register_node(
            ws,
            {
                "node_id": "node-runbook",
                "host": "localhost",
                "port": 4105,
                "agents": [],
            },
        )
        snapshot = {
            "runbook": {
                "id": "rb-1",
                "board_item_id": "runbook:rb-1",
                "folder_id": "f1",
                "title": "Launch",
                "archived": False,
                "version": 1,
                "created_session_id": "sess-actor",
                "created_event_id": 1,
                "created_at": "2026-06-16T00:00:00+00:00",
                "updated_at": "2026-06-16T00:00:00+00:00",
            },
            "sections": [],
            "items": [{"id": "item-1"}],
        }
        mock_db.get_runbook_snapshot.return_value = snapshot
        mock_db.get_session.return_value = {
            "session_id": "sess-actor",
            "node_id": node.node_id,
        }
        mock_resp = _make_response(200, {"ok": True, "snapshot": snapshot})

        with patch("soulstream_server.api.catalog.httpx.AsyncClient") as mock_client_cls:
            mock_client = AsyncMock()
            mock_client.post = AsyncMock(return_value=mock_resp)
            mock_client_cls.return_value.__aenter__.return_value = mock_client

            resp = await client.post(
                "/api/runbooks/rb-1/items/item-1/status",
                json={
                    "status": "completed",
                    "expectedVersion": 1,
                    "idempotencyKey": "runbook:rb-1:item:item-1:status:completed:v1:test",
                },
            )

        assert resp.status_code == 200
        assert resp.json()["ok"] is True
        called_url, called_kwargs = mock_client.post.call_args
        assert called_url[0] == (
            f"http://{node.host}:{node.port}"
            "/api/runbooks/rb-1/items/item-1/status"
        )
        assert called_kwargs["headers"]["authorization"] == f"Bearer {TEST_AUTH_TOKEN}"
        assert called_kwargs["json"] == {
            "status": "completed",
            "expectedVersion": 1,
            "idempotencyKey": "runbook:rb-1:item:item-1:status:completed:v1:test",
        }
        mock_catalog_service.list_folders.assert_called()

    async def test_proxy_runbook_item_status_falls_back_to_connected_node_when_actor_session_missing(
        self,
        client,
        mock_db,
        node_manager,
    ):
        ws = AsyncMock()
        ws.send_json = AsyncMock()
        ws.close = AsyncMock()
        node = await node_manager.register_node(
            ws,
            {
                "node_id": "node-runbook",
                "host": "localhost",
                "port": 4105,
                "agents": [],
            },
        )
        snapshot = {
            "runbook": {
                "id": "rb-1",
                "board_item_id": "runbook:rb-1",
                "folder_id": "f1",
                "title": "Launch",
                "archived": False,
                "version": 1,
                "created_session_id": "sess-actor-deleted",
                "created_event_id": 1,
                "created_at": "2026-06-16T00:00:00+00:00",
                "updated_at": "2026-06-16T00:00:00+00:00",
            },
            "sections": [],
            "items": [{"id": "item-1"}],
        }
        mock_db.get_runbook_snapshot.return_value = snapshot
        mock_db.get_session.return_value = None
        mock_resp = _make_response(200, {"ok": True, "snapshot": snapshot})

        with patch("soulstream_server.api.catalog.httpx.AsyncClient") as mock_client_cls:
            mock_client = AsyncMock()
            mock_client.post = AsyncMock(return_value=mock_resp)
            mock_client_cls.return_value.__aenter__.return_value = mock_client

            resp = await client.post(
                "/api/runbooks/rb-1/items/item-1/status",
                json={
                    "status": "completed",
                    "expectedVersion": 1,
                    "idempotencyKey": "runbook:rb-1:item:item-1:status:completed:v1:test",
                },
            )

        assert resp.status_code == 200
        assert resp.json()["ok"] is True
        called_url, called_kwargs = mock_client.post.call_args
        assert called_url[0] == (
            f"http://{node.host}:{node.port}"
            "/api/runbooks/rb-1/items/item-1/status"
        )
        assert called_kwargs["json"]["status"] == "completed"


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
        assert resp.json()["version"] == 1
        mock_catalog_service.get_markdown_document.assert_called_once_with("doc-1")

    async def test_get_markdown_document_404(self, client, mock_catalog_service):
        mock_catalog_service.get_markdown_document.return_value = None

        resp = await client.get("/api/markdown-documents/missing")

        assert resp.status_code == 404

    async def test_update_markdown_document(self, client, mock_catalog_service):
        resp = await client.put(
            "/api/markdown-documents/doc-1",
            json={"title": "New", "expectedVersion": 1},
        )

        assert resp.status_code == 200
        assert resp.json()["title"] == "New"
        assert resp.json()["version"] == 2
        mock_catalog_service.update_markdown_document.assert_called_once_with(
            "doc-1",
            title="New",
            body=None,
            expected_version=1,
        )

    async def test_update_markdown_document_missing_expected_version_returns_422(self, client, mock_catalog_service):
        resp = await client.put(
            "/api/markdown-documents/doc-1",
            json={"title": "New"},
        )

        assert resp.status_code == 422
        mock_catalog_service.update_markdown_document.assert_not_called()

    async def test_update_markdown_document_empty_body_returns_400(self, client, mock_catalog_service):
        resp = await client.put("/api/markdown-documents/doc-1", json={})

        assert resp.status_code == 422
        mock_catalog_service.update_markdown_document.assert_not_called()

    async def test_update_markdown_document_stale_version_returns_409(self, client, mock_catalog_service):
        mock_catalog_service.update_markdown_document.side_effect = MarkdownDocumentVersionConflictError(
            "doc-1",
            expected_version=1,
            actual_version=2,
        )

        resp = await client.put(
            "/api/markdown-documents/doc-1",
            json={"body": "Stale", "expectedVersion": 1},
        )

        assert resp.status_code == 409
        assert "version conflict" in resp.json()["detail"]

    async def test_delete_markdown_document(self, client, mock_catalog_service):
        resp = await client.delete("/api/markdown-documents/doc-1")

        assert resp.status_code == 204
        mock_catalog_service.delete_markdown_document.assert_called_once_with("doc-1")
