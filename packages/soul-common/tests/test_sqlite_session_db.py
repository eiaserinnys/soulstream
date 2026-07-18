"""SqliteSessionDB 단위 테스트.

실제 SQLite 인메모리 DB(:memory:)로 전체 인터페이스를 검증한다.
"""

import json
from pathlib import Path

import pytest
import pytest_asyncio

from soul_common.catalog.catalog_service import MarkdownDocumentVersionConflictError
from soul_common.db.sqlite_session_db import SqliteSessionDB

_SCHEMA_PATH = (
    Path(__file__).resolve().parent.parent
    / "src" / "soul_common" / "db" / "sqlite_schema.sql"
)


@pytest_asyncio.fixture
async def db():
    """인메모리 SqliteSessionDB 픽스처."""
    instance = SqliteSessionDB(
        db_path=":memory:",
        node_id="test-node",
        schema_path=_SCHEMA_PATH,
    )
    await instance.connect()
    yield instance
    await instance.close()


class TestConnect:
    async def test_connect_and_close(self):
        instance = SqliteSessionDB(":memory:", schema_path=_SCHEMA_PATH)
        await instance.connect()
        assert instance.conn is not None
        await instance.close()

    async def test_conn_before_connect_raises(self):
        instance = SqliteSessionDB(":memory:")
        with pytest.raises(RuntimeError):
            _ = instance.conn


class TestUpsertAndGetSession:
    async def test_insert_new_session(self, db: SqliteSessionDB):
        await db.upsert_session("sess-1", status="running", session_type="claude")
        result = await db.get_session("sess-1")
        assert result is not None
        assert result["session_id"] == "sess-1"
        assert result["status"] == "running"
        assert result["session_type"] == "claude"

    async def test_upsert_updates_existing(self, db: SqliteSessionDB):
        await db.upsert_session("sess-1", status="running")
        await db.upsert_session("sess-1", status="stopped")
        result = await db.get_session("sess-1")
        assert result["status"] == "stopped"

    async def test_jsonb_field_roundtrip(self, db: SqliteSessionDB):
        meta = {"key": "value", "num": 42}
        await db.upsert_session("sess-2", metadata=meta)
        result = await db.get_session("sess-2")
        assert result["metadata"] == meta

    async def test_boolean_field_roundtrip(self, db: SqliteSessionDB):
        await db.upsert_session("sess-3", was_running_at_shutdown=True)
        result = await db.get_session("sess-3")
        assert result["was_running_at_shutdown"] is True

    async def test_get_nonexistent_returns_none(self, db: SqliteSessionDB):
        result = await db.get_session("no-such-session")
        assert result is None

    async def test_invalid_column_raises(self, db: SqliteSessionDB):
        with pytest.raises(ValueError):
            await db.upsert_session("sess-x", nonexistent_col="val")


class TestGetAllSessions:
    async def test_returns_all(self, db: SqliteSessionDB):
        await db.upsert_session("s1", status="running", session_type="claude")
        await db.upsert_session("s2", status="stopped", session_type="llm")
        sessions, total = await db.get_all_sessions()
        assert total == 2
        assert len(sessions) == 2

    async def test_filter_by_session_type(self, db: SqliteSessionDB):
        await db.upsert_session("s1", session_type="claude")
        await db.upsert_session("s2", session_type="llm")
        sessions, total = await db.get_all_sessions(session_type="claude")
        assert total == 1
        assert sessions[0]["session_id"] == "s1"

    async def test_filter_by_status_list(self, db: SqliteSessionDB):
        await db.upsert_session("s1", status="running")
        await db.upsert_session("s2", status="stopped")
        await db.upsert_session("s3", status="error")
        sessions, total = await db.get_all_sessions(status=["running", "stopped"])
        assert total == 2

    async def test_limit_and_offset(self, db: SqliteSessionDB):
        for i in range(5):
            await db.upsert_session(f"s{i}", status="running")
        sessions, total = await db.get_all_sessions(limit=2, offset=1)
        assert total == 5
        assert len(sessions) == 2


class TestDeleteSession:
    async def test_delete(self, db: SqliteSessionDB):
        await db.upsert_session("sess-del", status="running")
        await db.delete_session("sess-del")
        assert await db.get_session("sess-del") is None


class TestUpdateSessionStatus:
    async def test_update_status(self, db: SqliteSessionDB):
        await db.upsert_session("sess-s", status="running")
        await db.update_session_status("sess-s", "stopped")
        result = await db.get_session("sess-s")
        assert result["status"] == "stopped"


