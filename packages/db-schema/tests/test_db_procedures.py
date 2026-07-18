"""DB 프로시저 통합 테스트

실제 PostgreSQL에 연결하여 schema.sql의 모든 프로시저를 검증한다.
TEST_DATABASE_URL 환경변수가 없으면 전체 skip.
"""

import asyncio
import json
from datetime import datetime, timezone
from pathlib import Path

import pytest


pytestmark = pytest.mark.asyncio


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _decode_jsonb(value):
    return json.loads(value) if isinstance(value, str) else value


def _schema_sql() -> str:
    schema_path = Path(__file__).resolve().parents[1] / "sql" / "schema.sql"
    return schema_path.read_text(encoding="utf-8")


def _migration_sql(name: str) -> str:
    migration_path = Path(__file__).resolve().parents[1] / "sql" / "migrations" / name
    return migration_path.read_text(encoding="utf-8")


def _function_sql(sql: str, signature: str) -> str:
    start = sql.index(signature)
    end = sql.index("$$;", start) + len("$$;")
    return sql[start:end].strip()


# === Helper ===

async def _create_folder(db, folder_id="test-folder", name="Test Folder", sort_order=0):
    await db.execute(
        "SELECT folder_create($1, $2, $3)", folder_id, name, sort_order
    )


async def _create_session(db, session_id="test-session", **overrides):
    now = _utc_now()
    columns = ["status", "node_id"]
    values = ["idle", "test-node"]
    for k, v in overrides.items():
        columns.append(k)
        values.append(str(v) if not isinstance(v, str) else v)
    await db.execute(
        "SELECT session_upsert($1, $2, $3, $4, $5)",
        session_id, columns, values, now, now,
    )


DASHBOARD_SEARCH_EVENT_TYPES = [
    "user_message",
    "assistant_message",
    "user_text",
    "assistant_text",
    "text_delta",
    "result",
    "complete",
    "error",
    "away_summary",
    "intervention_sent",
    "realtime_transcript",
]


# === schema.sql 적용 계약 ===

async def test_task_status_contract_is_mirrored_in_canonical_schema_sql():
    migration_sql = _migration_sql("029_runbook_status.sql").strip()
    schema_sql = _schema_sql()

    assert "ALTER TABLE runbooks ADD COLUMN IF NOT EXISTS status" in migration_sql
    for required in [
        "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS status",
        "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS completed_session_id",
        "ALTER TABLE tasks ADD CONSTRAINT tasks_status_check",
        "ALTER TABLE tasks ADD CONSTRAINT tasks_completed_session_id_fkey",
        "ALTER TABLE tasks ADD CONSTRAINT tasks_completed_event_fkey",
    ]:
        assert required in schema_sql


async def test_event_search_prefix_fallback_migration_is_mirrored_in_schema_sql():
    migration_sql = _migration_sql("031_event_search_prefix_fallback.sql").strip()
    schema_sql = _schema_sql()

    for required in [
        "CREATE TABLE IF NOT EXISTS event_search_corpus_stats",
        "CREATE OR REPLACE FUNCTION event_search_adjust_corpus_stats",
        "CREATE OR REPLACE FUNCTION refresh_event_search_terms",
        "CREATE OR REPLACE FUNCTION decrement_event_search_corpus_stats",
        "CREATE TRIGGER trg_event_search_corpus_stats_delete",
    ]:
        assert required in migration_sql
        assert required in schema_sql

    assert _function_sql(
        migration_sql, "CREATE OR REPLACE FUNCTION event_search("
    ) in schema_sql


async def test_task_item_review_status_contract_is_mirrored_in_canonical_schema_sql():
    migration_sql = _migration_sql("031_runbook_item_review_status.sql").strip()
    schema_sql = _schema_sql()

    assert "runbook_items_status_check" in migration_sql
    assert "ALTER TABLE task_items ADD CONSTRAINT task_items_status_check" in schema_sql
    assert "CHECK (status IN ('pending','in_progress','review','completed','cancelled'))" in schema_sql


async def test_notify_completion_migration_contract_is_mirrored_in_schema_sql():
    migration_sql = _migration_sql("035_notify_completion.sql")
    schema_sql = _schema_sql()

    for required in [
        "ALTER TABLE sessions ADD COLUMN IF NOT EXISTS notify_completion BOOLEAN NOT NULL DEFAULT TRUE",
        "DROP FUNCTION IF EXISTS session_register(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TEXT)",
        "p_notify_completion BOOLEAN DEFAULT TRUE",
        "COALESCE(p_notify_completion, TRUE)",
    ]:
        assert required in migration_sql
        assert required in schema_sql


async def test_session_review_migration_contract_is_mirrored_in_schema_sql():
    migration_sql = _migration_sql("036_session_review_state.sql")
    schema_sql = _schema_sql()

    for required in [
        "review_required BOOLEAN NOT NULL DEFAULT FALSE",
        "review_state TEXT NOT NULL DEFAULT 'not_required'",
        "CREATE OR REPLACE FUNCTION session_register_with_review(",
        "CREATE OR REPLACE FUNCTION session_acknowledge_review(",
        "'termination_reason', 'termination_detail', 'review_state'",
    ]:
        assert required in migration_sql
        assert required in schema_sql


async def test_session_predecessor_migration_contract_is_mirrored_in_schema_sql():
    migration_sql = _migration_sql("040_session_predecessor.sql")
    schema_sql = _schema_sql()

    for required in [
        "ALTER TABLE sessions ADD COLUMN IF NOT EXISTS predecessor_session_id TEXT",
        "FOREIGN KEY (predecessor_session_id) REFERENCES sessions(session_id) ON DELETE SET NULL",
        "CREATE OR REPLACE FUNCTION session_register_with_predecessor(",
        "p_predecessor_session_id TEXT",
    ]:
        assert required in migration_sql
        assert required in schema_sql


async def test_session_predecessor_schema_reapply_is_idempotent(test_db):
    schema_sql = _schema_sql()
    await test_db.execute(schema_sql)
    await test_db.execute(schema_sql)

    assert await test_db.fetchval(
        """
        SELECT COUNT(*)
        FROM pg_constraint
        WHERE conrelid = 'sessions'::regclass
          AND conname = 'sessions_predecessor_session_id_fkey'
        """
    ) == 1


async def test_session_predecessor_registration_and_delete_semantics(test_db):
    now = _utc_now()
    for session_id, predecessor_id in [
        ("sess-parent", None),
        ("sess-child", "sess-parent"),
    ]:
        await test_db.execute(
            """
            SELECT session_register_with_predecessor(
              $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15
            )
            """,
            session_id,
            "node-1",
            "codex-default",
            None,
            "claude",
            "prompt",
            None,
            "running",
            now,
            now,
            None,
            True,
            False,
            "not_required",
            predecessor_id,
        )

    assert await test_db.fetchval(
        "SELECT predecessor_session_id FROM sessions WHERE session_id = 'sess-child'"
    ) == "sess-parent"
    await test_db.execute("DELETE FROM sessions WHERE session_id = 'sess-parent'")
    assert await test_db.fetchval(
        "SELECT predecessor_session_id FROM sessions WHERE session_id = 'sess-child'"
    ) is None


async def test_page_prefix_search_indexes_are_additive_and_mirrored():
    migration_sql = _migration_sql("038_page_prefix_search_indexes.sql")
    schema_sql = _schema_sql()

    for required in [
        "CREATE INDEX IF NOT EXISTS idx_pages_title_prefix",
        "ON pages (title_key text_pattern_ops, id)",
        "CREATE INDEX IF NOT EXISTS idx_blocks_text_prefix",
        "ON blocks ((lower(text_plain)) text_pattern_ops, id)",
    ]:
        assert required in migration_sql
        assert required in schema_sql


async def test_page_prefix_search_indexes_apply_to_fresh_schema_and_are_idempotent(test_db):
    expected_fragments = {
        "idx_pages_title_prefix": [
            "title_key text_pattern_ops",
            "id",
            "WHERE (archived = false)",
        ],
        "idx_blocks_text_prefix": [
            "lower(text_plain) text_pattern_ops",
            "id",
        ],
    }

    async def read_indexes():
        return {
            row["indexname"]: row["indexdef"]
            for row in await test_db.fetch(
                """
                SELECT indexname, indexdef
                FROM pg_indexes
                WHERE schemaname = current_schema()
                  AND indexname = ANY($1::text[])
                """,
                list(expected_fragments),
            )
        }

    fresh_indexes = await read_indexes()
    assert set(fresh_indexes) == set(expected_fragments)

    await test_db.execute("DROP INDEX idx_pages_title_prefix")
    await test_db.execute("DROP INDEX idx_blocks_text_prefix")
    migration_sql = _migration_sql("038_page_prefix_search_indexes.sql")
    await test_db.execute(migration_sql)
    await test_db.execute(migration_sql)

    migrated_indexes = await read_indexes()
    assert set(migrated_indexes) == set(expected_fragments)
    for index_name, fragments in expected_fragments.items():
        for fragment in fragments:
            assert fragment in migrated_indexes[index_name]


async def test_checklist_projection_outbox_contract_is_mirrored_in_canonical_schema_sql():
    migration_sql = _migration_sql("039_checklist_runbook_projection_outbox.sql").strip()
    schema_sql = _schema_sql()

    assert "CREATE TABLE IF NOT EXISTS checklist_runbook_projection_outbox" in migration_sql
    for required in [
        "CREATE TABLE IF NOT EXISTS checklist_task_projection_outbox",
        "ALTER TABLE checklist_task_projection_outbox ADD COLUMN IF NOT EXISTS page_id",
        "CREATE INDEX IF NOT EXISTS idx_checklist_task_projection_due",
        "INSERT INTO checklist_task_projection_outbox",
    ]:
        assert required in schema_sql


