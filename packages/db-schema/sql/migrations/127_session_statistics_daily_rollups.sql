CREATE TABLE IF NOT EXISTS session_statistics_daily_batches (
    day DATE NOT NULL,
    aggregation_version INTEGER NOT NULL CHECK (aggregation_version > 0),
    computed_at TIMESTAMPTZ NOT NULL,
    source_max_event_id BIGINT NOT NULL CHECK (source_max_event_id >= 0),
    ready BOOLEAN NOT NULL,
    PRIMARY KEY (day, aggregation_version)
);

CREATE TABLE IF NOT EXISTS session_statistics_daily_sessions (
    day DATE NOT NULL,
    aggregation_version INTEGER NOT NULL,
    session_id TEXT NOT NULL,
    payload JSONB NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
    PRIMARY KEY (day, aggregation_version, session_id),
    FOREIGN KEY (day, aggregation_version)
        REFERENCES session_statistics_daily_batches(day, aggregation_version) ON DELETE CASCADE
);
