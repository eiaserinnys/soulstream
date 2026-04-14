"""Tests for Folders API (/api/catalog/folders)."""

import pytest


class TestListFolders:
    """GET /api/catalog/folders tests."""

    async def test_returns_empty_list(self, client, mock_catalog_service):
        """Returns empty folder list."""
        mock_catalog_service.list_folders.return_value = []

        resp = await client.get("/api/catalog/folders")

        assert resp.status_code == 200
        body = resp.json()
        assert body["folders"] == []

    async def test_returns_folders(self, client, mock_catalog_service):
        """Returns folders from catalog service."""
        mock_catalog_service.list_folders.return_value = [
            {"id": "f1", "name": "Folder 1", "sortOrder": 0},
            {"id": "f2", "name": "Folder 2", "sortOrder": 1},
        ]

        resp = await client.get("/api/catalog/folders")

        assert resp.status_code == 200
        body = resp.json()
        assert len(body["folders"]) == 2
        assert body["folders"][0]["name"] == "Folder 1"


class TestCreateFolder:
    """POST /api/catalog/folders tests."""

    async def test_creates_folder_returns_201(self, client, mock_catalog_service):
        """Creates a folder and returns 201."""
        mock_catalog_service.create_folder.return_value = {
            "id": "new-f",
            "name": "New Folder",
            "sortOrder": 0,
        }

        resp = await client.post(
            "/api/catalog/folders",
            json={"name": "New Folder", "sortOrder": 0},
        )

        assert resp.status_code == 201
        body = resp.json()
        assert body["id"] == "new-f"
        assert body["name"] == "New Folder"
        mock_catalog_service.create_folder.assert_called_once_with("New Folder", 0)

    async def test_creates_folder_default_sort_order(self, client, mock_catalog_service):
        """Creates a folder with default sortOrder=0."""
        mock_catalog_service.create_folder.return_value = {
            "id": "f-default",
            "name": "Default",
            "sortOrder": 0,
        }

        resp = await client.post(
            "/api/catalog/folders",
            json={"name": "Default"},
        )

        assert resp.status_code == 201
        mock_catalog_service.create_folder.assert_called_once_with("Default", 0)


class TestDeleteFolder:
    """DELETE /api/catalog/folders/{id} tests."""

    async def test_deletes_folder(self, client, mock_catalog_service):
        """Deletes a folder and returns success."""
        resp = await client.delete("/api/catalog/folders/f-del")

        assert resp.status_code == 200
        body = resp.json()
        assert body["success"] is True
        mock_catalog_service.delete_folder.assert_called_once_with("f-del")


class TestUpdateFolder:
    """PUT /api/catalog/folders/{id} tests."""

    async def test_renames_folder(self, client, mock_catalog_service):
        """Renames a folder and returns success."""
        resp = await client.put(
            "/api/catalog/folders/f-rename",
            json={"name": "Renamed"},
        )

        assert resp.status_code == 200
        body = resp.json()
        assert body["success"] is True
        mock_catalog_service.update_folder.assert_called_once_with(
            "f-rename", name="Renamed", sort_order=None, settings=None
        )

    async def test_updates_settings(self, client, mock_catalog_service):
        """Updates folder settings and returns success."""
        resp = await client.put(
            "/api/catalog/folders/f-settings",
            json={"settings": {"excludeFromFeed": True}},
        )

        assert resp.status_code == 200
        body = resp.json()
        assert body["success"] is True
        mock_catalog_service.update_folder.assert_called_once_with(
            "f-settings",
            name=None,
            sort_order=None,
            settings={"excludeFromFeed": True},
        )

    async def test_updates_name_and_settings(self, client, mock_catalog_service):
        """Updates both name and settings in a single request."""
        resp = await client.put(
            "/api/catalog/folders/f-both",
            json={"name": "New Name", "settings": {"excludeFromFeed": False}},
        )

        assert resp.status_code == 200
        mock_catalog_service.update_folder.assert_called_once_with(
            "f-both",
            name="New Name",
            sort_order=None,
            settings={"excludeFromFeed": False},
        )
