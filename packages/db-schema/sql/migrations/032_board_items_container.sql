ALTER TABLE board_items ADD COLUMN IF NOT EXISTS container_kind TEXT NOT NULL DEFAULT 'folder';
ALTER TABLE board_items ADD COLUMN IF NOT EXISTS container_id TEXT;
ALTER TABLE board_items ADD COLUMN IF NOT EXISTS membership_kind TEXT NOT NULL DEFAULT 'primary';
ALTER TABLE board_items ADD COLUMN IF NOT EXISTS source_runbook_item_id TEXT;

UPDATE board_items SET container_kind = 'folder' WHERE container_kind IS NULL;
UPDATE board_items SET container_id = folder_id WHERE container_id IS NULL;
UPDATE board_items SET membership_kind = 'primary' WHERE membership_kind IS NULL;

ALTER TABLE board_items ALTER COLUMN container_kind SET NOT NULL;
ALTER TABLE board_items ALTER COLUMN container_id SET NOT NULL;
ALTER TABLE board_items ALTER COLUMN membership_kind SET NOT NULL;

ALTER TABLE board_items DROP CONSTRAINT IF EXISTS board_items_container_kind_check;
ALTER TABLE board_items ADD CONSTRAINT board_items_container_kind_check
    CHECK (container_kind IN ('folder','runbook'));

ALTER TABLE board_items DROP CONSTRAINT IF EXISTS board_items_membership_kind_check;
ALTER TABLE board_items ADD CONSTRAINT board_items_membership_kind_check
    CHECK (membership_kind IN ('primary','reference'));

ALTER TABLE board_items DROP CONSTRAINT IF EXISTS board_items_folder_id_item_id_key;
ALTER TABLE board_items DROP CONSTRAINT IF EXISTS uq_board_items_container_item;
ALTER TABLE board_items ADD CONSTRAINT uq_board_items_container_item
    UNIQUE (container_kind, container_id, item_id);

CREATE OR REPLACE FUNCTION board_items_fill_container_defaults()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.container_id IS NULL THEN
        NEW.container_kind := 'folder';
        NEW.container_id := NEW.folder_id;
    END IF;
    IF NEW.container_kind IS NULL THEN
        NEW.container_kind := 'folder';
    END IF;
    IF NEW.membership_kind IS NULL THEN
        NEW.membership_kind := 'primary';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_board_items_fill_container_defaults ON board_items;
CREATE TRIGGER trg_board_items_fill_container_defaults
    BEFORE INSERT ON board_items
    FOR EACH ROW EXECUTE FUNCTION board_items_fill_container_defaults();

CREATE INDEX IF NOT EXISTS idx_board_items_container
    ON board_items (container_kind, container_id, y, x);

CREATE UNIQUE INDEX IF NOT EXISTS uq_board_items_primary_membership
    ON board_items (item_type, item_id)
    WHERE membership_kind = 'primary';

ALTER TABLE board_items DROP CONSTRAINT IF EXISTS board_items_source_runbook_item_id_fkey;
ALTER TABLE board_items ADD CONSTRAINT board_items_source_runbook_item_id_fkey
    FOREIGN KEY (source_runbook_item_id) REFERENCES runbook_items(id) ON DELETE SET NULL;