class TestUpdateLastMessage:
    async def test_update_last_message(self, db: SqliteSessionDB):
        await db.upsert_session("sess-m", status="running")
        msg = {"role": "assistant", "text": "hello"}
        await db.update_last_message("sess-m", msg)
        result = await db.get_session("sess-m")
        assert result["last_message"] == msg


class TestAppendEvent:
    async def test_append_returns_sequential_ids(self, db: SqliteSessionDB):
        await db.upsert_session("sess-e", status="running")
        id1 = await db.append_event("sess-e", "text_delta", '{"text":"a"}', "a", "2024-01-01T00:00:00+00:00")
        id2 = await db.append_event("sess-e", "text_delta", '{"text":"b"}', "b", "2024-01-01T00:00:01+00:00")
        assert id1 == 1
        assert id2 == 2

    async def test_append_updates_last_event_id(self, db: SqliteSessionDB):
        await db.upsert_session("sess-e2", status="running")
        await db.append_event("sess-e2", "text_delta", '{}', "", "2024-01-01T00:00:00+00:00")
        result = await db.get_session("sess-e2")
        assert result["last_event_id"] == 1

    async def test_separate_sessions_independent_ids(self, db: SqliteSessionDB):
        await db.upsert_session("sess-a", status="running")
        await db.upsert_session("sess-b", status="running")
        id_a = await db.append_event("sess-a", "text_delta", "{}", "", "2024-01-01T00:00:00+00:00")
        id_b = await db.append_event("sess-b", "text_delta", "{}", "", "2024-01-01T00:00:00+00:00")
        assert id_a == 1
        assert id_b == 1


class TestReadEvents:
    async def test_read_events_after_id(self, db: SqliteSessionDB):
        await db.upsert_session("sess-r", status="running")
        for i in range(3):
            await db.append_event("sess-r", "text_delta", f'{{"i":{i}}}', str(i), "2024-01-01T00:00:00+00:00")
        events = await db.read_events("sess-r", after_id=1)
        assert len(events) == 2
        assert events[0]["id"] == 2

    async def test_read_events_with_limit(self, db: SqliteSessionDB):
        await db.upsert_session("sess-lim", status="running")
        for i in range(5):
            await db.append_event("sess-lim", "text_delta", "{}", "", "2024-01-01T00:00:00+00:00")
        events = await db.read_events("sess-lim", limit=3)
        assert len(events) == 3

    async def test_read_events_filter_by_type(self, db: SqliteSessionDB):
        await db.upsert_session("sess-t", status="running")
        await db.append_event("sess-t", "text_delta", "{}", "", "2024-01-01T00:00:00+00:00")
        await db.append_event("sess-t", "tool_use", "{}", "", "2024-01-01T00:00:01+00:00")
        events = await db.read_events("sess-t", event_types=["text_delta"])
        assert len(events) == 1
        assert events[0]["event_type"] == "text_delta"


class TestReadLastEventOfType:
    """read_last_event_of_type: 특정 type의 마지막 이벤트 조회 (prompt_suggestion baseline 복원용)"""

    async def test_returns_none_when_empty(self, db: SqliteSessionDB):
        await db.upsert_session("sess-empty", status="running")
        result = await db.read_last_event_of_type("sess-empty", "prompt_suggestion")
        assert result is None

    async def test_returns_none_when_type_absent(self, db: SqliteSessionDB):
        await db.upsert_session("sess-no-match", status="running")
        await db.append_event("sess-no-match", "text_delta", "{}", "", "2024-01-01T00:00:00+00:00")
        result = await db.read_last_event_of_type("sess-no-match", "prompt_suggestion")
        assert result is None

    async def test_returns_last_match_among_multiple(self, db: SqliteSessionDB):
        await db.upsert_session("sess-multi", status="running")
        await db.append_event("sess-multi", "prompt_suggestion", '{"text":"first"}', "first", "2024-01-01T00:00:00+00:00")
        await db.append_event("sess-multi", "text_delta", "{}", "", "2024-01-01T00:00:01+00:00")
        await db.append_event("sess-multi", "prompt_suggestion", '{"text":"latest"}', "latest", "2024-01-01T00:00:02+00:00")

        result = await db.read_last_event_of_type("sess-multi", "prompt_suggestion")
        assert result is not None
        assert result["event_type"] == "prompt_suggestion"
        # payload는 JSON 문자열로 저장됨 (mock_db 패턴과 동일)
        import json
        payload = json.loads(result["payload"]) if isinstance(result["payload"], str) else result["payload"]
        assert payload["text"] == "latest"

    async def test_isolates_by_session_id(self, db: SqliteSessionDB):
        await db.upsert_session("sess-A", status="running")
        await db.upsert_session("sess-B", status="running")
        await db.append_event("sess-A", "prompt_suggestion", '{"text":"A-only"}', "A-only", "2024-01-01T00:00:00+00:00")

        result_A = await db.read_last_event_of_type("sess-A", "prompt_suggestion")
        result_B = await db.read_last_event_of_type("sess-B", "prompt_suggestion")
        assert result_A is not None
        assert result_B is None


