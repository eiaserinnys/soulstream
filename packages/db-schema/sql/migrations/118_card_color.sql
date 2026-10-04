ALTER TABLE cards ADD COLUMN IF NOT EXISTS color TEXT;

UPDATE cards
SET color = (ARRAY['yellow','pink','mint','blue','lavender']::TEXT[])[floor(random() * 5)::INTEGER + 1]
WHERE color IS NULL;

ALTER TABLE cards
    ALTER COLUMN color SET DEFAULT ((ARRAY['yellow','pink','mint','blue','lavender']::TEXT[])[floor(random() * 5)::INTEGER + 1]);

ALTER TABLE cards
    ALTER COLUMN color SET NOT NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'cards'::regclass AND conname = 'cards_color_check'
    ) THEN
        ALTER TABLE cards
            ADD CONSTRAINT cards_color_check
            CHECK (color IN ('yellow','pink','mint','blue','lavender'));
    END IF;
END $$;
