from pathlib import Path

import pytest


@pytest.mark.asyncio
async def test_retiring_daily_pages_preserves_general_pages_and_anchors(test_db):
    await test_db.execute("""
        ALTER TABLE pages ADD COLUMN IF NOT EXISTS daily_date DATE;
        ALTER TABLE session_page_bindings ADD COLUMN IF NOT EXISTS daily_date DATE;
        INSERT INTO sessions (session_id) VALUES ('anchor-session'), ('unanchored-session');
        INSERT INTO pages (id, title, daily_date) VALUES
          ('daily', 'Daily', '2026-11-28'), ('general', 'General', NULL);
        INSERT INTO blocks (id, page_id, position_key) VALUES
          ('daily-block', 'daily', 'a'), ('general-block', 'general', 'a');
        INSERT INTO block_links (id, source_block_id, link_kind, ordinal, source_start, source_end,
                                 target_page_id, target_title, target_title_key)
          VALUES ('link', 'general-block', 'inline_page', 0, 0, 1, 'daily', 'Daily', 'daily');
        INSERT INTO board_yjs_documents (name, snapshot) VALUES
          ('page:daily', '\\x00'), ('page:general', '\\x00');
        INSERT INTO board_yjs_updates (document_name, update) VALUES
          ('page:daily', '\\x00'), ('page:general', '\\x00');
        INSERT INTO session_page_bindings (session_id, node_id, daily_date, session_type,
          target_page_id, target_block_id, target_expected_version, page_state, legacy_state)
        VALUES ('anchor-session', 'node', '2026-11-28', 'agent', 'general', 'general-block', 1, 'pending', 'pending'),
          ('unanchored-session', 'node', '2026-11-28', 'agent', NULL, NULL, NULL, 'pending', 'pending');
    """)
    migration = Path(__file__).parents[1] / "sql/migrations/177_retire_daily_pages.sql"
    await test_db.execute(migration.read_text(encoding="utf-8"))
    assert [r["id"] for r in await test_db.fetch("SELECT id FROM pages")] == ["general"]
    assert [r["id"] for r in await test_db.fetch("SELECT id FROM blocks")] == ["general-block"]
    assert [r["name"] for r in await test_db.fetch("SELECT name FROM board_yjs_documents")] == ["page:general"]
    assert [r["document_name"] for r in await test_db.fetch("SELECT document_name FROM board_yjs_updates")] == ["page:general"]
    assert await test_db.fetchval("SELECT target_page_id FROM block_links WHERE id = 'link'") is None
    assert await test_db.fetchval("SELECT target_page_id FROM session_page_bindings WHERE session_id = 'anchor-session'") == 'general'
    assert await test_db.fetchval("SELECT page_state FROM session_page_bindings WHERE session_id = 'unanchored-session'") == 'bound'
    assert await test_db.fetchval("""SELECT count(*) FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name IN ('pages', 'session_page_bindings')
        AND column_name = 'daily_date'""") == 0