class TestStreamEventsRaw:
    async def test_stream_yields_tuples(self, db: SqliteSessionDB):
        await db.upsert_session("sess-str", status="running")
        await db.append_event("sess-str", "text_delta", '{"text":"hello"}', "hello", "2024-01-01T00:00:00+00:00")

        tuples = []
        async for item in db.stream_events_raw("sess-str"):
            tuples.append(item)
        assert len(tuples) == 1
        event_id, event_type, payload = tuples[0]
        assert event_id == 1
        assert event_type == "text_delta"


class TestReadPosition:
    async def test_get_read_position(self, db: SqliteSessionDB):
        await db.upsert_session("sess-rp", status="running")
        await db.append_event("sess-rp", "text_delta", "{}", "", "2024-01-01T00:00:00+00:00")
        last_event_id, last_read = await db.get_read_position("sess-rp")
        assert last_event_id == 1
        assert last_read == 0

    async def test_update_last_read_event_id(self, db: SqliteSessionDB):
        await db.upsert_session("sess-rp2", status="running")
        result = await db.update_last_read_event_id("sess-rp2", 5)
        assert result is True
        _, last_read = await db.get_read_position("sess-rp2")
        assert last_read == 5

    async def test_get_read_position_nonexistent_raises(self, db: SqliteSessionDB):
        with pytest.raises(ValueError):
            await db.get_read_position("no-session")


class TestShutdownHandling:
    async def test_mark_and_get_shutdown_sessions(self, db: SqliteSessionDB):
        await db.upsert_session("sess-run1", status="running", node_id="test-node")
        await db.upsert_session("sess-run2", status="running", node_id="test-node")
        await db.mark_running_at_shutdown()
        sessions = await db.get_shutdown_sessions()
        ids = [s["session_id"] for s in sessions]
        assert "sess-run1" in ids
        assert "sess-run2" in ids

    async def test_mark_specific_sessions(self, db: SqliteSessionDB):
        # node_id="test-node"로 등록해야 get_shutdown_sessions(node_id="test-node") 필터를 통과한다
        await db.upsert_session("s-a", status="running", node_id="test-node")
        await db.upsert_session("s-b", status="running", node_id="test-node")
        await db.mark_running_at_shutdown(["s-a"])
        sessions = await db.get_shutdown_sessions()
        ids = [s["session_id"] for s in sessions]
        assert "s-a" in ids
        assert "s-b" not in ids

    async def test_clear_shutdown_flags(self, db: SqliteSessionDB):
        await db.upsert_session("sess-clr", status="running", node_id="test-node")
        await db.mark_running_at_shutdown()
        await db.clear_shutdown_flags()
        sessions = await db.get_shutdown_sessions()
        assert len(sessions) == 0

    async def test_repair_broken_read_positions(self, db: SqliteSessionDB):
        await db.upsert_session("sess-brk", status="running")
        # last_event_id=3, last_read_event_id=10 (broken)
        await db._conn.execute(
            "UPDATE sessions SET last_event_id=3, last_read_event_id=10 WHERE session_id='sess-brk'"
        )
        await db._conn.commit()
        count = await db.repair_broken_read_positions()
        assert count == 1
        _, last_read = await db.get_read_position("sess-brk")
        assert last_read == 3