async def test_checklist_projection_outbox_upgrade_backfills_and_reapplies(test_db):
    await test_db.execute(
        """
        INSERT INTO pages (id, title, version)
        VALUES ('page-outbox-upgrade', 'Outbox upgrade', 1)
        """
    )
    await test_db.execute(
        """
        INSERT INTO blocks (
          id, page_id, position_key, block_type, text_plain, properties
        ) VALUES (
          'block-outbox-upgrade', 'page-outbox-upgrade', 'a',
          'checklist', 'Legacy checked', '{"checked": true}'::jsonb
        )
        """
    )
    await test_db.execute("DROP TABLE checklist_task_projection_outbox")

    migration_sql = _migration_sql("039_checklist_runbook_projection_outbox.sql")
    await test_db.execute(migration_sql)
    await test_db.execute(migration_sql)
    await test_db.execute(_migration_sql("042_runbook_to_task.sql"))

    row = await test_db.fetchrow(
        """
        SELECT page_id, actor_kind, processed_hash, attempts
        FROM checklist_task_projection_outbox
        WHERE block_id = 'block-outbox-upgrade'
        """
    )
    assert dict(row) == {
        "page_id": "page-outbox-upgrade",
        "actor_kind": "system",
        "processed_hash": None,
        "attempts": 0,
    }
    indexes = await test_db.fetch(
        """
        SELECT indexname
        FROM pg_indexes
        WHERE schemaname = current_schema()
          AND tablename = 'checklist_task_projection_outbox'
        """
    )
    assert "idx_checklist_task_projection_due" in {
        row["indexname"] for row in indexes
    }


async def test_session_review_schema_and_atomic_transitions(test_db):
    columns = {
        row["column_name"]: row
        for row in await test_db.fetch(
            """
            SELECT column_name, is_nullable, column_default
            FROM information_schema.columns
            WHERE table_name = 'sessions'
            """
        )
    }
    assert columns["review_required"]["is_nullable"] == "NO"
    assert columns["review_required"]["column_default"] == "false"
    assert columns["review_state"]["is_nullable"] == "NO"
    assert columns["review_state"]["column_default"] == "'not_required'::text"

    now = _utc_now()
    await test_db.execute(
        """
        SELECT session_register_with_review(
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14
        )
        """,
        "sess-review",
        "node-1",
        "codex-default",
        None,
        "claude",
        "review",
        None,
        "running",
        now,
        now,
        None,
        True,
        True,
        "not_required",
    )
    await test_db.execute(
        "SELECT session_update($1, $2, $3, $4)",
        "sess-review",
        ["status", "review_state"],
        ["completed", "needs_review"],
        now,
    )
    assert await test_db.fetchval(
        "SELECT session_acknowledge_review($1, $2)", "sess-review", now
    ) == "acknowledged"
    assert await test_db.fetchval(
        "SELECT session_acknowledge_review($1, $2)", "sess-review", now
    ) == "already_acknowledged"

    row = await test_db.fetchrow(
        "SELECT review_required, review_state FROM sessions WHERE session_id = $1",
        "sess-review",
    )
    assert dict(row) == {"review_required": True, "review_state": "acknowledged"}


async def test_sessions_notify_completion_schema_contract(test_db):
    columns = {
        row["column_name"]: row
        for row in await test_db.fetch(
            """
            SELECT column_name, is_nullable, column_default
            FROM information_schema.columns
            WHERE table_name = 'sessions'
            """
        )
    }

    assert columns["notify_completion"]["is_nullable"] == "NO"
    assert columns["notify_completion"]["column_default"] == "true"

    now = _utc_now()
    await test_db.execute(
        """
        SELECT session_register(
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12
        )
        """,
        "sess-notify-off",
        "node-1",
        "codex-default",
        None,
        "claude",
        "fire and forget",
        None,
        "running",
        now,
        now,
        "caller-sess-1",
        False,
    )
    await test_db.execute(
        """
        SELECT session_register(
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11
        )
        """,
        "sess-notify-default",
        "node-1",
        "codex-default",
        None,
        "claude",
        "default notify",
        None,
        "running",
        now,
        now,
        "caller-sess-1",
    )

    rows = {
        row["session_id"]: row["notify_completion"]
        for row in await test_db.fetch(
            """
            SELECT session_id, notify_completion
            FROM sessions
            WHERE session_id IN ($1, $2)
            """,
            "sess-notify-off",
            "sess-notify-default",
        )
    }
    assert rows == {
        "sess-notify-off": False,
        "sess-notify-default": True,
    }


async def test_board_items_container_schema_contract(test_db):
    """board_items exposes the additive container membership columns and indexes."""

    columns = {
        row["column_name"]: row
        for row in await test_db.fetch(
            """
            SELECT column_name, is_nullable, column_default
            FROM information_schema.columns
            WHERE table_name = 'board_items'
            """
        )
    }

    assert columns["container_kind"]["is_nullable"] == "NO"
    assert columns["container_kind"]["column_default"] == "'folder'::text"
    assert columns["container_id"]["is_nullable"] == "NO"
    assert columns["membership_kind"]["is_nullable"] == "NO"
    assert columns["membership_kind"]["column_default"] == "'primary'::text"
    assert columns["source_task_item_id"]["is_nullable"] == "YES"

    constraints = {
        row["conname"]: row["contype"].decode()
        if isinstance(row["contype"], bytes)
        else row["contype"]
        for row in await test_db.fetch(
            """
            SELECT conname, contype
            FROM pg_constraint
            WHERE conrelid = 'board_items'::regclass
            """
        )
    }
    assert constraints["board_items_container_kind_check"] == "c"
    assert constraints["board_items_membership_kind_check"] == "c"
    assert constraints["uq_board_items_container_item"] == "u"
    assert constraints["board_items_source_task_item_id_fkey"] == "f"
    assert "board_items_folder_id_item_id_key" not in constraints

    indexes = {
        row["indexname"]: row["indexdef"]
        for row in await test_db.fetch(
            """
            SELECT indexname, indexdef
            FROM pg_indexes
            WHERE tablename = 'board_items'
            """
        )
    }
    assert "idx_board_items_folder" in indexes
    assert "idx_board_items_container" in indexes
    assert "container_kind, container_id, y, x" in indexes["idx_board_items_container"]
    assert "uq_board_items_primary_membership" in indexes
    assert "WHERE (membership_kind = 'primary'::text)" in indexes[
        "uq_board_items_primary_membership"
    ]


async def test_schema_reapply_backfills_legacy_board_items_container_columns(test_db):
    """schema.sql alone upgrades a pre-container board_items table idempotently."""

    await test_db.execute(
        """
        ALTER TABLE board_items DROP CONSTRAINT IF EXISTS uq_board_items_container_item;
        ALTER TABLE board_items DROP CONSTRAINT IF EXISTS board_items_container_kind_check;
        ALTER TABLE board_items DROP CONSTRAINT IF EXISTS board_items_membership_kind_check;
        ALTER TABLE board_items DROP CONSTRAINT IF EXISTS board_items_source_task_item_id_fkey;
        DROP INDEX IF EXISTS idx_board_items_container;
        DROP INDEX IF EXISTS uq_board_items_primary_membership;
        DROP TRIGGER IF EXISTS trg_board_items_fill_container_defaults ON board_items;
        DROP FUNCTION IF EXISTS board_items_fill_container_defaults();
        ALTER TABLE board_items DROP COLUMN IF EXISTS source_task_item_id CASCADE;
        ALTER TABLE board_items DROP COLUMN IF EXISTS membership_kind CASCADE;
        ALTER TABLE board_items DROP COLUMN IF EXISTS container_id CASCADE;
        ALTER TABLE board_items DROP COLUMN IF EXISTS container_kind CASCADE;
        ALTER TABLE board_items DROP CONSTRAINT IF EXISTS board_items_folder_id_item_id_key;
        ALTER TABLE board_items
            ADD CONSTRAINT board_items_folder_id_item_id_key UNIQUE (folder_id, item_id);
        """
    )

    await _create_folder(test_db, "legacy-container-folder", "Legacy Container Folder")
    await test_db.execute(
        """
        INSERT INTO board_items (id, folder_id, item_type, item_id)
        VALUES ($1, $2, 'markdown', $3)
        """,
        "legacy-container-board-item",
        "legacy-container-folder",
        "legacy-container-doc",
    )

    await test_db.execute(_schema_sql())
    await test_db.execute(_schema_sql())

    row = await test_db.fetchrow(
        """
        SELECT folder_id, container_kind, container_id, membership_kind
        FROM board_items
        WHERE id = $1
        """,
        "legacy-container-board-item",
    )
    assert dict(row) == {
        "folder_id": "legacy-container-folder",
        "container_kind": "folder",
        "container_id": "legacy-container-folder",
        "membership_kind": "primary",
    }

    constraints = {
        row["conname"]
        for row in await test_db.fetch(
            """
            SELECT conname
            FROM pg_constraint
            WHERE conrelid = 'board_items'::regclass
            """
        )
    }
    assert "uq_board_items_container_item" in constraints
    assert "board_items_folder_id_item_id_key" not in constraints


