CREATE TABLE IF NOT EXISTS conversation_message_receipts (
    session_id TEXT NOT NULL REFERENCES conversation_bindings(session_id) ON DELETE CASCADE,
    request_id TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    delivery_id TEXT NOT NULL UNIQUE,
    caller_info JSONB NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'failed')),
    uploads JSONB NOT NULL DEFAULT '[]'::jsonb,
    error JSONB,
    PRIMARY KEY (session_id, request_id)
);
