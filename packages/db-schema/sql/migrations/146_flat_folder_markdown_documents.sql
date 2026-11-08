ALTER TABLE markdown_documents
  ADD COLUMN IF NOT EXISTS folder_id TEXT REFERENCES folders(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_markdown_documents_folder_id
  ON markdown_documents(folder_id);

WITH ranked AS (
  SELECT bi.item_id, bi.folder_id,
    row_number() OVER (
      PARTITION BY bi.item_id
      ORDER BY (bi.membership_kind = 'primary') DESC,
        bi.updated_at DESC NULLS LAST,
        bi.created_at DESC NULLS LAST, bi.id ASC
    ) AS rn
  FROM board_items bi
  JOIN folders f ON f.id = bi.folder_id
  WHERE bi.item_type = 'markdown'
)
UPDATE markdown_documents md
SET folder_id = r.folder_id
FROM ranked r
WHERE md.id = r.item_id AND r.rn = 1 AND md.folder_id IS NULL;

DROP TRIGGER IF EXISTS board_assert_session_ydoc_refs_removed_trigger ON sessions;
DROP FUNCTION IF EXISTS board_assert_session_ydoc_refs_removed();

CREATE OR REPLACE FUNCTION flat_markdown_sync_legacy_membership()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  affected_ids TEXT[] := ARRAY[]::TEXT[];
  document_id TEXT;
  selected_folder TEXT;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    IF OLD.item_type = 'markdown' THEN
      affected_ids := array_append(affected_ids, OLD.item_id);
    END IF;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    IF NEW.item_type = 'markdown' THEN
      affected_ids := array_append(affected_ids, NEW.item_id);
    END IF;
  END IF;
  FOR document_id IN SELECT DISTINCT unnest(affected_ids)
  LOOP
    IF TG_OP = 'DELETE' THEN
      IF NOT EXISTS (SELECT 1 FROM folders WHERE id = OLD.folder_id) THEN
        CONTINUE;
      END IF;
    END IF;
    SELECT bi.folder_id INTO selected_folder
    FROM board_items bi JOIN folders f ON f.id = bi.folder_id
    WHERE bi.item_type = 'markdown' AND bi.item_id = document_id
    ORDER BY (bi.membership_kind = 'primary') DESC,
      bi.updated_at DESC NULLS LAST,
      bi.created_at DESC NULLS LAST, bi.id ASC
    LIMIT 1;
    UPDATE markdown_documents
    SET folder_id = selected_folder
    WHERE id = document_id AND folder_id IS DISTINCT FROM selected_folder;
  END LOOP;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS flat_markdown_sync_legacy_membership_trigger ON board_items;
CREATE TRIGGER flat_markdown_sync_legacy_membership_trigger
AFTER INSERT OR UPDATE OR DELETE ON board_items
FOR EACH ROW EXECUTE FUNCTION flat_markdown_sync_legacy_membership();

CREATE OR REPLACE FUNCTION flat_markdown_fill_folder_on_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.folder_id IS NULL THEN
    SELECT bi.folder_id INTO NEW.folder_id
    FROM board_items bi
    JOIN folders f ON f.id = bi.folder_id
    WHERE bi.item_type = 'markdown' AND bi.item_id = NEW.id
    ORDER BY (bi.membership_kind = 'primary') DESC,
      bi.updated_at DESC NULLS LAST,
      bi.created_at DESC NULLS LAST,
      bi.id ASC
    LIMIT 1;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS flat_markdown_fill_folder_on_insert_trigger ON markdown_documents;
CREATE TRIGGER flat_markdown_fill_folder_on_insert_trigger
BEFORE INSERT ON markdown_documents
FOR EACH ROW EXECUTE FUNCTION flat_markdown_fill_folder_on_insert();
