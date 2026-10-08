ALTER TABLE cards
    ADD COLUMN IF NOT EXISTS report_target_session_id TEXT REFERENCES sessions(session_id) ON DELETE SET NULL;