class TestFolderCRUD:
    async def test_create_and_get_folder(self, db: SqliteSessionDB):
        await db.create_folder("f1", "My Folder", sort_order=1)
        folder = await db.get_folder("f1")
        assert folder is not None
        assert folder["name"] == "My Folder"
        assert folder["sort_order"] == 1
        assert folder["parent_folder_id"] is None

    async def test_create_child_folder_and_catalog_parent_wire(self, db: SqliteSessionDB):
        await db.create_folder("parent", "Parent")
        await db.create_folder("child", "Child", parent_folder_id="parent")

        folder = await db.get_folder("child")
        assert folder is not None
        assert folder["parent_folder_id"] == "parent"

        catalog = await db.get_catalog()
        child = next(f for f in catalog["folders"] if f["id"] == "child")
        assert child["parentFolderId"] == "parent"

    async def test_update_folder(self, db: SqliteSessionDB):
        await db.create_folder("f2", "Old Name")
        await db.update_folder("f2", name="New Name")
        folder = await db.get_folder("f2")
        assert folder["name"] == "New Name"

    async def test_delete_folder(self, db: SqliteSessionDB):
        await db.create_folder("f3", "To Delete")
        await db.delete_folder("f3")
        assert await db.get_folder("f3") is None

    async def test_delete_parent_promotes_child_folder_to_root(self, db: SqliteSessionDB):
        await db.create_folder("parent", "Parent")
        await db.create_folder("child", "Child", parent_folder_id="parent")

        await db.delete_folder("parent")

        child = await db.get_folder("child")
        assert child is not None
        assert child["parent_folder_id"] is None

    async def test_folder_cycle_rejected_by_application_validation(self, db: SqliteSessionDB):
        await db.create_folder("a", "A")
        await db.create_folder("b", "B", parent_folder_id="a")

        with pytest.raises(ValueError, match="cycle"):
            await db.update_folder("a", parent_folder_id="b")

        with pytest.raises(ValueError, match="cycle"):
            await db.update_folder("a", parent_folder_id="a")

    async def test_get_all_folders(self, db: SqliteSessionDB):
        await db.create_folder("fa", "A", sort_order=2)
        await db.create_folder("fb", "B", sort_order=1)
        folders = await db.get_all_folders()
        assert len(folders) == 2

    async def test_ensure_default_folders(self, db: SqliteSessionDB):
        await db.ensure_default_folders()
        folders = await db.get_all_folders()
        folder_ids = {f["id"] for f in folders}
        assert "claude" in folder_ids
        assert "llm" in folder_ids

    async def test_folder_settings_jsonb_roundtrip(self, db: SqliteSessionDB):
        """get_folder()가 settings를 dict으로 역직렬화한다 (excludeFromFeed 포함)"""
        await db.create_folder("ftest_settings", "Test Settings", sort_order=0)
        await db.update_folder("ftest_settings", settings={"excludeFromFeed": True})
        folder = await db.get_folder("ftest_settings")
        assert folder is not None
        assert isinstance(folder["settings"], dict), (
            f"settings must be dict, got {type(folder['settings'])}: {folder['settings']!r}"
        )
        assert folder["settings"]["excludeFromFeed"] is True

    async def test_get_all_folders_settings_jsonb_roundtrip(self, db: SqliteSessionDB):
        """get_all_folders()가 settings를 dict으로 역직렬화한다"""
        await db.create_folder("ftest_all", "All Settings Test", sort_order=0)
        await db.update_folder(
            "ftest_all",
            settings={"excludeFromFeed": True, "color": "#ff0000"},
        )
        folders = await db.get_all_folders()
        target = next((f for f in folders if f["id"] == "ftest_all"), None)
        assert target is not None
        assert isinstance(target["settings"], dict), (
            f"settings must be dict, got {type(target['settings'])}: {target['settings']!r}"
        )
        assert target["settings"]["excludeFromFeed"] is True
        assert target["settings"]["color"] == "#ff0000"

    async def test_invalid_folder_column_raises(self, db: SqliteSessionDB):
        await db.create_folder("f4", "Test")
        with pytest.raises(ValueError):
            await db.update_folder("f4", bad_col="val")


class TestListSessionsSummary:
    async def test_basic_listing(self, db: SqliteSessionDB):
        await db.upsert_session("sl1", status="running", session_type="claude")
        await db.upsert_session("sl2", status="stopped", session_type="llm")
        sessions, total = await db.list_sessions_summary(limit=10)
        assert total == 2
        assert len(sessions) == 2

    async def test_filter_by_session_type(self, db: SqliteSessionDB):
        await db.upsert_session("sl1", session_type="claude")
        await db.upsert_session("sl2", session_type="llm")
        sessions, total = await db.list_sessions_summary(session_type="claude")
        assert total == 1

    async def test_pagination(self, db: SqliteSessionDB):
        for i in range(5):
            await db.upsert_session(f"sl{i}", status="running")
        sessions, total = await db.list_sessions_summary(limit=2, offset=1)
        assert total == 5
        assert len(sessions) == 2

    async def test_search_via_fts(self, db: SqliteSessionDB):
        await db.upsert_session("sess-fts1", status="running")
        await db.upsert_session("sess-fts2", status="running")
        await db.append_event("sess-fts1", "text_delta", "{}", "hello world", "2024-01-01T00:00:00+00:00")
        await db.append_event("sess-fts2", "text_delta", "{}", "goodbye", "2024-01-01T00:00:00+00:00")
        sessions, total = await db.list_sessions_summary(search="hello")
        assert total == 1
        assert sessions[0]["session_id"] == "sess-fts1"


