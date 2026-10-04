CREATE TABLE IF NOT EXISTS card_execution_requests (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  keys JSONB NOT NULL,
  card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('create','resume','observe')),
  target JSONB NOT NULL,
  previous_status TEXT NOT NULL,
  baseline_event_id BIGINT NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','succeeded','failed')),
  sent BOOLEAN NOT NULL DEFAULT FALSE,
  result_state TEXT,
  execution JSONB,
  error TEXT,
  actor_user_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_card_execution_pending ON card_execution_requests(card_id) WHERE state='pending';
