CREATE TABLE IF NOT EXISTS session_statistics_facts (
    session_id TEXT NOT NULL,
    event_id BIGINT NOT NULL,
    part_key TEXT NOT NULL,
    fact_kind TEXT NOT NULL CHECK (fact_kind IN ('usage', 'input_material', 'tool_call', 'boundary')),
    recorded_at TIMESTAMPTZ NOT NULL,
    source_event_type TEXT NOT NULL,
    normalization_version INTEGER NOT NULL CHECK (normalization_version > 0),
    accounting_key TEXT,
    input_id TEXT,
    candidate_type TEXT,
    provider TEXT NOT NULL,
    backend TEXT,
    model TEXT,
    usage_snapshot JSONB,
    quality JSONB NOT NULL DEFAULT '[]'::JSONB CHECK (jsonb_typeof(quality) = 'array'),
    representation TEXT,
    input_total BIGINT,
    output_total BIGINT,
    total_tokens BIGINT,
    cache_read BIGINT,
    cache_write BIGINT,
    reasoning_output BIGINT,
    known_cost_usd NUMERIC,
    priced_tokens BIGINT,
    unpriced_tokens BIGINT,
    pricing_complete BOOLEAN,
    pricing_version TEXT,
    raw_numeric JSONB,
    category TEXT,
    source_key TEXT,
    estimate_source TEXT,
    raw_chars_utf16 BIGINT,
    approximate_tokens BIGINT,
    boundary_type TEXT,
    PRIMARY KEY (session_id, event_id, part_key),
    FOREIGN KEY (session_id, event_id)
        REFERENCES events(session_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_session_statistics_facts_usage_key
    ON session_statistics_facts (session_id, accounting_key, event_id)
    WHERE fact_kind = 'usage';
CREATE INDEX IF NOT EXISTS idx_session_statistics_facts_boundary
    ON session_statistics_facts (session_id, event_id)
    WHERE fact_kind = 'boundary';
CREATE INDEX IF NOT EXISTS idx_session_statistics_facts_kind_recorded
    ON session_statistics_facts (recorded_at, session_id);

INSERT INTO system_settings (setting_key, value, version, updated_by)
VALUES (
    'session_statistics_projection_v1',
    '{"state":"backfilling","normalization_version":1,"covered_since":null,"backfill_cutoff_event_id":null,"last_session_id":null,"last_event_id":null}'::JSONB,
    1,
    'migration:125_session_statistics_facts'
)
ON CONFLICT (setting_key) DO NOTHING;