async def test_board_items_container_insert_defaults_and_primary_uniqueness(test_db):
    """Legacy INSERT paths can omit container columns; primary membership stays unique."""

    await _create_folder(test_db, "container-default-folder-a", "Container Default A")
    await _create_folder(test_db, "container-default-folder-b", "Container Default B")

    await test_db.execute(
        """
        INSERT INTO board_items (id, folder_id, item_type, item_id)
        VALUES ($1, $2, 'markdown', $3)
        """,
        "container-default-item-a",
        "container-default-folder-a",
        "shared-markdown-doc",
    )

    row = await test_db.fetchrow(
        """
        SELECT container_kind, container_id, membership_kind
        FROM board_items
        WHERE id = $1
        """,
        "container-default-item-a",
    )
    assert dict(row) == {
        "container_kind": "folder",
        "container_id": "container-default-folder-a",
        "membership_kind": "primary",
    }

    await test_db.execute(
        """
        INSERT INTO board_items (
            id, folder_id, item_type, item_id, container_kind, container_id, membership_kind
        )
        VALUES ($1, $2, 'markdown', $3, 'folder', $2, 'reference')
        """,
        "container-reference-item-b",
        "container-default-folder-b",
        "shared-markdown-doc",
    )

    with pytest.raises(Exception):
        await test_db.execute(
            """
            INSERT INTO board_items (
                id, folder_id, item_type, item_id, container_kind, container_id
            )
            VALUES ($1, $2, 'markdown', $3, 'folder', $2)
            """,
            "container-primary-item-b",
            "container-default-folder-b",
            "shared-markdown-doc",
        )


async def test_custom_view_schema_enriches_board_item_metadata_and_cascades_refs(test_db):
    await _create_folder(test_db, "custom-view-folder", "Custom View Folder")
    await _create_session(test_db, "custom-view-session")
    await test_db.execute(
        """
        INSERT INTO events (session_id, id, event_type, payload, searchable_text, created_at)
        VALUES ($1, 1, 'custom_view_created', '{}'::jsonb, 'custom view created', NOW())
        """,
        "custom-view-session",
    )
    await test_db.execute(
        """
        INSERT INTO board_items (
            id, folder_id, item_type, item_id, container_kind, container_id, x, y
        )
        VALUES (
            'custom_view:cv-1', 'custom-view-folder', 'custom_view', 'cv-1',
            'folder', 'custom-view-folder', 120, 240
        )
        """
    )
    await test_db.execute(
        """
        INSERT INTO board_custom_views (
            id, board_item_id, title, html, revision,
            created_session_id, created_event_id, updated_session_id, updated_event_id
        )
        VALUES (
            'cv-1', 'custom_view:cv-1', 'Progress panel',
            '<section><h1>Progress</h1><script>alert(1)</script></section>', 3,
            'custom-view-session', 1, 'custom-view-session', 1
        )
        """
    )

    row = await test_db.fetchrow(
        """
        SELECT item_type, metadata
        FROM board_item_get_all()
        WHERE id = 'custom_view:cv-1'
        """
    )

    metadata = _decode_jsonb(row["metadata"])
    assert row["item_type"] == "custom_view"
    assert metadata["title"] == "Progress panel"
    assert metadata["revision"] == 3
    assert "Progress" in metadata["preview"]
    assert "<section>" not in metadata["preview"]

    await test_db.execute("DELETE FROM board_custom_views WHERE id = 'cv-1'")
    remaining = await test_db.fetchval(
        "SELECT COUNT(*) FROM board_items WHERE id = 'custom_view:cv-1'"
    )
    assert remaining == 0


async def test_board_yjs_persistence_container_schema_contract(test_db):
    """Yjs documents/cache expose synced marker and container cache key."""

    document_columns = {
        row["column_name"]
        for row in await test_db.fetch(
            """
            SELECT column_name
            FROM information_schema.columns
            WHERE table_name = 'board_yjs_documents'
            """
        )
    }
    assert "synced_at" in document_columns

    cache_columns = {
        row["column_name"]: row
        for row in await test_db.fetch(
            """
            SELECT column_name, is_nullable, column_default
            FROM information_schema.columns
            WHERE table_name = 'board_yjs_catalog_cache'
            """
        )
    }
    assert cache_columns["folder_id"]["is_nullable"] == "NO"
    assert cache_columns["container_kind"]["is_nullable"] == "NO"
    assert cache_columns["container_kind"]["column_default"] == "'folder'::text"
    assert cache_columns["container_id"]["is_nullable"] == "NO"

    pkey_columns = [
        row["attname"]
        for row in await test_db.fetch(
            """
            SELECT a.attname
            FROM pg_index i
            JOIN pg_attribute a
              ON a.attrelid = i.indrelid
             AND a.attnum = ANY(i.indkey)
            WHERE i.indrelid = 'board_yjs_catalog_cache'::regclass
              AND i.indisprimary
            ORDER BY array_position(i.indkey, a.attnum)
            """
        )
    ]
    assert pkey_columns == ["container_kind", "container_id"]


async def test_schema_reapply_backfills_legacy_board_yjs_catalog_cache_key(test_db):
    """schema.sql upgrades legacy folder_id-keyed cache rows idempotently."""

    await _create_folder(test_db, "legacy-cache-folder", "Legacy Cache Folder")
    await test_db.execute(
        """
        TRUNCATE board_yjs_catalog_cache;
        ALTER TABLE board_yjs_catalog_cache DROP CONSTRAINT IF EXISTS board_yjs_catalog_cache_pkey;
        ALTER TABLE board_yjs_catalog_cache DROP CONSTRAINT IF EXISTS board_yjs_catalog_cache_container_kind_check;
        ALTER TABLE board_yjs_catalog_cache DROP COLUMN IF EXISTS container_id;
        ALTER TABLE board_yjs_catalog_cache DROP COLUMN IF EXISTS container_kind;
        ALTER TABLE board_yjs_catalog_cache ADD PRIMARY KEY (folder_id);
        INSERT INTO board_yjs_catalog_cache (folder_id, board_items, markdown_documents)
        VALUES ('legacy-cache-folder', '[]'::jsonb, '[]'::jsonb);
        """
    )

    await test_db.execute(_schema_sql())
    await test_db.execute(_schema_sql())

    row = await test_db.fetchrow(
        """
        SELECT folder_id, container_kind, container_id
        FROM board_yjs_catalog_cache
        WHERE folder_id = $1
        """,
        "legacy-cache-folder",
    )
    assert dict(row) == {
        "folder_id": "legacy-cache-folder",
        "container_kind": "folder",
        "container_id": "legacy-cache-folder",
    }


async def test_schema_prefills_board_yjs_catalog_cache_per_container(test_db):
    """schema.sql groups cache rows by folder/task container, not folder_id alone."""

    await _create_folder(test_db, "container-cache-folder", "Container Cache Folder")
    await test_db.execute(
        """
        INSERT INTO markdown_documents (id, title, body)
        VALUES
          ('container-folder-doc', 'Folder doc', 'folder body'),
          ('container-task-doc', 'Task doc', 'task body')
        """
    )
    await test_db.execute(
        """
        INSERT INTO board_items (
            id, folder_id, item_type, item_id, container_kind, container_id, x, y
        )
        VALUES
          ('markdown:container-folder-doc', 'container-cache-folder', 'markdown',
           'container-folder-doc', 'folder', 'container-cache-folder', 0, 0),
          ('markdown:container-task-doc', 'container-cache-folder', 'markdown',
           'container-task-doc', 'task', 'rb-cache', 20, 20)
        """
    )

    await test_db.execute(_schema_sql())

    rows = await test_db.fetch(
        """
        SELECT container_kind, container_id, board_items
        FROM board_yjs_catalog_cache
        WHERE folder_id = $1
        ORDER BY container_kind, container_id
        """,
        "container-cache-folder",
    )
    by_container = {
        (row["container_kind"], row["container_id"]): _decode_jsonb(row["board_items"])
        for row in rows
    }
    assert ("folder", "container-cache-folder") in by_container
    assert ("task", "rb-cache") in by_container
    assert by_container[("folder", "container-cache-folder")][0]["containerKind"] == "folder"
    assert by_container[("task", "rb-cache")][0]["containerKind"] == "task"


