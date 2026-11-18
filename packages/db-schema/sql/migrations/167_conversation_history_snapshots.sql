-- Persist conversation history projections so a cold load only reads new events.
CREATE TABLE IF NOT EXISTS conversation_history_snapshots (
    session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
    first_input_is_initial_instruction BOOLEAN NOT NULL,
    projection_version INTEGER NOT NULL CHECK (projection_version > 0),
    last_event_id INTEGER NOT NULL CHECK (last_event_id >= 0),
    state JSONB NOT NULL CHECK (jsonb_typeof(state) = 'object'),
    items JSONB NOT NULL CHECK (jsonb_typeof(items) = 'array'),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (session_id, first_input_is_initial_instruction)
);
