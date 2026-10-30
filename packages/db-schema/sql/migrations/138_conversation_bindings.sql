CREATE TABLE IF NOT EXISTS conversation_bindings (
    account_id TEXT NOT NULL,
    namespace TEXT NOT NULL,
    external_key TEXT NOT NULL,
    session_id TEXT NOT NULL UNIQUE,
    selected_model TEXT NOT NULL,
    creation_request JSONB,
    phase TEXT NOT NULL,
    instruction_id TEXT,
    notices JSONB NOT NULL DEFAULT '[]'::jsonb,
    archived BOOLEAN NOT NULL DEFAULT FALSE,
    PRIMARY KEY (account_id, namespace, external_key)
);
