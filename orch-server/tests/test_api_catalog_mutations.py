"""Tests for catalog mutation endpoints.

PATCH /api/catalog/folders/reorder
PUT /api/catalog/sessions/batch
PUT /api/catalog/sessions/{session_id}
DELETE /api/catalog/sessions/{session_id}
"""

import pytest


class TestReorderFolders:
    """PATCH /api/catalog/folders/reorder tests."""

    async def test_reorder_folders(self, client, mock_catalog_service):
        """Calls catalog_service.reorder_folders with correct payload."""
        payload = [
            {"id": "f1", "sortOrder": 0},
            {"id": "f2", "sortOrder": 1},
            {"id": "f3", "sortOrder": 2},
        ]

        resp = await client.patch("/api/catalog/folders/reorder", json=payload)

        assert resp.status_code == 200
        assert resp.json() == {"success": True}
        mock_catalog_service.reorder_folders.assert_called_once_with(
            [{"id": "f1", "sortOrder": 0}, {"id": "f2", "sortOrder": 1}, {"id": "f3", "sortOrder": 2}]
        )

    async def test_reorder_folders_empty(self, client, mock_catalog_service):
        """Accepts empty list."""
        resp = await client.patch("/api/catalog/folders/reorder", json=[])

        assert resp.status_code == 200
        mock_catalog_service.reorder_folders.assert_called_once_with([])


class TestBatchMoveSessions:
    """PUT /api/catalog/sessions/batch tests."""

    async def test_batch_move_sessions(self, client, mock_catalog_service):
        """Calls catalog_service.move_sessions_to_folder with correct args."""
        payload = {"sessionIds": ["s1", "s2"], "folderId": "f-target"}

        resp = await client.put("/api/catalog/sessions/batch", json=payload)

        assert resp.status_code == 200
        assert resp.json() == {"ok": True}
        mock_catalog_service.move_sessions_to_folder.assert_called_once_with(
            ["s1", "s2"], "f-target"
        )

    async def test_batch_move_sessions_to_unassigned(self, client, mock_catalog_service):
        """Moves sessions to unassigned (folderId=null)."""
        payload = {"sessionIds": ["s1"], "folderId": None}

        resp = await client.put("/api/catalog/sessions/batch", json=payload)

        assert resp.status_code == 200
        mock_catalog_service.move_sessions_to_folder.assert_called_once_with(["s1"], None)


class TestUpdateSessionCatalog:
    """PUT /api/catalog/sessions/{session_id} tests."""

    async def test_update_session_catalog_folder(self, client, mock_catalog_service):
        """Updates session folder assignment."""
        payload = {"folderId": "f-new"}

        resp = await client.put("/api/catalog/sessions/sess-123", json=payload)

        assert resp.status_code == 200
        assert resp.json() == {"ok": True}
        mock_catalog_service.move_sessions_to_folder.assert_called_once_with(
            ["sess-123"], "f-new"
        )
        mock_catalog_service.rename_session.assert_not_called()

    async def test_update_session_catalog_display_name(self, client, mock_catalog_service):
        """Updates session display name."""
        payload = {"displayName": "My Session"}

        resp = await client.put("/api/catalog/sessions/sess-456", json=payload)

        assert resp.status_code == 200
        assert resp.json() == {"ok": True}
        mock_catalog_service.rename_session.assert_called_once_with("sess-456", "My Session")
        mock_catalog_service.move_sessions_to_folder.assert_not_called()

    async def test_update_session_catalog_both(self, client, mock_catalog_service):
        """Updates both folder and display name."""
        payload = {"folderId": "f-x", "displayName": "Renamed"}

        resp = await client.put("/api/catalog/sessions/sess-789", json=payload)

        assert resp.status_code == 200
        mock_catalog_service.move_sessions_to_folder.assert_called_once_with(["sess-789"], "f-x")
        mock_catalog_service.rename_session.assert_called_once_with("sess-789", "Renamed")


class TestDeleteSession:
    """DELETE /api/catalog/sessions/{session_id} tests."""

    async def test_delete_session(self, client, mock_catalog_service):
        """Calls catalog_service.delete_session and returns 204."""
        resp = await client.delete("/api/catalog/sessions/sess-del")

        assert resp.status_code == 204
        mock_catalog_service.delete_session.assert_called_once_with("sess-del")
