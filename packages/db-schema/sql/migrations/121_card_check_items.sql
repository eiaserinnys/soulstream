ALTER TABLE cards
    ADD COLUMN IF NOT EXISTS items JSONB NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN IF NOT EXISTS now JSONB;

ALTER TABLE card_comments
    ADD COLUMN IF NOT EXISTS item_id INTEGER;

ALTER TABLE card_comments
    DROP CONSTRAINT IF EXISTS card_comments_kind_check;

ALTER TABLE card_comments
    ADD CONSTRAINT card_comments_kind_check
    CHECK (kind IN ('comment', 'spoken', 'note'));
