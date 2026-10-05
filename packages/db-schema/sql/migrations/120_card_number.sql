-- 120: every card gets a permanent serial number shown as #412.
-- Existing cards are numbered in creation order. Numbers are never reused.
-- The backfill runs only before the column becomes an identity column, so
-- this file can be applied again (schema.sql is re-applied on every start).
ALTER TABLE cards ADD COLUMN IF NOT EXISTS number INTEGER;

DO $$
DECLARE next_number INTEGER;
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_attribute
        WHERE attrelid = 'cards'::regclass AND attname = 'number' AND attidentity <> ''
    ) THEN
        EXECUTE $backfill$
            UPDATE cards c
            SET number = o.n
            FROM (
                SELECT id, ROW_NUMBER() OVER (ORDER BY created_at, id COLLATE "C") AS n
                FROM cards
            ) o
            WHERE c.id = o.id AND c.number IS NULL
        $backfill$;
        ALTER TABLE cards ALTER COLUMN number SET NOT NULL;
        SELECT COALESCE(MAX(number), 0) + 1 INTO next_number FROM cards;
        EXECUTE format(
            'ALTER TABLE cards ALTER COLUMN number ADD GENERATED ALWAYS AS IDENTITY (START WITH %s)',
            next_number
        );
    END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_cards_number ON cards(number);
