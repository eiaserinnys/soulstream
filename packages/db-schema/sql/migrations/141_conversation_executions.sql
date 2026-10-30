ALTER TABLE conversation_bindings ADD COLUMN IF NOT EXISTS active_session_id TEXT;
UPDATE conversation_bindings SET active_session_id = session_id WHERE active_session_id IS NULL;

CREATE TABLE IF NOT EXISTS conversation_executions (
  thread_id TEXT NOT NULL REFERENCES conversation_bindings(session_id) ON DELETE CASCADE,
  session_id TEXT NOT NULL UNIQUE,
  predecessor_session_id TEXT,
  ordinal INTEGER NOT NULL,
  first_input_is_initial_instruction BOOLEAN NOT NULL DEFAULT FALSE,
  notice TEXT,
  request JSONB,
  selected_model TEXT,
  phase TEXT NOT NULL DEFAULT 'complete',
  instruction_id TEXT,
  notices JSONB NOT NULL DEFAULT '[]'::jsonb,
  release_pending BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (thread_id, ordinal)
);
INSERT INTO conversation_executions(thread_id, session_id, ordinal, first_input_is_initial_instruction)
SELECT session_id, session_id, 0,
  first_input_is_initial_instruction OR COALESCE(length(creation_request->>'initial_instruction') > 0, false)
FROM conversation_bindings
ON CONFLICT DO NOTHING;

ALTER TABLE conversation_message_receipts ADD COLUMN IF NOT EXISTS target_session_id TEXT;
UPDATE conversation_message_receipts SET target_session_id = session_id WHERE target_session_id IS NULL;
