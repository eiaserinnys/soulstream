-- Cards that are not archived get a permanent serial number shown as #412.
-- Archived cards have no number until they are restored. Numbers are never reused.
-- This file is safe to apply again: the backfill runs only in the application
-- that adds the column, and every other statement is idempotent.
CREATE SEQUENCE IF NOT EXISTS cards_number_seq AS INTEGER;

DO $$
DECLARE
    assigned INTEGER;
    issued INTEGER;
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_attribute
        WHERE attrelid = 'cards'::regclass AND attname = 'number' AND NOT attisdropped
    ) THEN
        ALTER TABLE cards ADD COLUMN number INTEGER;
        UPDATE cards c
        SET number = o.n
        FROM (
            SELECT id, ROW_NUMBER() OVER (ORDER BY created_at, id COLLATE "C") AS n
            FROM cards
            WHERE NOT archived
        ) o
        WHERE c.id = o.id;
        SELECT MAX(number) INTO assigned FROM cards;
        SELECT CASE WHEN is_called THEN last_value ELSE 0 END INTO issued FROM cards_number_seq;
        IF assigned IS NOT NULL AND assigned > issued THEN
            PERFORM setval('cards_number_seq', assigned);
        END IF;
    END IF;
END $$;

ALTER TABLE cards ALTER COLUMN number SET DEFAULT nextval('cards_number_seq');

CREATE UNIQUE INDEX IF NOT EXISTS uq_cards_number ON cards(number);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'cards'::regclass AND conname = 'cards_live_number_check'
    ) THEN
        ALTER TABLE cards
            ADD CONSTRAINT cards_live_number_check
            CHECK (archived OR number IS NOT NULL);
    END IF;
END $$;