async def test_schema_reapply_upgrades_pre_status_tasks_table(test_db):
    """schema.sql만 재실행해도 029 이전 tasks 테이블이 최신 형태가 된다."""

    await test_db.execute(
        """
        DROP TABLE IF EXISTS task_operations CASCADE;
        DROP TABLE IF EXISTS task_items CASCADE;
        DROP TABLE IF EXISTS task_sections CASCADE;
        DROP TABLE IF EXISTS tasks CASCADE;
        """
    )
    await test_db.execute(
        """
        CREATE TABLE tasks (
            id                 TEXT PRIMARY KEY,
            board_item_id      TEXT NOT NULL REFERENCES board_items(id) ON DELETE CASCADE,
            title              TEXT NOT NULL DEFAULT '',
            archived           BOOLEAN NOT NULL DEFAULT FALSE,
            version            INTEGER NOT NULL DEFAULT 1,
            created_session_id TEXT REFERENCES sessions(session_id) ON DELETE SET NULL,
            created_event_id   INTEGER,
            created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            FOREIGN KEY (created_session_id, created_event_id)
                REFERENCES events(session_id, id) ON DELETE SET NULL
        );
        CREATE UNIQUE INDEX uq_tasks_board_item ON tasks(board_item_id);
        """
    )

    await _create_folder(test_db, "legacy-task-folder", "Legacy Task Folder")
    await test_db.execute(
        """
        INSERT INTO board_items (id, folder_id, item_type, item_id)
        VALUES ($1, $2, 'task', $3)
        """,
        "legacy-task-board-item",
        "legacy-task-folder",
        "legacy-task",
    )
    await test_db.execute(
        """
        INSERT INTO tasks (id, board_item_id, title)
        VALUES ($1, $2, $3)
        """,
        "legacy-task",
        "legacy-task-board-item",
        "Legacy Task",
    )

    await test_db.execute(_schema_sql())
    await test_db.execute(_schema_sql())

    row = await test_db.fetchrow(
        """
        SELECT status, completed_kind, completed_session_id, completed_event_id,
               completed_user_id, completed_at
        FROM tasks
        WHERE id = $1
        """,
        "legacy-task",
    )
    assert row["status"] == "open"
    assert row["completed_kind"] is None
    assert row["completed_session_id"] is None
    assert row["completed_event_id"] is None
    assert row["completed_user_id"] is None
    assert row["completed_at"] is None

    constraint_names = {
        row["conname"]
        for row in await test_db.fetch(
            """
            SELECT conname
            FROM pg_constraint
            WHERE conrelid = 'tasks'::regclass
            """
        )
    }
    assert {
        "tasks_status_check",
        "tasks_completed_kind_check",
        "tasks_completed_session_id_fkey",
        "tasks_completed_event_fkey",
    } <= constraint_names

    with pytest.raises(Exception):
        await test_db.execute("UPDATE tasks SET status = 'invalid'")
    with pytest.raises(Exception):
        await test_db.execute("UPDATE tasks SET completed_kind = 'system'")
    with pytest.raises(Exception):
        await test_db.execute("UPDATE tasks SET completed_session_id = 'missing-session'")


async def test_fresh_schema_uses_task_status_canonical_constraint_names(test_db):
    constraint_names = {
        row["conname"]
        for row in await test_db.fetch(
            """
            SELECT conname
            FROM pg_constraint
            WHERE conrelid = 'tasks'::regclass
            """
        )
    }

    assert "tasks_completed_event_fkey" in constraint_names
    assert "tasks_completed_session_id_completed_event_id_fkey" not in constraint_names


async def test_schema_reapply_upgrades_task_item_review_status_check(test_db):
    """schema.sql만 재실행해도 기존 task_items CHECK가 review를 허용한다."""

    await test_db.execute(
        """
        ALTER TABLE task_items DROP CONSTRAINT IF EXISTS task_items_status_check;
        ALTER TABLE task_items ADD CONSTRAINT task_items_status_check
            CHECK (status IN ('pending','in_progress','completed','cancelled'));
        """
    )

    await test_db.execute(_schema_sql())
    await _create_folder(test_db, "review-task-folder", "Review Task Folder")
    await test_db.execute(
        """
        INSERT INTO board_items (id, folder_id, item_type, item_id)
        VALUES ($1, $2, 'task', $3)
        """,
        "review-task-board-item",
        "review-task-folder",
        "review-task",
    )
    await test_db.execute(
        """
        INSERT INTO tasks (id, board_item_id, title)
        VALUES ($1, $2, $3)
        """,
        "review-task",
        "review-task-board-item",
        "Review Task",
    )
    await test_db.execute(
        """
        INSERT INTO task_sections (id, task_id, position_key, title)
        VALUES ($1, $2, $3, $4)
        """,
        "review-section",
        "review-task",
        "a",
        "Review Section",
    )
    await test_db.execute(
        """
        INSERT INTO task_items (id, section_id, position_key, title, status)
        VALUES ($1, $2, $3, $4, 'review')
        """,
        "review-item",
        "review-section",
        "a",
        "Ready",
    )

    status = await test_db.fetchval(
        "SELECT status FROM task_items WHERE id = $1",
        "review-item",
    )
    assert status == "review"


# === 세션 CRUD ===

async def test_session_upsert_and_get(test_db):
    now = _utc_now()
    await test_db.execute(
        "SELECT session_upsert($1, $2, $3, $4, $5)",
        "s1", ["status", "node_id", "session_type"], ["running", "node-a", "claude"], now, now,
    )

    row = await test_db.fetchrow("SELECT * FROM session_get($1)", "s1")
    assert row is not None
    assert row["session_id"] == "s1"
    assert row["status"] == "running"
    assert row["node_id"] == "node-a"
    assert row["session_type"] == "claude"


async def test_session_upsert_updates_existing(test_db):
    now = _utc_now()
    await test_db.execute(
        "SELECT session_upsert($1, $2, $3, $4, $5)",
        "s-up", ["status"], ["idle"], now, now,
    )
    await test_db.execute(
        "SELECT session_upsert($1, $2, $3, $4, $5)",
        "s-up", ["status"], ["running"], now, now,
    )
    row = await test_db.fetchrow("SELECT * FROM session_get($1)", "s-up")
    assert row["status"] == "running"


async def test_session_upsert_invalid_column(test_db):
    now = _utc_now()
    with pytest.raises(Exception, match="Invalid session column"):
        await test_db.execute(
            "SELECT session_upsert($1, $2, $3, $4, $5)",
            "s-bad", ["bogus_col"], ["val"], now, now,
        )


async def test_session_upsert_jsonb_columns(test_db):
    now = _utc_now()
    meta = json.dumps([{"type": "test", "value": "hello"}])
    msg = json.dumps({"text": "hi"})
    await test_db.execute(
        "SELECT session_upsert($1, $2, $3, $4, $5)",
        "s-json", ["metadata", "last_message", "status"], [meta, msg, "idle"], now, now,
    )
    row = await test_db.fetchrow("SELECT * FROM session_get($1)", "s-json")
    assert _decode_jsonb(row["metadata"]) == [{"type": "test", "value": "hello"}]
    assert _decode_jsonb(row["last_message"]) == {"text": "hi"}


async def test_session_get_all_and_count(test_db):
    now = _utc_now()
    for i in range(3):
        await test_db.execute(
            "SELECT session_upsert($1, $2, $3, $4, $5)",
            f"sa-{i}", ["session_type", "status"], ["claude", "idle"], now, now,
        )
    await test_db.execute(
        "SELECT session_upsert($1, $2, $3, $4, $5)",
        "sa-other", ["session_type", "status"], ["llm", "idle"], now, now,
    )

    # 전체 조회
    rows = await test_db.fetch("SELECT * FROM session_get_all(NULL)")
    assert len(rows) >= 4

    # 필터 조회
    filters = json.dumps({"session_type": "claude"})
    rows = await test_db.fetch("SELECT * FROM session_get_all($1::jsonb)", filters)
    claude_ids = [r["session_id"] for r in rows]
    assert all(sid.startswith("sa-") and sid != "sa-other" for sid in claude_ids if sid.startswith("sa-"))

    # count
    count = await test_db.fetchval("SELECT session_count($1::jsonb)", filters)
    assert count >= 3

    # limit/offset
    rows = await test_db.fetch("SELECT * FROM session_get_all(NULL, 2, 0)")
    assert len(rows) == 2


async def test_session_feed_only_excludes_hidden_folders_and_llm(test_db):
    await _create_folder(test_db, "feed-visible", "Feed Visible")
    await _create_folder(test_db, "feed-hidden", "Feed Hidden")
    await test_db.execute(
        "UPDATE folders SET settings = $1::jsonb WHERE id = $2",
        json.dumps({"excludeFromFeed": True}),
        "feed-hidden",
    )
    await _create_session(
        test_db,
        "feed-normal",
        folder_id="feed-visible",
        session_type="claude",
    )
    await _create_session(
        test_db,
        "feed-llm",
        folder_id="feed-visible",
        session_type="llm",
    )
    await _create_session(
        test_db,
        "feed-hidden-normal",
        folder_id="feed-hidden",
        session_type="claude",
    )

    filters = json.dumps({"feed_only": True})
    rows = await test_db.fetch(
        "SELECT * FROM session_get_all($1::jsonb, NULL, NULL)",
        filters,
    )
    count = await test_db.fetchval("SELECT session_count($1::jsonb)", filters)

    assert [row["session_id"] for row in rows] == ["feed-normal"]
    assert count == 1


async def test_session_delete(test_db):
    await _create_session(test_db, "s-del")
    await test_db.execute("SELECT session_delete($1)", "s-del")
    row = await test_db.fetchrow("SELECT * FROM session_get($1)", "s-del")
    assert row is None


async def test_claude_transcript_append_load_preserves_content_shapes(test_db):
    now = _utc_now()
    entries = [
        {
            "type": "user",
            "uuid": "u-scalar-content",
            "message": {"role": "user", "content": "plain text"},
        },
        {
            "type": "assistant",
            "uuid": "a-array-content",
            "message": {
                "role": "assistant",
                "content": [{"type": "text", "text": "hello"}],
            },
        },
        {
            "type": "system",
            "uuid": "s-object-content",
            "content": {"level": "info"},
        },
        {"type": "summary", "uuid": "missing-content"},
    ]

    written = await test_db.fetchval(
        "SELECT claude_transcript_append($1, $2, $3, $4::jsonb, $5)",
        "project-a",
        "claude-shapes",
        None,
        json.dumps(entries),
        now,
    )

    rows = await test_db.fetch(
        "SELECT entry FROM claude_transcript_load($1, $2, $3)",
        "project-a",
        "claude-shapes",
        None,
    )
    assert written == len(entries)
    assert [_decode_jsonb(row["entry"]) for row in rows] == entries


