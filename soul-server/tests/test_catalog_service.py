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
        {"id": "f1", "name": "Folder 1", "sort_order": 0, "settings": {}, "parent_folder_id": None},
        {"id": "f2", "name": "Folder 2", "sort_order": 1, "settings": {}, "parent_folder_id": "f1"},
    ])
    db.create_folder = AsyncMock()
    db.update_folder = AsyncMock()
    db.delete_folder = AsyncMock()
    db.assign_session_to_folder = AsyncMock()
    db.rename_session = AsyncMock()
    db.delete_session = AsyncMock()
    db.get_catalog = AsyncMock(return_value={"folders": [], "sessions": {}})
    db.ensure_board_items = AsyncMock()
    db.get_board_items = AsyncMock(return_value=[])
    db.update_board_item_position = AsyncMock()
    db.create_markdown_document = AsyncMock(return_value={
        "document": {"id": "doc-1", "title": "Note", "body": "Body"},
        "boardItem": {
            "id": "markdown:doc-1",
            "folderId": "f1",
            "itemType": "markdown",
            "itemId": "doc-1",
            "x": 40.0,
            "y": 120.0,
            "metadata": {"title": "Note", "preview": "Body"},
        },
    })
    db.get_markdown_document = AsyncMock(return_value=None)
    db.update_markdown_document = AsyncMock(return_value=None)
    db.delete_markdown_document = AsyncMock()
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
        assert result[0] == {"id": "f1", "name": "Folder 1", "sortOrder": 0, "settings": {}, "createdAt": None, "parentFolderId": None}
        assert result[1] == {"id": "f2", "name": "Folder 2", "sortOrder": 1, "settings": {}, "createdAt": None, "parentFolderId": "f1"}
        mock_db.get_all_folders.assert_awaited_once()

    async def test_update_folder_settings(self, catalog_service, mock_db):
        settings = {"excludeFromFeed": True}
        await catalog_service.update_folder("f1", settings=settings)
        mock_db.update_folder.assert_awaited_once_with("f1", settings=settings)


class TestCreateFolder:
    async def test_creates_and_broadcasts(self, catalog_service, mock_db, mock_broadcaster):
        result = await catalog_service.create_folder("Test", 5, parent_folder_id="f1")
        assert result["name"] == "Test"
        assert result["sortOrder"] == 5
        assert result["parentFolderId"] == "f1"
        assert "id" in result
        mock_db.create_folder.assert_awaited_once_with(result["id"], "Test", 5, parent_folder_id="f1")
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

    async def test_updates_parent_folder_id_to_none(self, catalog_service, mock_db):
        await catalog_service.update_folder("f2", parent_folder_id=None)
        mock_db.update_folder.assert_awaited_once_with("f2", parent_folder_id=None)

    async def test_rejects_parent_cycle_before_db_update(self, catalog_service, mock_db):
        mock_db.get_all_folders.return_value = [
            {"id": "a", "name": "A", "sort_order": 0, "settings": {}, "parent_folder_id": None},
            {"id": "b", "name": "B", "sort_order": 1, "settings": {}, "parent_folder_id": "a"},
        ]
        with pytest.raises(ValueError, match="cycle"):
            await catalog_service.update_folder("a", parent_folder_id="b")
        mock_db.update_folder.assert_not_awaited()

    async def test_rejects_self_parent_before_db_update(self, catalog_service, mock_db):
        with pytest.raises(ValueError, match="cycle"):
            await catalog_service.update_folder("a", parent_folder_id="a")
        mock_db.update_folder.assert_not_awaited()

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

    async def test_updates_parent_and_sort_order_together(self, catalog_service, mock_db):
        mock_db.get_all_folders.return_value = [
            {"id": "f1", "name": "Folder 1", "sort_order": 0, "settings": {}, "parent_folder_id": None},
            {"id": "f2", "name": "Folder 2", "sort_order": 1, "settings": {}, "parent_folder_id": None},
        ]
        items = [
            {"id": "f2", "sortOrder": 0, "parentFolderId": None},
            {"id": "f1", "sortOrder": 0, "parentFolderId": "f2"},
        ]
        await catalog_service.reorder_folders(items)

        mock_db.update_folder.assert_any_await("f2", sort_order=0, parent_folder_id=None)
        mock_db.update_folder.assert_any_await("f1", sort_order=0, parent_folder_id="f2")

    async def test_rejects_cycle_before_reorder_update(self, catalog_service, mock_db):
        mock_db.get_all_folders.return_value = [
            {"id": "f1", "name": "Folder 1", "sort_order": 0, "settings": {}, "parent_folder_id": None},
            {"id": "f2", "name": "Folder 2", "sort_order": 1, "settings": {}, "parent_folder_id": "f1"},
        ]

        with pytest.raises(ValueError, match="cycle"):
            await catalog_service.reorder_folders([
                {"id": "f1", "sortOrder": 0, "parentFolderId": "f2"},
            ])

        mock_db.update_folder.assert_not_awaited()

    async def test_rejects_cycle_batch_before_partial_reorder_update(self, catalog_service, mock_db):
        mock_db.get_all_folders.return_value = [
            {"id": "f1", "name": "Folder 1", "sort_order": 0, "settings": {}, "parent_folder_id": None},
            {"id": "f2", "name": "Folder 2", "sort_order": 1, "settings": {}, "parent_folder_id": "f1"},
            {"id": "f3", "name": "Folder 3", "sort_order": 2, "settings": {}, "parent_folder_id": None},
        ]

        with pytest.raises(ValueError, match="cycle"):
            await catalog_service.reorder_folders([
                {"id": "f3", "sortOrder": 0, "parentFolderId": None},
                {"id": "f1", "sortOrder": 0, "parentFolderId": "f2"},
            ])

        mock_db.update_folder.assert_not_awaited()

    async def test_empty_list_noop(self, catalog_service, mock_db, mock_broadcaster):
        await catalog_service.reorder_folders([])
        mock_db.update_folder.assert_not_awaited()
        mock_broadcaster.broadcast.assert_awaited()


