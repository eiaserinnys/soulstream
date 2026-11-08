from pathlib import Path

import pytest


pytestmark = pytest.mark.asyncio


async def test_legacy_membership_write_orders_and_folder_cascade(test_db):
    await test_db.execute("INSERT INTO folders (id, name) VALUES ('flat-a', 'A'), ('flat-b', 'B')")
    await test_db.execute("""
        INSERT INTO board_items (id, folder_id, item_type, item_id)
        VALUES ('legacy-first', 'flat-a', 'markdown', 'doc-item-first')
    """)
    await test_db.execute("INSERT INTO markdown_documents (id, title) VALUES ('doc-item-first', 'Item first')")
    assert await test_db.fetchval("SELECT folder_id FROM markdown_documents WHERE id = 'doc-item-first'") == 'flat-a'

    await test_db.execute("INSERT INTO markdown_documents (id, title) VALUES ('doc-document-first', 'Document first')")
    await test_db.execute("""
        INSERT INTO board_items (id, folder_id, item_type, item_id)
        VALUES ('document-first', 'flat-a', 'markdown', 'doc-document-first')
    """)
    assert await test_db.fetchval("SELECT folder_id FROM markdown_documents WHERE id = 'doc-document-first'") == 'flat-a'

    await test_db.execute("UPDATE board_items SET folder_id = 'flat-b' WHERE id = 'legacy-first'")
    assert await test_db.fetchval("SELECT folder_id FROM markdown_documents WHERE id = 'doc-item-first'") == 'flat-b'
    await test_db.execute("DELETE FROM folders WHERE id = 'flat-b'")
    assert await test_db.fetchval("SELECT count(*) FROM markdown_documents WHERE id = 'doc-item-first'") == 0

    await test_db.execute("DELETE FROM board_items WHERE id = 'document-first'")
    assert await test_db.fetchval("SELECT folder_id FROM markdown_documents WHERE id = 'doc-document-first'") is None


async def test_migration_backfills_existing_documents_and_removes_session_assertion(test_db):
    await test_db.execute("""
        DROP TRIGGER flat_markdown_sync_legacy_membership_trigger ON board_items;
        DROP TRIGGER flat_markdown_fill_folder_on_insert_trigger ON markdown_documents;
        ALTER TABLE markdown_documents DROP COLUMN folder_id;
        CREATE FUNCTION board_assert_session_ydoc_refs_removed() RETURNS trigger LANGUAGE plpgsql
        AS $$ BEGIN RETURN NEW; END $$;
        CREATE TRIGGER board_assert_session_ydoc_refs_removed_trigger
        BEFORE DELETE ON sessions FOR EACH ROW EXECUTE FUNCTION board_assert_session_ydoc_refs_removed();
        INSERT INTO folders (id, name) VALUES ('old-primary', 'Primary'), ('old-reference', 'Reference');
        INSERT INTO markdown_documents (id, title) VALUES ('existing-doc', 'Existing');
        INSERT INTO board_items (id, folder_id, membership_kind, item_type, item_id, updated_at)
        VALUES ('old-primary-item', 'old-primary', 'primary', 'markdown', 'existing-doc', '2025-01-01'),
               ('old-reference-item', 'old-reference', 'reference', 'markdown', 'existing-doc', '2026-01-01');
    """)
    migration = Path(__file__).parents[1] / "sql/migrations/146_flat_folder_markdown_documents.sql"
    await test_db.execute(migration.read_text(encoding="utf-8"))
    assert await test_db.fetchval("SELECT folder_id FROM markdown_documents WHERE id = 'existing-doc'") == 'old-primary'
    assert await test_db.fetchval("SELECT count(*) FROM pg_trigger WHERE tgname = 'board_assert_session_ydoc_refs_removed_trigger' AND NOT tgisinternal") == 0
