-- UPDATE blocks SET block_type = 'comment';
/* DELETE FROM pages; /* nested UPDATE blocks; */ */
CREATE TABLE blocks (
    id UUID PRIMARY KEY
);
ALTER TABLE pages ADD COLUMN IF NOT EXISTS archived BOOLEAN NOT NULL DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS idx_blocks_page_id ON blocks (page_id);
SELECT * FROM pages;
SELECT 'DELETE FROM blocks WHERE id = 1';

CREATE OR REPLACE FUNCTION refresh_block_projection()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
    UPDATE blocks SET updated_at = NOW() WHERE id = NEW.id;
    RETURN NEW;
END;
$function$;