class TestSearchEvents:
    async def test_search_returns_matching_events(self, db: SqliteSessionDB):
        await db.upsert_session("sess-search", status="running")
        await db.append_event("sess-search", "text_delta", "{}", "searchable content here", "2024-01-01T00:00:00+00:00")
        await db.append_event("sess-search", "text_delta", "{}", "other text", "2024-01-01T00:00:01+00:00")
        results = await db.search_events("searchable")
        assert len(results) == 1

    async def test_search_empty_query(self, db: SqliteSessionDB):
        results = await db.search_events("")
        assert results == []

    async def test_search_with_session_filter(self, db: SqliteSessionDB):
        await db.upsert_session("s1", status="running")
        await db.upsert_session("s2", status="running")
        await db.append_event("s1", "text_delta", "{}", "target keyword", "2024-01-01T00:00:00+00:00")
        await db.append_event("s2", "text_delta", "{}", "target keyword", "2024-01-01T00:00:00+00:00")
        results = await db.search_events("target", session_ids=["s1"])
        assert len(results) == 1
        assert results[0]["session_id"] == "s1"

    async def test_search_empty_session_ids(self, db: SqliteSessionDB):
        results = await db.search_events("anything", session_ids=[])
        assert results == []


class TestCatalog:
    async def test_get_catalog(self, db: SqliteSessionDB):
        await db.create_folder("f1", "Folder 1")
        await db.upsert_session("s1", folder_id="f1", display_name="Session 1")
        catalog = await db.get_catalog()
        assert len(catalog["folders"]) == 1
        assert "s1" in catalog["sessions"]
        assert catalog["sessions"]["s1"]["folderId"] == "f1"
        assert catalog["boardItems"] == [
            {
                "id": "session:s1",
                "folderId": "f1",
                "containerKind": "folder",
                "containerId": "f1",
                "membershipKind": "primary",
                "sourceTaskItemId": None,
                "itemType": "session",
                "itemId": "s1",
                "x": 0.0,
                "y": 0.0,
                "metadata": {},
                "createdAt": catalog["boardItems"][0]["createdAt"],
                "updatedAt": catalog["boardItems"][0]["updatedAt"],
            }
        ]

    async def test_get_session_assignments_does_not_seed_board_items(self, db: SqliteSessionDB):
        await db.create_folder("f1", "Folder 1")
        await db.upsert_session("s1", folder_id="f1", display_name="Session 1")

        assignments = await db.get_session_assignments()

        assert assignments == {"s1": {"folderId": "f1", "displayName": "Session 1"}}
        cursor = await db._conn.execute("SELECT COUNT(*) AS count FROM board_items")
        row = await cursor.fetchone()
        assert row["count"] == 0

    async def test_board_item_position_roundtrip(self, db: SqliteSessionDB):
        await db.create_folder("f1", "Folder 1")
        await db.upsert_session("s1", folder_id="f1")
        await db.ensure_board_items()

        await db.update_board_item_position("session:s1", 40, 120)

        items = await db.get_board_items()
        session_item = next(item for item in items if item["id"] == "session:s1")
        assert session_item["x"] == 40.0
        assert session_item["y"] == 120.0

    async def test_frame_board_item_roundtrip(self, db: SqliteSessionDB):
        await db.create_folder("f1", "Folder 1")
        metadata = {
            "title": "검토 묶음",
            "collapsed": True,
            "childItemIds": ["session:s1", "markdown:m1"],
            "width": 420,
            "height": 260,
        }
        await db._conn.execute(
            """
            INSERT INTO board_items
                (id, folder_id, item_type, item_id, x, y, metadata, created_at, updated_at)
            VALUES (?, ?, 'frame', ?, ?, ?, ?, '2026-06-10T00:00:00+00:00', '2026-06-10T00:00:00+00:00')
            """,
            ("frame:frame-1", "f1", "frame-1", 80, 140, json.dumps(metadata)),
        )
        await db._conn.commit()

        frame_item = next(item for item in await db.get_board_items() if item["id"] == "frame:frame-1")

        assert frame_item["itemType"] == "frame"
        assert frame_item["x"] == 80.0
        assert frame_item["y"] == 140.0
        assert frame_item["metadata"] == metadata

    async def test_board_item_seed_matches_legacy_last_message_sort_grid(self, db: SqliteSessionDB):
        await db.create_folder("f1", "Folder 1")
        sessions = [
            ("s-newest", "2026-06-05T05:00:00+00:00", "2026-06-01T00:00:00+00:00"),
            ("s-second", "2026-06-04T05:00:00+00:00", "2026-06-02T00:00:00+00:00"),
            ("s-third", "2026-06-03T05:00:00+00:00", "2026-06-03T00:00:00+00:00"),
            ("s-fourth", "2026-06-02T05:00:00+00:00", "2026-06-04T00:00:00+00:00"),
            ("s-oldest", "2026-06-01T05:00:00+00:00", "2026-06-05T00:00:00+00:00"),
        ]
        for session_id, message_ts, updated_at in sessions:
            await db.upsert_session("seed-" + session_id, folder_id="f1")
            await db.update_last_message(
                "seed-" + session_id,
                {"timestamp": message_ts, "preview": session_id},
            )
            await db._conn.execute(
                "UPDATE sessions SET updated_at = ? WHERE session_id = ?",
                (updated_at, "seed-" + session_id),
            )
        await db._conn.commit()

        await db.ensure_board_items()

        seeded = [
            (item["id"], item["x"], item["y"])
            for item in await db.get_board_items()
            if item["folderId"] == "f1"
        ]
        assert seeded == [
            ("session:seed-s-newest", 0.0, 0.0),
            ("session:seed-s-second", 160.0, 0.0),
            ("session:seed-s-third", 320.0, 0.0),
            ("session:seed-s-fourth", 480.0, 0.0),
            ("session:seed-s-oldest", 0.0, 120.0),
        ]

    async def test_markdown_document_crud_and_catalog_preview(self, db: SqliteSessionDB):
        await db.create_folder("f1", "Folder 1")

        result = await db.create_markdown_document(
            "doc-1",
            "f1",
            "Note",
            "First line\n\nSecond line",
            80,
            160,
        )

        assert result["document"]["body"] == "First line\n\nSecond line"
        assert result["document"]["version"] == 1
        assert result["boardItem"]["metadata"] == {
            "title": "Note",
            "preview": "First line Second line",
            "version": 1,
        }

        catalog = await db.get_catalog()
        markdown_item = next(item for item in catalog["boardItems"] if item["id"] == "markdown:doc-1")
        assert markdown_item["metadata"] == {
            "title": "Note",
            "preview": "First line Second line",
            "version": 1,
        }

        updated = await db.update_markdown_document("doc-1", title="New", body="Changed", expected_version=1)
        assert updated["title"] == "New"
        assert updated["body"] == "Changed"
        assert updated["version"] == 2

        with pytest.raises(MarkdownDocumentVersionConflictError):
            await db.update_markdown_document("doc-1", body="Stale", expected_version=1)

        preserved = await db.get_markdown_document("doc-1")
        assert preserved["title"] == "New"
        assert preserved["body"] == "Changed"
        assert preserved["version"] == 2

        await db.delete_markdown_document("doc-1")
        assert await db.get_markdown_document("doc-1") is None
        assert [item for item in await db.get_board_items() if item["id"] == "markdown:doc-1"] == []

    async def test_file_asset_commit_creates_board_item(self, db: SqliteSessionDB):
        await db.create_folder("f1", "Folder 1")

        pending = await db.create_pending_file_asset(
            "asset-1",
            "folders/f1/assets/asset-1/photo.png",
            "photo.png",
            "image/png",
            123,
        )
        assert pending["uploadStatus"] == "pending"
        assert [item for item in await db.get_board_items() if item["id"] == "asset:asset-1"] == []

        result = await db.commit_file_asset(
            "asset-1",
            "f1",
            40,
            80,
            width=640,
            height=480,
        )

        assert result["asset"]["uploadStatus"] == "committed"
        assert result["boardItem"] == {
            "id": "asset:asset-1",
            "folderId": "f1",
            "containerKind": "folder",
            "containerId": "f1",
            "membershipKind": "primary",
            "sourceTaskItemId": None,
            "itemType": "asset",
            "itemId": "asset-1",
            "x": 40.0,
            "y": 80.0,
            "metadata": {
                "assetId": "asset-1",
                "storageKey": "folders/f1/assets/asset-1/photo.png",
                "originalName": "photo.png",
                "mimeType": "image/png",
                "byteSize": 123,
                "width": 640,
                "height": 480,
                "durationSeconds": None,
            },
            "createdAt": result["boardItem"]["createdAt"],
            "updatedAt": result["boardItem"]["updatedAt"],
        }

    async def test_markdown_and_file_asset_can_target_task_container(self, db: SqliteSessionDB):
        await db.create_folder("f1", "Folder 1")

        markdown = await db.create_markdown_document(
            "doc-task",
            "f1",
            "Task note",
            "Body",
            40,
            80,
            container_kind="task",
            container_id="rb-1",
        )
        assert markdown["boardItem"] == {
            "id": "markdown:doc-task",
            "folderId": "f1",
            "containerKind": "task",
            "containerId": "rb-1",
            "membershipKind": "primary",
            "sourceTaskItemId": None,
            "itemType": "markdown",
            "itemId": "doc-task",
            "x": 40.0,
            "y": 80.0,
            "metadata": {
                "title": "Task note",
                "preview": "Body",
                "version": 1,
            },
            "createdAt": markdown["boardItem"]["createdAt"],
            "updatedAt": markdown["boardItem"]["updatedAt"],
        }

        await db.create_pending_file_asset(
            "asset-task",
            "containers/task/rb-1/assets/asset-task/photo.png",
            "photo.png",
            "image/png",
            123,
        )
        asset = await db.commit_file_asset(
            "asset-task",
            "f1",
            120,
            160,
            container_kind="task",
            container_id="rb-1",
        )
        assert asset["boardItem"]["containerKind"] == "task"
        assert asset["boardItem"]["containerId"] == "rb-1"
        assert asset["boardItem"]["metadata"]["storageKey"] == (
            "containers/task/rb-1/assets/asset-task/photo.png"
        )

    async def test_file_asset_delete_trigger_removes_board_item(self, db: SqliteSessionDB):
        await db.create_folder("f1", "Folder 1")
        await db.create_pending_file_asset(
            "asset-2",
            "folders/f1/assets/asset-2/song.mp3",
            "song.mp3",
            "audio/mpeg",
            456,
        )
        await db.commit_file_asset("asset-2", "f1", 20, 40, duration_seconds=12.5)

        await db._conn.execute("DELETE FROM file_assets WHERE id = ?", ("asset-2",))
        await db._conn.commit()

        assert [item for item in await db.get_board_items() if item["id"] == "asset:asset-2"] == []

    async def test_assign_session_to_folder(self, db: SqliteSessionDB):
        await db.create_folder("f1", "Folder 1")
        await db.upsert_session("s1", status="running")
        await db.assign_session_to_folder("s1", "f1")
        result = await db.get_session("s1")
        assert result["folder_id"] == "f1"

    async def test_rename_session(self, db: SqliteSessionDB):
        await db.upsert_session("s1", status="running")
        await db.rename_session("s1", "My Custom Name")
        result = await db.get_session("s1")
        assert result["display_name"] == "My Custom Name"


