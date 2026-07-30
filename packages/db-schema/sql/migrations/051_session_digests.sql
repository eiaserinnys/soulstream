CREATE TABLE IF NOT EXISTS session_digests (
    session_id                  TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE,
    narrative                   TEXT NOT NULL,
    highlight                   TEXT NOT NULL,
    narrative_through_event_id  INTEGER NOT NULL,
    fold_count                  INTEGER NOT NULL DEFAULT 0,
    version                     INTEGER NOT NULL DEFAULT 1,
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE session_digests ADD COLUMN IF NOT EXISTS narrative TEXT NOT NULL DEFAULT '';
ALTER TABLE session_digests ADD COLUMN IF NOT EXISTS highlight TEXT NOT NULL DEFAULT '';
ALTER TABLE session_digests ADD COLUMN IF NOT EXISTS narrative_through_event_id INTEGER NOT NULL DEFAULT 0;
ALTER TABLE session_digests ADD COLUMN IF NOT EXISTS fold_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE session_digests ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE session_digests ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE session_digests ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
