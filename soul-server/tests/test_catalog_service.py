"""Tests for CatalogService."""

from __future__ import annotations

import pytest
from unittest.mock import AsyncMock, MagicMock, patch

from soul_server.service.catalog_service import (
    CatalogService,
    init_catalog_service,
    get_catalog_service,
)


@pytest.fixture
def mock_db():
    db = AsyncMock()
    db.get_all_folders = AsyncMock(return_value=[
        {"id": "f1", "name": "Folder 1", "sort_order": 0, "settings": {}},
        {"id": "f2", "name": "Folder 2", "sort_order": 1, "settings": {}},
    ])
    db.create_folder = AsyncMock()
    db.update_folder = AsyncMock()
    db.delete_folder = AsyncMock()
    db.assign_session_to_folder = AsyncMock()
    db.rename_session = AsyncMock()
    db.delete_session = AsyncMock()
    db.get_catalog = AsyncMock(return_value={"folders": [], "sessions": {}})
    return db


@pytest.fixture
def mock_broadcaster():
    bc = AsyncMock()
    bc.broadcast = AsyncMock(return_value=0)
    bc.emit_session_deleted = AsyncMock(return_value=0)
    return bc


@pytest.fixture
def catalog_service(mock_db, mock_broadcaster):
    return CatalogService(mock_db, mock_broadcaster)


class TestListFolders:
    async def test_returns_formatted_folders(self, catalog_service, mock_db):
        result = await catalog_service.list_folders()
        assert len(result) == 2
        assert result[0] == {"id": "f1", "name": "Folder 1", "sortOrder": 0, "settings": {}, "createdAt": None}
        assert result[1] == {"id": "f2", "name": "Folder 2", "sortOrder": 1, "settings": {}, "createdAt": None}
        mock_db.get_all_folders.assert_awaited_once()

    async def test_update_folder_settings(self, catalog_service, mock_db):
        settings = {"excludeFromFeed": True}
        await catalog_service.update_folder("f1", settings=settings)
        mock_db.update_folder.assert_awaited_once_with("f1", settings=settings)


class TestCreateFolder:
    async def test_creates_and_broadcasts(self, catalog_service, mock_db, mock_broadcaster):
        result = await catalog_service.create_folder("Test", 5)
        assert result["name"] == "Test"
        assert result["sortOrder"] == 5
        assert "id" in result
        mock_db.create_folder.assert_awaited_once()
        mock_broadcaster.broadcast.assert_awaited()


class TestRenameFolder:
    async def test_renames_and_broadcasts(self, catalog_service, mock_db, mock_broadcaster):
        await catalog_service.rename_folder("f1", "New Name")
        mock_db.update_folder.assert_awaited_once_with("f1", name="New Name")
        mock_broadcaster.broadcast.assert_awaited()


class TestUpdateFolder:
    async def test_updates_name_only(self, catalog_service, mock_db):
        await catalog_service.update_folder("f1", name="X")
        mock_db.update_folder.assert_awaited_once_with("f1", name="X")

    async def test_updates_sort_order_only(self, catalog_service, mock_db):
        await catalog_service.update_folder("f1", sort_order=3)
        mock_db.update_folder.assert_awaited_once_with("f1", sort_order=3)

    async def test_updates_both(self, catalog_service, mock_db):
        await catalog_service.update_folder("f1", name="Y", sort_order=2)
        mock_db.update_folder.assert_awaited_once_with("f1", name="Y", sort_order=2)

    async def test_noop_when_no_fields(self, catalog_service, mock_db):
        await catalog_service.update_folder("f1")
        mock_db.update_folder.assert_not_awaited()


class TestReorderFolders:
    async def test_updates_sort_order_and_broadcasts(self, catalog_service, mock_db, mock_broadcaster):
        items = [{"id": "f1", "sortOrder": 2}, {"id": "f2", "sortOrder": 0}]
        await catalog_service.reorder_folders(items)
        assert mock_db.update_folder.await_count == 2
        mock_db.update_folder.assert_any_await("f1", sort_order=2)
        mock_db.update_folder.assert_any_await("f2", sort_order=0)
        mock_broadcaster.broadcast.assert_awaited()

    async def test_empty_list_noop(self, catalog_service, mock_db, mock_broadcaster):
        await catalog_service.reorder_folders([])
        mock_db.update_folder.assert_not_awaited()
        mock_broadcaster.broadcast.assert_awaited()


class TestDeleteFolder:
    async def test_deletes_and_broadcasts(self, catalog_service, mock_db, mock_broadcaster):
        await catalog_service.delete_folder("f1")
        mock_db.delete_folder.assert_awaited_once_with("f1")
        mock_broadcaster.broadcast.assert_awaited()


class TestMoveSessionsToFolder:
    async def test_moves_multiple_sessions(self, catalog_service, mock_db, mock_broadcaster):
        await catalog_service.move_sessions_to_folder(["s1", "s2", "s3"], "f1")
        assert mock_db.assign_session_to_folder.await_count == 3
        mock_broadcaster.broadcast.assert_awaited()

    async def test_moves_to_none(self, catalog_service, mock_db):
        await catalog_service.move_sessions_to_folder(["s1"], None)
        mock_db.assign_session_to_folder.assert_awaited_once_with("s1", None)


class TestRenameSession:
    async def test_renames_and_broadcasts(self, catalog_service, mock_db, mock_broadcaster):
        await catalog_service.rename_session("s1", "New Name")
        mock_db.rename_session.assert_awaited_once_with("s1", "New Name")
        mock_broadcaster.broadcast.assert_awaited()


class TestDeleteSession:
    async def test_deletes_and_broadcasts_both_events(self, catalog_service, mock_db, mock_broadcaster):
        await catalog_service.delete_session("s1")
        mock_db.delete_session.assert_awaited_once_with("s1")
        # catalog_updated 브로드캐스트
        mock_broadcaster.broadcast.assert_awaited()
        # session_deleted 이벤트
        mock_broadcaster.emit_session_deleted.assert_awaited_once_with("s1")


class TestGlobalAccessor:
    def test_get_raises_before_init(self):
        import soul_server.service.catalog_service as mod
        original = mod._catalog_service
        try:
            mod._catalog_service = None
            with pytest.raises(RuntimeError, match="not initialized"):
                get_catalog_service()
        finally:
            mod._catalog_service = original

    def test_init_and_get(self, mock_db, mock_broadcaster):
        import soul_server.service.catalog_service as mod
        original = mod._catalog_service
        try:
            svc = init_catalog_service(mock_db, mock_broadcaster)
            assert get_catalog_service() is svc
        finally:
            mod._catalog_service = original