class TestExtractSearchableText:
    def test_text_delta(self):
        text = SqliteSessionDB.extract_searchable_text({"type": "text_delta", "text": "hello"})
        assert text == "hello"

    def test_thinking(self):
        text = SqliteSessionDB.extract_searchable_text({"type": "thinking", "thinking": "pondering"})
        assert text == "pondering"

    def test_tool_use_dict_input(self):
        text = SqliteSessionDB.extract_searchable_text({"type": "tool_use", "input": {"key": "val"}})
        assert "key" in text

    def test_tool_result_string(self):
        text = SqliteSessionDB.extract_searchable_text({"type": "tool_result", "result": "output"})
        assert text == "output"

    def test_user_message(self):
        text = SqliteSessionDB.extract_searchable_text({"type": "user_message", "text": "user input"})
        assert text == "user input"

    def test_unknown_type_returns_empty(self):
        text = SqliteSessionDB.extract_searchable_text({"type": "unknown_event"})
        assert text == ""


class TestCountEvents:
    async def test_count_events(self, db: SqliteSessionDB):
        await db.upsert_session("sess-cnt", status="running")
        assert await db.count_events("sess-cnt") == 0
        await db.append_event("sess-cnt", "text_delta", "{}", "", "2024-01-01T00:00:00+00:00")
        await db.append_event("sess-cnt", "text_delta", "{}", "", "2024-01-01T00:00:01+00:00")
        assert await db.count_events("sess-cnt") == 2


