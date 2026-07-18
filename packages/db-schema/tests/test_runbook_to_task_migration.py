"""Isolated PostgreSQL proof for the 041 -> 042 migration sequence."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest


pytestmark = pytest.mark.asyncio

PACKAGE_DIR = Path(__file__).resolve().parents[1]
SCRIPTS_DIR = PACKAGE_DIR / "scripts"
sys.path.insert(0, str(SCRIPTS_DIR))

from verify_runbook_to_task_migration import (  # noqa: E402
    collect_snapshot,
    compare_snapshots,
)


def _migration_sql(name: str) -> str:
    return (PACKAGE_DIR / "sql" / "migrations" / name).read_text(encoding="utf-8")


async def _seed_canonical_work(test_db) -> None:
    await test_db.execute(
        "INSERT INTO folders (id, name) VALUES ('folder-work', '📋 업무')"
    )
    await test_db.execute(
        """
        INSERT INTO sessions (session_id, folder_id, node_id, session_type, status)
        VALUES ('session-work', 'folder-work', 'node-test', 'agent', 'idle')
        """
    )
    await test_db.execute(
        """
        INSERT INTO pages (id, title)
        VALUES ('page-work', '업무 본문'), ('page-blocks', '업무 참조')
        """
    )
    await test_db.execute(
        """
        INSERT INTO board_items (
          id, folder_id, container_kind, container_id, item_type, item_id, x, y
        ) VALUES (
          'runbook:opaque-id', 'folder-work', 'folder', 'folder-work',
          'task', 'work-1', 12.5, 24.5
        )
        """
    )
    await test_db.execute(
        """
        INSERT INTO tasks (
          id, board_item_id, title, status, archived, created_session_id,
          task_page_id
        ) VALUES (
          'work-1', 'runbook:opaque-id', '이름을 바꿔도 보존', 'open', FALSE,
          'session-work', 'page-work'
        )
        """
    )
    await test_db.execute(
        """
        INSERT INTO task_sections (
          id, task_id, position_key, title, assignee_kind, assignee_session_id
        ) VALUES ('section-1', 'work-1', 'a0', '구현', 'session', 'session-work')
        """
    )
    await test_db.execute(
        """
        INSERT INTO task_items (
          id, section_id, position_key, title, how_to, assignee_kind,
          assignee_session_id, status
        ) VALUES (
          'item-1', 'section-1', 'a0', '연결 보존', '사용자 내용 runbook은 그대로',
          'session', 'session-work', 'in_progress'
        )
        """
    )
    await test_db.execute(
        """
        INSERT INTO task_operations (
          id, task_id, target_kind, target_id, operation_type, actor_kind,
          actor_session_id, idempotency_key, payload_json
        ) VALUES (
          'operation-1', 'work-1', 'task', 'work-1', 'task_updated', 'agent',
          'session-work', 'idem-1', '{"title":"runbook user text"}'::jsonb
        )
        """
    )
    await test_db.execute(
        """
        INSERT INTO markdown_documents (id, title, body)
        VALUES ('document-1', '분석 캐시', '연결된 문서 본문')
        """
    )
    await test_db.execute(
        """
        INSERT INTO file_assets (
          id, storage_key, original_name, mime_type, byte_size, upload_status
        ) VALUES ('asset-1', 'task/asset-1', '증거.txt', 'text/plain', 4, 'committed')
        """
    )
    await test_db.executemany(
        """
        INSERT INTO board_items (
          id, folder_id, container_kind, container_id, membership_kind,
          source_task_item_id, item_type, item_id, x, y
        ) VALUES ($1, 'folder-work', 'task', 'work-1', $2, 'item-1', $3, $4, $5, 1)
        """,
        [
            ("membership-document", "primary", "markdown", "document-1", 1),
            ("membership-asset", "reference", "asset", "asset-1", 2),
            ("membership-session", "primary", "session", "session-work", 3),
        ],
    )
    await test_db.execute(
        """
        INSERT INTO blocks (id, page_id, position_key, block_type, properties)
        VALUES (
          'block-ref', 'page-blocks', 'a0', 'task_ref',
          '{"taskId":"work-1","label":"user runbook text"}'::jsonb
        )
        """
    )
    await test_db.execute(
        """
        INSERT INTO session_page_bindings (
          session_id, node_id, daily_date, session_type, legacy_folder_id,
          legacy_container_kind, legacy_container_id, source_task_item_id
        ) VALUES (
          'session-work', 'node-test', DATE '2026-07-18', 'agent', 'folder-work',
          'task', 'work-1', 'item-1'
        )
        """
    )
    await test_db.execute(
        """
        INSERT INTO board_yjs_catalog_cache (
          folder_id, container_kind, container_id, board_items, markdown_documents
        ) VALUES (
          'folder-work', 'task', 'work-1',
          '[{"id":"membership-document","itemType":"task","containerKind":"task",'
          '"sourceTaskItemId":"item-1","taskId":"work-1"}]'::jsonb,
          '[{"id":"document-1"}]'::jsonb
        )
        """
    )
    await test_db.execute(
        """
        INSERT INTO checklist_task_projection_outbox (
          block_id, page_id, source_hash, actor_kind
        ) VALUES ('block-ref', 'page-blocks', 'source-hash', 'system')
        """
    )


async def _restore_legacy_vocabulary(test_db) -> None:
    """Turn the fresh canonical fixture into the exact pre-042 shape."""

    await test_db.execute(
        """
        DROP VIEW runbook_operations;
        DROP VIEW runbook_items;
        DROP VIEW runbook_sections;
        DROP VIEW runbooks;

        ALTER TABLE board_items DROP CONSTRAINT board_items_item_type_check;
        ALTER TABLE board_items DROP CONSTRAINT board_items_container_kind_check;
        ALTER TABLE board_yjs_catalog_cache
          DROP CONSTRAINT board_yjs_catalog_cache_container_kind_check;
        ALTER TABLE session_page_bindings
          DROP CONSTRAINT session_page_bindings_container_kind_check;
        ALTER TABLE task_operations DROP CONSTRAINT task_operations_target_kind_check;

        UPDATE board_items SET item_type = 'runbook' WHERE item_type = 'task';
        UPDATE board_items SET container_kind = 'runbook' WHERE container_kind = 'task';
        UPDATE board_yjs_catalog_cache SET container_kind = 'runbook'
          WHERE container_kind = 'task';
        UPDATE board_yjs_catalog_cache
        SET board_items = replace(
          replace(
            replace(
              replace(board_items::text, 'sourceTaskItemId', 'sourceRunbookItemId'),
              'taskId', 'runbookId'
            ),
            '"itemType": "task"', '"itemType": "runbook"'
          ),
          '"containerKind": "task"', '"containerKind": "runbook"'
        )::jsonb;
        UPDATE session_page_bindings SET legacy_container_kind = 'runbook'
          WHERE legacy_container_kind = 'task';
        UPDATE task_operations
        SET target_kind = replace(target_kind, 'task', 'runbook'),
            operation_type = replace(operation_type, 'task', 'runbook');
        UPDATE blocks
        SET block_type = 'runbook_ref',
            properties = (properties - 'taskId')
              || jsonb_build_object('runbookId', properties -> 'taskId')
        WHERE block_type = 'task_ref';
        UPDATE folders SET name = '📒 런북' WHERE name = '📋 업무';

        ALTER TABLE board_items
          RENAME COLUMN source_task_item_id TO source_runbook_item_id;
        ALTER TABLE session_page_bindings
          RENAME COLUMN source_task_item_id TO source_runbook_item_id;
        ALTER TABLE task_sections RENAME COLUMN task_id TO runbook_id;
        ALTER TABLE task_operations RENAME COLUMN task_id TO runbook_id;

        ALTER TABLE checklist_task_projection_outbox
          RENAME TO checklist_runbook_projection_outbox;
        ALTER TABLE task_operations RENAME TO runbook_operations;
        ALTER TABLE task_items RENAME TO runbook_items;
        ALTER TABLE task_sections RENAME TO runbook_sections;
        ALTER TABLE tasks RENAME TO runbooks;

        ALTER TABLE board_items ADD CONSTRAINT board_items_item_type_check
          CHECK (item_type IN ('session','markdown','subfolder','asset','frame','runbook','custom_view'));
        ALTER TABLE board_items ADD CONSTRAINT board_items_container_kind_check
          CHECK (container_kind IN ('folder','runbook'));
        ALTER TABLE board_yjs_catalog_cache
          ADD CONSTRAINT board_yjs_catalog_cache_container_kind_check
          CHECK (container_kind IN ('folder','runbook'));
        ALTER TABLE session_page_bindings
          ADD CONSTRAINT session_page_bindings_container_kind_check
          CHECK (legacy_container_kind IS NULL OR legacy_container_kind IN ('folder','runbook'));
        ALTER TABLE runbook_operations ADD CONSTRAINT runbook_operations_target_kind_check
          CHECK (target_kind IN ('runbook','section','item'));

        CREATE TABLE task_items (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL
        );
        INSERT INTO task_items (id, title) VALUES ('retired-v1-row', 'external backup only');
        """
    )


async def test_042_requires_041_and_preserves_every_link(test_db) -> None:
    await _seed_canonical_work(test_db)
    await _restore_legacy_vocabulary(test_db)
    before = await collect_snapshot(test_db)

    with pytest.raises(Exception, match="041_retire_task_tree.sql must run before"):
        await test_db.execute(_migration_sql("042_runbook_to_task.sql"))

    await test_db.execute(_migration_sql("041_retire_task_tree.sql"))
    await test_db.execute(_migration_sql("042_runbook_to_task.sql"))
    after = await collect_snapshot(test_db)
    report = compare_snapshots(before, after)

    assert report["status"] == "ok"
    assert report["summary"]["counts"] == {
        "assets": 1,
        "bindings": 1,
        "blocks": 1,
        "board_items": 4,
        "catalog_cache": 1,
        "documents": 1,
        "folders": 1,
        "items": 1,
        "operations": 1,
        "outbox": 1,
        "pages": 1,
        "sections": 1,
        "session_links": 1,
        "work": 1,
    }
    assert await test_db.fetchval(
        "SELECT board_item_id FROM tasks WHERE id = 'work-1'"
    ) == "runbook:opaque-id"
    assert await test_db.fetchval(
        "SELECT item_type FROM board_items WHERE id = 'runbook:opaque-id'"
    ) == "task"
    assert await test_db.fetchval(
        "SELECT COUNT(*) FROM runbooks WHERE id = 'work-1'"
    ) == 1
    with pytest.raises(Exception):
        await test_db.execute(
            "UPDATE runbooks SET title = 'compat must be read-only' WHERE id = 'work-1'"
        )

    await test_db.execute(_migration_sql("042_runbook_to_task.sql"))
    assert compare_snapshots(after, await collect_snapshot(test_db))["status"] == "ok"
