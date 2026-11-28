-- Writers must be quiesced before applying this migration.
-- A verified external PostgreSQL backup must exist before applying it.

DELETE FROM board_yjs_updates WHERE document_name IN (
  SELECT 'page:' || id FROM pages WHERE daily_date IS NOT NULL
);
DELETE FROM board_yjs_documents WHERE name IN (
  SELECT 'page:' || id FROM pages WHERE daily_date IS NOT NULL
);
DELETE FROM pages WHERE daily_date IS NOT NULL;
UPDATE session_page_bindings SET page_state = 'bound'
WHERE target_page_id IS NULL AND page_state <> 'bound';
DROP INDEX IF EXISTS uq_pages_daily_date;
ALTER TABLE pages DROP COLUMN daily_date;
ALTER TABLE session_page_bindings DROP COLUMN daily_date;