class TestDeleteFolder:
    async def test_deletes_and_broadcasts(self, catalog_service, mock_db, mock_broadcaster):
        await catalog_service.delete_folder("f1")
        mock_db.delete_folder.assert_awaited_once_with("f1")
        mock_broadcaster.broadcast.assert_awaited()


class TestListChildFolders:
    async def test_returns_direct_children_only(self, catalog_service, mock_db):
        result = await catalog_service.list_child_folders("f1")
        assert result == [
            {"id": "f2", "name": "Folder 2", "sortOrder": 1, "settings": {}, "createdAt": None, "parentFolderId": "f1"}
        ]


class TestMoveSessionsToFolder:
    async def test_moves_multiple_sessions(self, catalog_service, mock_db, mock_broadcaster):
        await catalog_service.move_sessions_to_folder(["s1", "s2", "s3"], "f1")
        assert mock_db.assign_session_to_folder.await_count == 3
        mock_db.ensure_board_items.assert_awaited_once()
        mock_broadcaster.broadcast.assert_awaited()

    async def test_moves_to_none(self, catalog_service, mock_db):
        await catalog_service.move_sessions_to_folder(["s1"], None)
        mock_db.assign_session_to_folder.assert_awaited_once_with("s1", None)


class TestBoardItems:
    async def test_update_board_item_position_snaps_to_40px_grid(
        self,
        catalog_service,
        mock_db,
        mock_broadcaster,
    ):
        await catalog_service.update_board_item_position("session:s1", 59, 101)

        mock_db.update_board_item_position.assert_awaited_once_with("session:s1", 40.0, 120.0)
        mock_broadcaster.broadcast.assert_awaited()


class TestMarkdownDocuments:
    async def test_create_markdown_document_uses_supplied_snapped_position(
        self,
        catalog_service,
        mock_db,
        mock_broadcaster,
    ):
        result = await catalog_service.create_markdown_document(
            "f1",
            "Note",
            "Body",
            x=57,
            y=121,
        )

        assert result["document"]["title"] == "Note"
        args = mock_db.create_markdown_document.await_args.args
        assert args[1:] == ("f1", "Note", "Body", 40.0, 120.0)
        assert args[0]
        mock_broadcaster.broadcast.assert_awaited()

    async def test_create_markdown_document_without_position_uses_first_open_slot(
        self,
        catalog_service,
        mock_db,
    ):
        mock_db.get_board_items.return_value = [
            {"folderId": "f1", "x": 0, "y": 0},
            {"folderId": "f1", "x": 160, "y": 0},
        ]

        await catalog_service.create_markdown_document("f1", "Note")

        mock_db.ensure_board_items.assert_awaited_once()
        args = mock_db.create_markdown_document.await_args.args
        assert args[4:] == (320.0, 0.0)

    async def test_get_markdown_document_delegates_to_db(self, catalog_service, mock_db):
        mock_db.get_markdown_document.return_value = {"id": "doc-1", "title": "Note", "body": ""}

        result = await catalog_service.get_markdown_document("doc-1")

        assert result == {"id": "doc-1", "title": "Note", "body": ""}
        mock_db.get_markdown_document.assert_awaited_once_with("doc-1")

    async def test_update_markdown_document_broadcasts(self, catalog_service, mock_db, mock_broadcaster):
        mock_db.update_markdown_document.return_value = {"id": "doc-1", "title": "New", "body": "Body"}

        result = await catalog_service.update_markdown_document("doc-1", title="New")

        assert result["title"] == "New"
        mock_db.update_markdown_document.assert_awaited_once_with("doc-1", title="New", body=None)
        mock_broadcaster.broadcast.assert_awaited()

    async def test_delete_markdown_document_broadcasts(self, catalog_service, mock_db, mock_broadcaster):
        await catalog_service.delete_markdown_document("doc-1")

        mock_db.delete_markdown_document.assert_awaited_once_with("doc-1")
        mock_broadcaster.broadcast.assert_awaited()


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


