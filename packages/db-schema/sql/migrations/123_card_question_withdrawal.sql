ALTER TABLE card_questions
    ADD COLUMN IF NOT EXISTS withdrawn_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS withdrawn_by_session_id TEXT,
    ADD COLUMN IF NOT EXISTS withdrawal_reason TEXT;
