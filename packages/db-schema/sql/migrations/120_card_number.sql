-- 120: every card gets a permanent serial number shown as #412.
-- Existing cards are numbered in creation order. Numbers are never reused.
ALTER TABLE cards ADD COLUMN IF NOT EXISTS number INTEGER;

UPDATE cards c
SET number = o.n
FROM (
    SELECT id, ROW_NUMBER() OVER (ORDER BY created_at, id COLLATE "C") AS n
    FROM cards
) o
WHERE c.id = o.id AND c.number IS NULL;

ALTER TABLE cards ALTER COLUMN number SET NOT NULL;

DO $$
DECLARE next_number INTEGER;
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_attribute
        WHERE attrelid = 'cards'::regclass AND attname = 'number' AND attidentity <> ''
    ) THEN
        SELECT COALESCE(MAX(number), 0) + 1 INTO next_number FROM cards;
        EXECUTE format(
            'ALTER TABLE cards ALTER COLUMN number ADD GENERATED ALWAYS AS IDENTITY (START WITH %s)',
            next_number
        );
    END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_cards_number ON cards(number);
