-- Writers must be quiesced before applying this migration.
-- A verified external PostgreSQL backup must exist before applying it.
-- Keep daily pages used as folder documents and their Yjs data so folder contents remain accessible.

DELETE FROM board_yjs_updates WHERE document_name IN (
  SELECT 'page:' || p.id FROM pages p
  WHERE p.daily_date IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM folders f WHERE f.project_page_id = p.id)
);
DELETE FROM board_yjs_documents WHERE name IN (
  SELECT 'page:' || p.id FROM pages p
  WHERE p.daily_date IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM folders f WHERE f.project_page_id = p.id)
);
DELETE FROM pages p WHERE p.daily_date IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM folders f WHERE f.project_page_id = p.id);
UPDATE session_page_bindings SET page_state = 'bound'
WHERE target_page_id IS NULL AND page_state <> 'bound';
DROP INDEX IF EXISTS uq_pages_daily_date;
ALTER TABLE pages DROP COLUMN daily_date;
ALTER TABLE session_page_bindings DROP COLUMN daily_date;
