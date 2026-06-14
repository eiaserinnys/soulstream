-- Account-scoped dashboard appearance and wallpaper preferences (orch-server).

CREATE TABLE IF NOT EXISTS user_preferences (
    email TEXT PRIMARY KEY REFERENCES users(email) ON DELETE CASCADE,
    prefs JSONB NOT NULL DEFAULT '{}'::JSONB,
    background_blob BYTEA,
    background_mime TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS prefs JSONB NOT NULL DEFAULT '{}'::JSONB;
ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS background_blob BYTEA;
ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS background_mime TEXT;
ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