async def test_claude_transcript_append_normalizes_single_object_and_scalar_batches(test_db):
    now = _utc_now()
    entry = {
        "type": "user",
        "uuid": "u-single-object",
        "message": {"role": "user", "content": "scalar content"},
    }

    object_written = await test_db.fetchval(
        "SELECT claude_transcript_append($1, $2, $3, $4::jsonb, $5)",
        "project-a",
        "claude-single",
        None,
        json.dumps(entry),
        now,
    )
    scalar_written = await test_db.fetchval(
        "SELECT claude_transcript_append($1, $2, $3, $4::jsonb, $5)",
        "project-a",
        "claude-scalar",
        None,
        json.dumps("stray scalar"),
        now,
    )

    rows = await test_db.fetch(
        "SELECT entry FROM claude_transcript_load($1, $2, $3)",
        "project-a",
        "claude-single",
        None,
    )
    assert object_written == 1
    assert [_decode_jsonb(row["entry"]) for row in rows] == [entry]
    assert scalar_written == 0


# === 세션 메타데이터 & 메시지 ===

async def test_session_append_metadata(test_db):
    await _create_session(test_db, "s-meta")
    now = _utc_now()

    meta_json = json.dumps([{"type": "test", "value": "v1"}])
    event_payload = json.dumps({"type": "metadata", "metadata_type": "test"})

    event_id = await test_db.fetchval(
        "SELECT session_append_metadata($1, $2, $3, $4, $5, $6)",
        "s-meta", meta_json, "metadata", event_payload, "test: v1", now,
    )
    assert event_id == 1

    # metadata가 append됐는지
    row = await test_db.fetchrow("SELECT * FROM session_get($1)", "s-meta")
    assert row["metadata"] is not None
    assert len(_decode_jsonb(row["metadata"])) == 1

    # last_event_id 갱신됐는지
    assert row["last_event_id"] == 1


async def test_session_append_metadata_not_found(test_db):
    now = _utc_now()
    with pytest.raises(Exception, match="Session not found"):
        await test_db.fetchval(
            "SELECT session_append_metadata($1, $2, $3, $4, $5, $6)",
            "nonexistent", "[]", "metadata", "{}", "", now,
        )


async def test_session_update_last_message(test_db):
    await _create_session(test_db, "s-msg")
    now = _utc_now()
    msg = json.dumps({"text": "hello"})
    await test_db.execute(
        "SELECT session_update_last_message($1, $2, $3)", "s-msg", msg, now
    )
    row = await test_db.fetchrow("SELECT * FROM session_get($1)", "s-msg")
    assert _decode_jsonb(row["last_message"]) == {"text": "hello"}


# === 읽음 상태 ===

async def test_session_read_position(test_db):
    await _create_session(test_db, "s-read")

    result = await test_db.fetchval(
        "SELECT session_update_read_position($1, $2)", "s-read", 5
    )
    assert result == "UPDATE 1"

    row = await test_db.fetchrow(
        "SELECT * FROM session_get_read_position($1)", "s-read"
    )
    assert row["last_read_event_id"] == 5


async def test_session_update_read_position_not_found(test_db):
    result = await test_db.fetchval(
        "SELECT session_update_read_position($1, $2)", "nonexistent", 5
    )
    assert result == "UPDATE 0"


# === 세션 이름 & 폴더 ===

async def test_session_rename(test_db):
    await _create_session(test_db, "s-rename")
    await test_db.execute("SELECT session_rename($1, $2)", "s-rename", "New Name")
    row = await test_db.fetchrow("SELECT * FROM session_get($1)", "s-rename")
    assert row["display_name"] == "New Name"


async def test_session_assign_folder(test_db):
    await _create_folder(test_db, "f-assign", "Assign Folder")
    await _create_session(test_db, "s-assign")
    await test_db.execute("SELECT session_assign_folder($1, $2)", "s-assign", "f-assign")
    row = await test_db.fetchrow("SELECT * FROM session_get($1)", "s-assign")
    assert row["folder_id"] == "f-assign"


# === Graceful Shutdown ===

async def test_shutdown_mark_running_all(test_db):
    now = _utc_now()
    await test_db.execute(
        "SELECT session_upsert($1, $2, $3, $4, $5)",
        "sh-1", ["status"], ["running"], now, now,
    )
    await test_db.execute(
        "SELECT session_upsert($1, $2, $3, $4, $5)",
        "sh-2", ["status"], ["idle"], now, now,
    )

    await test_db.execute("SELECT shutdown_mark_running(NULL)")

    rows = await test_db.fetch("SELECT * FROM shutdown_get_sessions()")
    session_ids = [r["session_id"] for r in rows]
    assert "sh-1" in session_ids
    assert "sh-2" not in session_ids


async def test_shutdown_mark_running_by_ids(test_db):
    now = _utc_now()
    await test_db.execute(
        "SELECT session_upsert($1, $2, $3, $4, $5)",
        "sh-3", ["status"], ["idle"], now, now,
    )
    await test_db.execute("SELECT shutdown_mark_running($1)", ["sh-3"])
    rows = await test_db.fetch("SELECT * FROM shutdown_get_sessions()")
    assert any(r["session_id"] == "sh-3" for r in rows)


async def test_shutdown_mark_running_empty_array(test_db):
    # 빈 배열은 no-op
    await test_db.execute("SELECT shutdown_mark_running($1::text[])", [])


async def test_shutdown_clear_flags(test_db):
    now = _utc_now()
    await test_db.execute(
        "SELECT session_upsert($1, $2, $3, $4, $5)",
        "sh-clear", ["status", "was_running_at_shutdown"], ["running", "true"], now, now,
    )
    await test_db.execute("SELECT shutdown_clear_flags()")
    row = await test_db.fetchrow("SELECT * FROM session_get($1)", "sh-clear")
    assert row["was_running_at_shutdown"] is False


async def test_shutdown_repair_read_positions(test_db):
    now = _utc_now()
    await test_db.execute(
        "SELECT session_upsert($1, $2, $3, $4, $5)",
        "sh-repair",
        ["status", "last_event_id", "last_read_event_id"],
        ["idle", "10", "5"],
        now, now,
    )
    count = await test_db.fetchval("SELECT shutdown_repair_read_positions()")
    assert count >= 1

    row = await test_db.fetchrow("SELECT * FROM session_get($1)", "sh-repair")
    assert row["last_read_event_id"] == row["last_event_id"]


# === 이벤트 CRUD ===

async def test_event_append_and_read(test_db):
    await _create_session(test_db, "ev-1")
    now = _utc_now()

    eid = await test_db.fetchval(
        "SELECT event_append($1, $2, $3, $4, $5)",
        "ev-1", "text_delta", '{"text":"hello"}', "hello", now,
    )
    assert eid == 1

    eid2 = await test_db.fetchval(
        "SELECT event_append($1, $2, $3, $4, $5)",
        "ev-1", "text_delta", '{"text":"world"}', "world", now,
    )
    assert eid2 == 2

    # read all
    rows = await test_db.fetch("SELECT * FROM event_read($1)", "ev-1")
    assert len(rows) == 2

    # read after id 1
    rows = await test_db.fetch("SELECT * FROM event_read($1, $2)", "ev-1", 1)
    assert len(rows) == 1
    assert rows[0]["id"] == 2


async def test_event_read_one(test_db):
    await _create_session(test_db, "ev-one")
    now = _utc_now()
    eid = await test_db.fetchval(
        "SELECT event_append($1, $2, $3, $4, $5)",
        "ev-one", "test", '{"n":1}', "test 1", now,
    )
    row = await test_db.fetchrow("SELECT * FROM event_read_one($1, $2)", "ev-one", eid)
    assert row is not None
    assert row["event_type"] == "test"


async def test_event_stream_raw(test_db):
    await _create_session(test_db, "ev-raw")
    now = _utc_now()
    await test_db.fetchval(
        "SELECT event_append($1, $2, $3, $4, $5)",
        "ev-raw", "test", '{"k":"v"}', "test", now,
    )
    rows = await test_db.fetch("SELECT * FROM event_stream_raw($1)", "ev-raw")
    assert len(rows) == 1
    # payload_text는 JSON 문자열
    assert '"k"' in rows[0]["payload_text"]


async def test_event_count(test_db):
    await _create_session(test_db, "ev-cnt")
    now = _utc_now()
    for i in range(3):
        await test_db.fetchval(
            "SELECT event_append($1, $2, $3, $4, $5)",
            "ev-cnt", "test", f'{{"n":{i}}}', f"test {i}", now,
        )
    count = await test_db.fetchval("SELECT event_count($1)", "ev-cnt")
    assert count == 3