class TestGetFolderSystemPrompt:
    async def test_returns_prompt(self, catalog_service, mock_db):
        mock_db.get_folder = AsyncMock(return_value={
            "id": "f1", "name": "Folder 1", "sort_order": 0,
            "settings": {"folderPrompt": "You are a helpful assistant."},
        })
        result = await catalog_service.get_folder_system_prompt("f1")
        assert result == "You are a helpful assistant."
        mock_db.get_folder.assert_awaited_once_with("f1")

    async def test_returns_none_when_not_set(self, catalog_service, mock_db):
        mock_db.get_folder = AsyncMock(return_value={
            "id": "f1", "name": "Folder 1", "sort_order": 0, "settings": {},
        })
        result = await catalog_service.get_folder_system_prompt("f1")
        assert result is None

    async def test_returns_none_when_settings_is_none(self, catalog_service, mock_db):
        mock_db.get_folder = AsyncMock(return_value={
            "id": "f1", "name": "Folder 1", "sort_order": 0, "settings": None,
        })
        result = await catalog_service.get_folder_system_prompt("f1")
        assert result is None

    async def test_raises_when_folder_not_found(self, catalog_service, mock_db):
        mock_db.get_folder = AsyncMock(return_value=None)
        with pytest.raises(ValueError, match="Folder not found"):
            await catalog_service.get_folder_system_prompt("nonexistent")


class TestSetFolderSystemPrompt:
    async def test_sets_prompt(self, catalog_service, mock_db):
        mock_db.get_folder = AsyncMock(return_value={
            "id": "f1", "name": "Folder 1", "sort_order": 0, "settings": {},
        })
        await catalog_service.set_folder_system_prompt("f1", "New prompt")
        mock_db.update_folder.assert_awaited_once_with("f1", settings={"folderPrompt": "New prompt"})

    async def test_clears_when_empty_string(self, catalog_service, mock_db):
        mock_db.get_folder = AsyncMock(return_value={
            "id": "f1", "name": "Folder 1", "sort_order": 0,
            "settings": {"folderPrompt": "Old prompt"},
        })
        await catalog_service.set_folder_system_prompt("f1", "")
        mock_db.update_folder.assert_awaited_once_with("f1", settings={})

    async def test_clears_when_none(self, catalog_service, mock_db):
        mock_db.get_folder = AsyncMock(return_value={
            "id": "f1", "name": "Folder 1", "sort_order": 0,
            "settings": {"folderPrompt": "Old prompt"},
        })
        await catalog_service.set_folder_system_prompt("f1", None)
        mock_db.update_folder.assert_awaited_once_with("f1", settings={})

    async def test_preserves_other_settings(self, catalog_service, mock_db):
        mock_db.get_folder = AsyncMock(return_value={
            "id": "f1", "name": "Folder 1", "sort_order": 0,
            "settings": {"excludeFromFeed": True, "folderPrompt": "Old"},
        })
        await catalog_service.set_folder_system_prompt("f1", "New prompt")
        mock_db.update_folder.assert_awaited_once_with(
            "f1", settings={"excludeFromFeed": True, "folderPrompt": "New prompt"}
        )

    async def test_raises_when_folder_not_found(self, catalog_service, mock_db):
        mock_db.get_folder = AsyncMock(return_value=None)
        with pytest.raises(ValueError, match="Folder not found"):
            await catalog_service.set_folder_system_prompt("nonexistent", "prompt")


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