class TestRegisterSessionInitial:
    """register_session_initial: 4-ID 원자적 INSERT (ON CONFLICT 없음)"""

    async def test_creates_session_with_all_four_ids(self, db: SqliteSessionDB):
        await db.register_session_initial(
            session_id="sess-r1",
            node_id="node-1",
            agent_id="agent-1",
            claude_session_id="claude-1",
            session_type="claude",
        )
        result = await db.get_session("sess-r1")
        assert result is not None
        assert result["session_id"] == "sess-r1"
        assert result["node_id"] == "node-1"
        assert result["agent_id"] == "agent-1"
        assert result["claude_session_id"] == "claude-1"
        assert result["session_type"] == "claude"

    async def test_duplicate_raises_integrity_error(self, db: SqliteSessionDB):
        await db.register_session_initial(
            session_id="sess-dup",
            node_id="node-1",
            agent_id="agent-1",
            claude_session_id="claude-1",
            session_type="claude",
        )
        with pytest.raises(Exception):
            await db.register_session_initial(
                session_id="sess-dup",
                node_id="node-2",
                agent_id="agent-2",
                claude_session_id="claude-2",
                session_type="claude",
            )

    async def test_optional_fields_stored(self, db: SqliteSessionDB):
        await db.register_session_initial(
            session_id="sess-r2",
            node_id="node-1",
            agent_id="agent-1",
            claude_session_id="claude-1",
            session_type="claude",
            prompt="test prompt",
            client_id="client-1",
            status="running",
        )
        result = await db.get_session("sess-r2")
        assert result["prompt"] == "test prompt"
        assert result["client_id"] == "client-1"
        assert result["status"] == "running"

    async def test_default_status_is_running(self, db: SqliteSessionDB):
        await db.register_session_initial(
            session_id="sess-r3",
            node_id="node-1",
            agent_id="agent-1",
            claude_session_id="claude-1",
            session_type="claude",
        )
        result = await db.get_session("sess-r3")
        assert result["status"] == "running"