async def test_supervisor_event_append_idempotent_and_contiguous_cursor(test_db):
    now = _utc_now()

    first = await test_db.fetchrow(
        "SELECT * FROM supervisor_event_append($1, $2, $3, $4, $5, $6)",
        "node-a", "sess-a", 1, "text_delta", '{"text":"one"}', now,
    )
    assert first["offset"] > 0
    assert first["inserted"] is True
    assert first["contiguous_upto"] == 1
    assert first["highest_seen_event_id"] == 1
    assert first["gap_start"] is None
    assert first["gap_end"] is None

    third = await test_db.fetchrow(
        "SELECT * FROM supervisor_event_append($1, $2, $3, $4, $5, $6)",
        "node-a", "sess-a", 3, "tool_result", '{"text":"three"}', now,
    )
    assert third["offset"] > first["offset"]
    assert third["inserted"] is True
    assert third["contiguous_upto"] == 1
    assert third["highest_seen_event_id"] == 3
    assert third["gap_start"] == 2
    assert third["gap_end"] == 2

    duplicate = await test_db.fetchrow(
        "SELECT * FROM supervisor_event_append($1, $2, $3, $4, $5, $6)",
        "node-a", "sess-a", 3, "tool_result", '{"text":"duplicate"}', now,
    )
    assert duplicate["offset"] == third["offset"]
    assert duplicate["inserted"] is False
    assert await test_db.fetchval("SELECT COUNT(*) FROM supervisor_events") == 2

    second = await test_db.fetchrow(
        "SELECT * FROM supervisor_event_append($1, $2, $3, $4, $5, $6)",
        "node-a", "sess-a", 2, "text_delta", '{"text":"two"}', now,
    )
    assert second["offset"] > third["offset"]
    assert second["inserted"] is True
    assert second["contiguous_upto"] == 3
    assert second["highest_seen_event_id"] == 3
    assert second["gap_start"] is None
    assert second["gap_end"] is None

    cursor = await test_db.fetchrow(
        "SELECT * FROM supervisor_source_cursor_get($1, $2)",
        "node-a", "sess-a",
    )
    assert cursor["contiguous_upto"] == 3
    assert cursor["highest_seen_event_id"] == 3
    assert cursor["gap_start"] is None
    assert cursor["gap_end"] is None

    rows = await test_db.fetch("SELECT * FROM supervisor_event_read_after($1, $2)", 0, 10)
    assert [row["offset"] for row in rows] == [
        first["offset"],
        third["offset"],
        second["offset"],
    ]
    assert [row["source_event_id"] for row in rows] == [1, 3, 2]


async def test_supervisor_consumer_cursor_registry_and_schema_reapply(test_db):
    now = _utc_now()

    await test_db.fetchrow(
        "SELECT * FROM supervisor_event_append($1, $2, $3, $4, $5, $6)",
        "node-restart", "sess-restart", 1, "session_created", '{"ok":true}', now,
    )
    await test_db.execute(
        "SELECT supervisor_consumer_cursor_set($1, $2)",
        "cluster-supervisor", 1,
    )
    assert await test_db.fetchval(
        "SELECT supervisor_consumer_cursor_get($1)",
        "cluster-supervisor",
    ) == 1

    registry = await test_db.fetchrow(
        "SELECT * FROM supervisor_registry_upsert($1, $2, $3, $4, $5, $6, $7, $8)",
        "cluster",
        "sess-supervisor",
        7,
        1,
        "idle_pending",
        1200,
        1,
        now,
    )
    assert registry["role"] == "cluster"
    assert registry["active_session_id"] == "sess-supervisor"
    assert registry["epoch"] == 7
    assert registry["cursor_offset"] == 1
    assert registry["handover_state"] == "idle_pending"
    assert registry["cumulative_tokens"] == 1200
    assert registry["compaction_count"] == 1
    assert registry["last_seen_at"] == now

    usage = await test_db.fetchrow(
        "SELECT * FROM supervisor_registry_record_usage_delta($1, $2, $3, $4)",
        "cluster",
        300,
        2,
        now,
    )
    assert usage["cumulative_tokens"] == 1500
    assert usage["compaction_count"] == 3

    touched = await test_db.fetchrow(
        "SELECT * FROM supervisor_registry_touch($1, $2)",
        "cluster",
        now,
    )
    assert touched["role"] == "cluster"
    assert touched["last_seen_at"] == now

    schema_path = (
        Path(__file__).resolve().parents[1]
        / "sql"
        / "schema.sql"
    )
    await test_db.execute(schema_path.read_text(encoding="utf-8"))

    recovered = await test_db.fetch("SELECT * FROM supervisor_event_read_after($1, $2)", 0, 10)
    assert len(recovered) == 1
    assert recovered[0]["source_node"] == "node-restart"
    assert await test_db.fetchval(
        "SELECT supervisor_consumer_cursor_get($1)",
        "cluster-supervisor",
    ) == 1
    assert await test_db.fetchrow("SELECT * FROM supervisor_registry_get($1)", "cluster")

    assert await test_db.fetchval("SELECT supervisor_registry_delete($1)", "cluster") is True
    assert await test_db.fetchrow("SELECT * FROM supervisor_registry_get($1)", "cluster") is None


async def test_event_append_parent_event_id_integer(test_db):
    """payload.parent_event_id가 정수 문자열이면 컬럼에 INTEGER로 저장된다."""
    await _create_session(test_db, "ev-pe-int")
    now = _utc_now()

    eid1 = await test_db.fetchval(
        "SELECT event_append($1, $2, $3, $4, $5)",
        "ev-pe-int", "text_delta", '{"text":"first"}', "first", now,
    )
    eid2 = await test_db.fetchval(
        "SELECT event_append($1, $2, $3, $4, $5)",
        "ev-pe-int", "text_delta",
        json.dumps({"text": "second", "parent_event_id": str(eid1)}),
        "second", now,
    )

    row = await test_db.fetchrow("SELECT * FROM event_read_one($1, $2)", "ev-pe-int", eid2)
    assert row["parent_event_id"] == eid1


async def test_event_append_parent_event_id_uuid_does_not_crash(test_db):
    """payload.parent_event_id가 UUID여도 INSERT가 성공하고 컬럼은 NULL로 남는다.

    레거시 이벤트(tool_use_id, subagent UUID)가 같은 키에 들어 있는 사례가 5,252건 존재.
    의미가 다른 키이므로 컬럼은 NULL로 두되, INSERT 자체가 실패해서는 안 된다.
    """
    await _create_session(test_db, "ev-pe-uuid")
    now = _utc_now()

    eid = await test_db.fetchval(
        "SELECT event_append($1, $2, $3, $4, $5)",
        "ev-pe-uuid", "subagent_start",
        json.dumps({"parent_event_id": "f5848770-5933-4f4c-8f08-107d790bfe4b"}),
        "sub", now,
    )
    row = await test_db.fetchrow("SELECT * FROM event_read_one($1, $2)", "ev-pe-uuid", eid)
    assert row["parent_event_id"] is None


async def test_event_append_parent_event_id_tool_use_id_does_not_crash(test_db):
    """payload.parent_event_id가 'toolu_...' tool_use_id여도 NULL로 떨어진다."""
    await _create_session(test_db, "ev-pe-tool")
    now = _utc_now()

    eid = await test_db.fetchval(
        "SELECT event_append($1, $2, $3, $4, $5)",
        "ev-pe-tool", "tool_start",
        json.dumps({"parent_event_id": "toolu_01Y3nys4t9Dqk6tznWFuFTam"}),
        "tool", now,
    )
    row = await test_db.fetchrow("SELECT * FROM event_read_one($1, $2)", "ev-pe-tool", eid)
    assert row["parent_event_id"] is None


async def test_event_append_parent_event_id_absent(test_db):
    """payload에 parent_event_id가 없으면 컬럼 NULL."""
    await _create_session(test_db, "ev-pe-none")
    now = _utc_now()

    eid = await test_db.fetchval(
        "SELECT event_append($1, $2, $3, $4, $5)",
        "ev-pe-none", "text_delta", '{"text":"x"}', "x", now,
    )
    row = await test_db.fetchrow("SELECT * FROM event_read_one($1, $2)", "ev-pe-none", eid)
    assert row["parent_event_id"] is None


async def test_event_append_parent_event_id_int_overflow(test_db):
    """payload.parent_event_id가 INT 범위 초과 정수여도 NULL로 떨어진다.

    프로덕션에서 발견된 input_request_responded 이벤트의 12자리 값(407885725189) 케이스.
    timestamp 같은 잘못된 값이 들어왔을 때 NumericValueOutOfRangeError로 INSERT가 실패하면
    안 된다.
    """
    await _create_session(test_db, "ev-pe-overflow")
    now = _utc_now()

    eid = await test_db.fetchval(
        "SELECT event_append($1, $2, $3, $4, $5)",
        "ev-pe-overflow", "input_request_responded",
        json.dumps({"parent_event_id": "407885725189"}),
        "x", now,
    )
    row = await test_db.fetchrow("SELECT * FROM event_read_one($1, $2)", "ev-pe-overflow", eid)
    assert row["parent_event_id"] is None


async def test_event_append_parent_event_id_int_max_boundary(test_db):
    """INT MAX라도 부모 행이 없으면 NULL, MAX+1(2147483648)도 NULL."""
    await _create_session(test_db, "ev-pe-boundary")
    now = _utc_now()

    eid_max = await test_db.fetchval(
        "SELECT event_append($1, $2, $3, $4, $5)",
        "ev-pe-boundary", "test",
        json.dumps({"parent_event_id": "2147483647"}),
        "x", now,
    )
    row = await test_db.fetchrow(
        "SELECT * FROM event_read_one($1, $2)", "ev-pe-boundary", eid_max
    )
    assert row["parent_event_id"] is None

    eid_over = await test_db.fetchval(
        "SELECT event_append($1, $2, $3, $4, $5)",
        "ev-pe-boundary", "test",
        json.dumps({"parent_event_id": "2147483648"}),
        "x", now,
    )
    row = await test_db.fetchrow(
        "SELECT * FROM event_read_one($1, $2)", "ev-pe-boundary", eid_over
    )
    assert row["parent_event_id"] is None


