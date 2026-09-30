CREATE TABLE card_comments (
    id TEXT PRIMARY KEY,
    card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    author_kind TEXT NOT NULL CHECK (author_kind IN ('user','agent')),
    author_id TEXT,
    session_id TEXT REFERENCES sessions(session_id) ON DELETE SET NULL,
    kind TEXT NOT NULL DEFAULT 'comment' CHECK (kind IN ('comment','spoken')),
    body TEXT NOT NULL,
    delivered_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_card_comments_card ON card_comments(card_id, created_at);
