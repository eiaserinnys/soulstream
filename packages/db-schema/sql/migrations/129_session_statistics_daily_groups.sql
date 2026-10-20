ALTER TABLE session_statistics_daily_sessions
    ADD COLUMN IF NOT EXISTS folder_id TEXT,
    ADD COLUMN IF NOT EXISTS card_folder_id TEXT;

CREATE TABLE IF NOT EXISTS session_statistics_daily_groups (
    day DATE NOT NULL,
    aggregation_version INTEGER NOT NULL,
    group_key TEXT NOT NULL,
    folder_id TEXT,
    card_folder_id TEXT,
    payload JSONB NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
    PRIMARY KEY (day, aggregation_version, group_key),
    FOREIGN KEY (day, aggregation_version)
        REFERENCES session_statistics_daily_batches(day, aggregation_version) ON DELETE CASCADE
);