async def test_event_append_parent_event_id_empty_string(test_db):
    """payload.parent_event_id가 빈 문자열이어도 NULL로 떨어진다.

    과거 backfill 스크립트가 NULLIF(..., '') 패턴을 썼던 흔적으로, 빈 문자열 형태가
    잠재적으로 들어올 수 있어 회귀 표면.
    """
    await _create_session(test_db, "ev-pe-empty")
    now = _utc_now()

    eid = await test_db.fetchval(
        "SELECT event_append($1, $2, $3, $4, $5)",
        "ev-pe-empty", "text_delta",
        json.dumps({"parent_event_id": ""}),
        "x", now,
    )
    row = await test_db.fetchrow("SELECT * FROM event_read_one($1, $2)", "ev-pe-empty", eid)
    assert row["parent_event_id"] is None


async def test_event_append_concurrency(test_db):
    """동시에 10개 이벤트를 append해도 ID 중복이 없어야 한다."""
    await _create_session(test_db, "ev-conc")
    now = _utc_now()

    async def append_one(n):
        return await test_db.fetchval(
            "SELECT event_append($1, $2, $3, $4, $5)",
            "ev-conc", "test", json.dumps({"n": n}), f"test {n}", now,
        )

    results = await asyncio.gather(*[append_one(i) for i in range(10)])
    ids = list(results)
    assert len(set(ids)) == 10, f"Duplicate IDs detected: {ids}"
    assert sorted(ids) == list(range(1, 11))


async def test_event_updates_last_event_id(test_db):
    """event_append가 sessions.last_event_id를 갱신하는지 검증."""
    await _create_session(test_db, "ev-lei")
    now = _utc_now()
    eid = await test_db.fetchval(
        "SELECT event_append($1, $2, $3, $4, $5)",
        "ev-lei", "test", '{"x":1}', "test", now,
    )
    row = await test_db.fetchrow("SELECT * FROM session_get($1)", "ev-lei")
    assert row["last_event_id"] == eid


# === 이벤트 검색 ===

async def test_event_search(test_db):
    await _create_session(test_db, "ev-search")
    now = _utc_now()

    await test_db.fetchval(
        "SELECT event_append($1, $2, $3, $4, $5)",
        "ev-search", "text_delta", '{"text":"unique_keyword_xyz"}',
        "unique_keyword_xyz", now,
    )
    await test_db.fetchval(
        "SELECT event_append($1, $2, $3, $4, $5)",
        "ev-search", "text_delta", '{"text":"other content"}',
        "other content", now,
    )

    # 전체 검색
    rows = await test_db.fetch(
        "SELECT * FROM event_search($1)", "unique_keyword_xyz"
    )
    assert len(rows) >= 1
    assert any(r["session_id"] == "ev-search" for r in rows)

    # session_ids 필터
    rows = await test_db.fetch(
        "SELECT * FROM event_search($1, $2)", "unique_keyword_xyz", ["ev-search"]
    )
    assert len(rows) >= 1

    # 매칭 안 되는 검색
    rows = await test_db.fetch(
        "SELECT * FROM event_search($1, $2)", "unique_keyword_xyz", ["nonexistent"]
    )
    assert len(rows) == 0


async def test_event_search_uses_bm25_terms(test_db):
    await _create_session(test_db, "ev-bm25")
    now = _utc_now()

    await test_db.fetchval(
        "SELECT event_append($1, $2, $3, $4, $5)",
        "ev-bm25", "user_message", '{"text":"alpha alpha alpha beta"}',
        "alpha alpha alpha beta", now,
    )
    await test_db.fetchval(
        "SELECT event_append($1, $2, $3, $4, $5)",
        "ev-bm25", "user_message", '{"text":"alpha beta gamma delta epsilon"}',
        "alpha beta gamma delta epsilon", now,
    )

    terms = await test_db.fetch(
        """
        SELECT event_id, term, term_freq, doc_len
        FROM event_search_terms
        WHERE session_id = $1 AND term = $2
        ORDER BY event_id
        """,
        "ev-bm25", "alpha",
    )
    assert [r["term_freq"] for r in terms] == [3, 1]
    assert [r["doc_len"] for r in terms] == [4, 5]

    rows = await test_db.fetch(
        "SELECT * FROM event_search($1, $2, $3, $4)",
        "alpha", ["ev-bm25"], 10, ["user_message"],
    )
    assert [r["id"] for r in rows[:2]] == [1, 2]
    assert rows[0]["score"] > rows[1]["score"]


async def test_event_search_matches_korean_prefix_inflections(test_db):
    await _create_session(test_db, "ev-ko-prefix")
    now = _utc_now()

    await test_db.fetchval(
        "SELECT event_append($1, $2, $3, $4, $5)",
        "ev-ko-prefix", "text_delta", '{"text":"가라앉은다"}',
        "가라앉은다", now,
    )
    await test_db.fetchval(
        "SELECT event_append($1, $2, $3, $4, $5)",
        "ev-ko-prefix", "text_delta", '{"text":"무관한 문장"}',
        "무관한 문장", now,
    )

    rows = await test_db.fetch(
        "SELECT * FROM event_search($1, $2, $3, $4)",
        "가라앉은", ["ev-ko-prefix"], 10, ["text_delta"],
    )

    assert [r["id"] for r in rows] == [1]
    assert rows[0]["searchable_text"] == "가라앉은다"
    assert rows[0]["score"] > 0

    inflected_rows = await test_db.fetch(
        "SELECT * FROM event_search($1, $2, $3, $4)",
        "가라앉았다", ["ev-ko-prefix"], 10, ["text_delta"],
    )

    assert [r["id"] for r in inflected_rows] == [1]


async def test_event_search_corpus_stats_track_event_lifecycle(test_db):
    await _create_session(test_db, "ev-search-stats")
    now = _utc_now()

    event_id = await test_db.fetchval(
        "SELECT event_append($1, $2, $3, $4, $5)",
        "ev-search-stats", "text_delta", '{"text":"alpha beta beta"}',
        "alpha beta beta", now,
    )
    stats = await test_db.fetchrow(
        "SELECT total_docs, total_doc_len FROM event_search_corpus_stats WHERE id = TRUE"
    )
    assert dict(stats) == {"total_docs": 1, "total_doc_len": 3}

    await test_db.execute(
        """
        UPDATE events
        SET searchable_text = $1
        WHERE session_id = $2 AND id = $3
        """,
        "alpha beta gamma delta", "ev-search-stats", event_id,
    )
    stats = await test_db.fetchrow(
        "SELECT total_docs, total_doc_len FROM event_search_corpus_stats WHERE id = TRUE"
    )
    assert dict(stats) == {"total_docs": 1, "total_doc_len": 4}

    await test_db.execute(
        "DELETE FROM events WHERE session_id = $1 AND id = $2",
        "ev-search-stats", event_id,
    )
    stats = await test_db.fetchrow(
        "SELECT total_docs, total_doc_len FROM event_search_corpus_stats WHERE id = TRUE"
    )
    assert dict(stats) == {"total_docs": 0, "total_doc_len": 0}


async def test_event_search_dashboard_path_uses_cached_corpus_with_large_term_table(test_db):
    await _create_session(test_db, "ev-ko-prefix-perf")
    now = _utc_now()

    await test_db.execute(
        """
        INSERT INTO events (session_id, id, event_type, payload, searchable_text, created_at)
        SELECT $1, gs, 'text_delta', '{}'::jsonb, '', $2
        FROM generate_series(1, 10000) AS gs
        """,
        "ev-ko-prefix-perf", now,
    )
    await test_db.execute(
        """
        INSERT INTO event_search_terms (session_id, event_id, term, term_freq, doc_len)
        SELECT $1, event_id, 'zz_noise_' || event_id::TEXT || '_' || term_no::TEXT, 1, 20
        FROM generate_series(1, 10000) AS event_id
        CROSS JOIN generate_series(1, 20) AS term_no
        """,
        "ev-ko-prefix-perf",
    )
    await test_db.fetchval(
        "SELECT event_append($1, $2, $3, $4, $5)",
        "ev-ko-prefix-perf", "text_delta", '{"text":"가라앉은다"}',
        "가라앉은다", now,
    )
    await test_db.execute(
        """
        UPDATE event_search_terms
        SET doc_len = 20
        WHERE session_id = $1 AND event_id = 10001
        """,
        "ev-ko-prefix-perf",
    )
    await test_db.execute(
        """
        INSERT INTO event_search_terms (session_id, event_id, term, term_freq, doc_len)
        SELECT $1, 10001, 'match_noise_' || term_no::TEXT, 1, 20
        FROM generate_series(1, 19) AS term_no
        """,
        "ev-ko-prefix-perf",
    )
    await test_db.execute(
        """
        INSERT INTO event_search_corpus_stats (id, total_docs, total_doc_len, updated_at)
        SELECT
            TRUE,
            COUNT(*)::BIGINT,
            COALESCE(SUM(doc_len), 0)::BIGINT,
            NOW()
        FROM (
            SELECT DISTINCT session_id, event_id, doc_len
            FROM event_search_terms
        ) docs
        ON CONFLICT (id) DO UPDATE
        SET total_docs = EXCLUDED.total_docs,
            total_doc_len = EXCLUDED.total_doc_len,
            updated_at = NOW()
        """
    )
    await test_db.execute("ANALYZE events")
    await test_db.execute("ANALYZE event_search_terms")

    await test_db.execute("SET statement_timeout = '1000ms'")
    try:
        exact_rows = await test_db.fetch(
            "SELECT * FROM event_search($1, $2, $3, $4)",
            "가라앉은다", None, 5, DASHBOARD_SEARCH_EVENT_TYPES,
        )
        prefix_rows = await test_db.fetch(
            "SELECT * FROM event_search($1, $2, $3, $4)",
            "가라앉았다", None, 5, DASHBOARD_SEARCH_EVENT_TYPES,
        )
    finally:
        await test_db.execute("RESET statement_timeout")

    assert [r["id"] for r in exact_rows] == [10001]
    assert [r["id"] for r in prefix_rows] == [10001]


