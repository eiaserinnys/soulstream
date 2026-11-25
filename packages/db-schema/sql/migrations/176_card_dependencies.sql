CREATE TABLE IF NOT EXISTS card_dependencies (
    card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    depends_on_card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (card_id, depends_on_card_id),
    CONSTRAINT card_dependencies_no_self CHECK (card_id <> depends_on_card_id)
);
CREATE INDEX IF NOT EXISTS idx_card_dependencies_on ON card_dependencies(depends_on_card_id);