class TestUpdateSession:
    """update_session: 불변 필드를 제외한 순수 UPDATE"""

    async def test_update_status(self, db: SqliteSessionDB):
        await db.upsert_session("sess-upd1", status="running")
        await db.update_session("sess-upd1", status="stopped")
        result = await db.get_session("sess-upd1")
        assert result["status"] == "stopped"

    async def test_update_multiple_fields(self, db: SqliteSessionDB):
        await db.upsert_session("sess-upd2", status="running", display_name="old")
        await db.update_session("sess-upd2", status="stopped", display_name="new")
        result = await db.get_session("sess-upd2")
        assert result["status"] == "stopped"
        assert result["display_name"] == "new"

    async def test_update_node_id_raises(self, db: SqliteSessionDB):
        await db.upsert_session("sess-upd3", status="running")
        with pytest.raises(ValueError, match="[Ii]mmutable"):
            await db.update_session("sess-upd3", node_id="new-node")

    async def test_update_agent_id_raises(self, db: SqliteSessionDB):
        await db.upsert_session("sess-upd4", status="running")
        with pytest.raises(ValueError, match="[Ii]mmutable"):
            await db.update_session("sess-upd4", agent_id="new-agent")

    async def test_update_claude_session_id_raises(self, db: SqliteSessionDB):
        await db.upsert_session("sess-upd5", status="running")
        with pytest.raises(ValueError, match="[Ii]mmutable"):
            await db.update_session("sess-upd5", claude_session_id="new-claude")

    async def test_update_session_type_raises(self, db: SqliteSessionDB):
        await db.upsert_session("sess-upd6", session_type="claude")
        with pytest.raises(ValueError, match="[Ii]mmutable"):
            await db.update_session("sess-upd6", session_type="llm")

    async def test_update_created_at_raises(self, db: SqliteSessionDB):
        await db.upsert_session("sess-upd7", status="running")
        with pytest.raises(ValueError, match="[Ii]mmutable"):
            await db.update_session("sess-upd7", created_at="2020-01-01T00:00:00+00:00")


class TestImmutableFieldCheckFix:
    """upsert_session 불변 필드 None 우회 버그 수정 검증"""

    async def test_none_immutable_raises_if_existing_value(self, db: SqliteSessionDB):
        """기존 값이 있는 불변 필드를 None으로 덮어쓰기 시도 시 에러를 발생시킨다."""
        await db.upsert_session("sess-imm-fix", node_id="original-node", status="running")
        with pytest.raises(ValueError):
            await db.upsert_session("sess-imm-fix", node_id=None)

    async def test_none_immutable_allowed_if_not_yet_set(self, db: SqliteSessionDB):
        """기존 값이 없는 불변 필드는 None 설정을 허용한다."""
        await db.upsert_session("sess-imm-none", status="running")
        # node_id가 아직 None이면 None 설정은 no-op으로 허용
        await db.upsert_session("sess-imm-none", node_id=None)
        result = await db.get_session("sess-imm-none")
        assert result["node_id"] is None