async def test_event_search_handles_short_and_symbol_queries(test_db):
    await _create_session(test_db, "ev-short-symbol")
    now = _utc_now()

    await test_db.fetchval(
        "SELECT event_append($1, $2, $3, $4, $5)",
        "ev-short-symbol", "user_message", '{"text":"x 100% 완료"}',
        "x 100% 완료", now,
    )

    short_rows = await test_db.fetch(
        "SELECT * FROM event_search($1, $2, $3, $4)",
        "x", ["ev-short-symbol"], 10, ["user_message"],
    )
    symbol_rows = await test_db.fetch(
        "SELECT * FROM event_search($1, $2, $3, $4)",
        "100%", ["ev-short-symbol"], 10, ["user_message"],
    )

    assert [r["id"] for r in short_rows] == [1]
    assert [r["id"] for r in symbol_rows] == [1]


# === 폴더 CRUD ===

async def test_folder_create_and_get(test_db):
    await test_db.execute("SELECT folder_create($1, $2, $3)", "f1", "Folder 1", 10)
    row = await test_db.fetchrow("SELECT * FROM folder_get($1)", "f1")
    assert row is not None
    assert row["name"] == "Folder 1"
    assert row["sort_order"] == 10


async def test_folder_update(test_db):
    await _create_folder(test_db, "f-upd", "Before")
    await test_db.execute(
        "SELECT folder_update($1, $2, $3)",
        "f-upd", ["name", "sort_order"], ["After", "5"],
    )
    row = await test_db.fetchrow("SELECT * FROM folder_get($1)", "f-upd")
    assert row["name"] == "After"
    assert row["sort_order"] == 5


async def test_folder_update_invalid_column(test_db):
    await _create_folder(test_db, "f-bad", "Bad")
    with pytest.raises(Exception, match="Invalid folder column"):
        await test_db.execute(
            "SELECT folder_update($1, $2, $3)",
            "f-bad", ["hacked"], ["value"],
        )


async def test_folder_delete(test_db):
    await _create_folder(test_db, "f-del", "Delete Me")
    await test_db.execute("SELECT folder_delete($1)", "f-del")
    row = await test_db.fetchrow("SELECT * FROM folder_get($1)", "f-del")
    assert row is None


async def test_folder_get_all(test_db):
    await _create_folder(test_db, "fa-2", "Bravo", 2)
    await _create_folder(test_db, "fa-1", "Alpha", 1)
    rows = await test_db.fetch("SELECT * FROM folder_get_all()")
    names = [r["name"] for r in rows]
    # sort_order ASC → Alpha(1) before Bravo(2)
    alpha_idx = names.index("Alpha")
    bravo_idx = names.index("Bravo")
    assert alpha_idx < bravo_idx


async def test_folder_get_default(test_db):
    await _create_folder(test_db, "f-def", "Special Name")
    row = await test_db.fetchrow("SELECT * FROM folder_get_default($1)", "Special Name")
    assert row is not None
    assert row["id"] == "f-def"


async def test_folder_ensure_defaults(test_db):
    folders_json = json.dumps([
        {"id": "fe-1", "name": "Default 1", "sort_order": 0},
        {"id": "fe-2", "name": "Default 2", "sort_order": 1},
    ])
    await test_db.execute("SELECT folder_ensure_defaults($1::jsonb)", folders_json)

    row = await test_db.fetchrow("SELECT * FROM folder_get($1)", "fe-1")
    assert row is not None

    # 이미 존재하면 DO NOTHING
    await test_db.execute("SELECT folder_ensure_defaults($1::jsonb)", folders_json)
    row = await test_db.fetchrow("SELECT * FROM folder_get($1)", "fe-1")
    assert row is not None


# === 카탈로그 ===

async def test_catalog_get_sessions(test_db):
    await _create_folder(test_db, "f-cat", "Catalog Folder")
    now = _utc_now()
    await test_db.execute(
        "SELECT session_upsert($1, $2, $3, $4, $5)",
        "cat-1", ["folder_id", "display_name", "status"],
        ["f-cat", "My Session", "idle"], now, now,
    )
    rows = await test_db.fetch("SELECT * FROM catalog_get_sessions()")
    match = [r for r in rows if r["session_id"] == "cat-1"]
    assert len(match) == 1
    assert match[0]["folder_id"] == "f-cat"
    assert match[0]["display_name"] == "My Session"


# === 마이그레이션 ===

async def test_migration_upsert_folder(test_db):
    await test_db.execute("SELECT migration_upsert_folder($1, $2, $3)", "mf-1", "Migrated", 0)
    row = await test_db.fetchrow("SELECT * FROM folder_get($1)", "mf-1")
    assert row is not None

    # 再度実行しても DO NOTHING
    await test_db.execute("SELECT migration_upsert_folder($1, $2, $3)", "mf-1", "Changed", 1)
    row = await test_db.fetchrow("SELECT * FROM folder_get($1)", "mf-1")
    assert row["name"] == "Migrated"  # 変更されない


async def test_migration_upsert_session(test_db):
    data = json.dumps({
        "status": "idle",
        "node_id": "test-node",
        "session_type": "claude",
    })
    await test_db.execute("SELECT migration_upsert_session($1, $2::jsonb)", "ms-1", data)
    row = await test_db.fetchrow("SELECT * FROM session_get($1)", "ms-1")
    assert row is not None
    assert row["status"] == "idle"

    # upsert: 상태 변경
    data2 = json.dumps({"status": "running", "node_id": "test-node"})
    await test_db.execute("SELECT migration_upsert_session($1, $2::jsonb)", "ms-1", data2)
    row = await test_db.fetchrow("SELECT * FROM session_get($1)", "ms-1")
    assert row["status"] == "running"


async def test_migration_insert_event(test_db):
    await _create_session(test_db, "me-1")
    now = _utc_now()
    payload = json.dumps({"text": "migrated"})
    await test_db.execute(
        "SELECT migration_insert_event($1, $2, $3, $4::jsonb, $5, $6)",
        "me-1", 100, "text_delta", payload, "migrated", now,
    )
    row = await test_db.fetchrow("SELECT * FROM event_read_one($1, $2)", "me-1", 100)
    assert row is not None

    # ON CONFLICT DO NOTHING
    await test_db.execute(
        "SELECT migration_insert_event($1, $2, $3, $4::jsonb, $5, $6)",
        "me-1", 100, "text_delta", payload, "migrated", now,
    )


async def test_migration_ensure_session(test_db):
    data = json.dumps({"status": "idle", "node_id": "test-node"})
    await test_db.execute("SELECT migration_ensure_session($1, $2::jsonb)", "mes-1", data)
    row = await test_db.fetchrow("SELECT * FROM session_get($1)", "mes-1")
    assert row is not None

    # 既存なら INSERT しない
    data2 = json.dumps({"status": "running", "node_id": "test-node"})
    await test_db.execute("SELECT migration_ensure_session($1, $2::jsonb)", "mes-1", data2)
    row = await test_db.fetchrow("SELECT * FROM session_get($1)", "mes-1")
    assert row["status"] == "idle"  # 変更されない


async def test_migration_update_last_event_id(test_db):
    await _create_session(test_db, "mlei-1")

    # 初回: NULL → 10
    await test_db.execute("SELECT migration_update_last_event_id($1, $2)", "mlei-1", 10)
    row = await test_db.fetchrow("SELECT * FROM session_get($1)", "mlei-1")
    assert row["last_event_id"] == 10

    # より大きい値 → 更新
    await test_db.execute("SELECT migration_update_last_event_id($1, $2)", "mlei-1", 20)
    row = await test_db.fetchrow("SELECT * FROM session_get($1)", "mlei-1")
    assert row["last_event_id"] == 20

    # より小さい値 → 更新しない
    await test_db.execute("SELECT migration_update_last_event_id($1, $2)", "mlei-1", 5)
    row = await test_db.fetchrow("SELECT * FROM session_get($1)", "mlei-1")
    assert row["last_event_id"] == 20


async def test_migration_verify(test_db):
    now = _utc_now()
    await test_db.execute(
        "SELECT session_upsert($1, $2, $3, $4, $5)",
        "mv-1", ["node_id", "status"], ["verify-node", "idle"], now, now,
    )
    await test_db.fetchval(
        "SELECT event_append($1, $2, $3, $4, $5)",
        "mv-1", "test", '{"x":1}', "test", now,
    )

    row = await test_db.fetchrow("SELECT * FROM migration_verify($1)", "verify-node")
    assert row["session_count"] >= 1
    assert row["event_count"] >= 1
    assert row["folder_count"] >= 0
