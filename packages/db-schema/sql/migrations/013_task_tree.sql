-- Migration 013: explicit Task Tree state and append-only operation log

CREATE TABLE IF NOT EXISTS task_items (
    id                    TEXT PRIMARY KEY,
    parent_id             TEXT REFERENCES task_items(id) ON DELETE SET NULL,
    position_key          DOUBLE PRECISION NOT NULL DEFAULT 0,
    title                 TEXT NOT NULL,
    description           TEXT NOT NULL DEFAULT '',
    acceptance_criteria   TEXT NOT NULL DEFAULT '',
    verification_owner    TEXT NOT NULL DEFAULT 'agent',
    status                TEXT NOT NULL DEFAULT 'open',
    linked_session_id     TEXT REFERENCES sessions(session_id) ON DELETE SET NULL,
    linked_node_id        TEXT,
    active_for_session_id TEXT REFERENCES sessions(session_id) ON DELETE SET NULL,
    created_from_session_id TEXT REFERENCES sessions(session_id) ON DELETE SET NULL,
    created_from_event_id INTEGER,
    navigation_session_id TEXT REFERENCES sessions(session_id) ON DELETE SET NULL,
    navigation_node_id    TEXT,
    navigation_event_id   INTEGER,
    archived              BOOLEAN NOT NULL DEFAULT FALSE,
    version               INTEGER NOT NULL DEFAULT 1,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (status IN (
        'open',
        'in_progress',
        'agent_done',
        'verified_done',
        'reopened',
        'blocked',
        'cancelled'
    )),
    CHECK (verification_owner IN ('agent', 'user', 'both'))
);

CREATE TABLE IF NOT EXISTS task_operations (
    id                 TEXT PRIMARY KEY,
    task_id            TEXT REFERENCES task_items(id) ON DELETE SET NULL,
    operation_type     TEXT NOT NULL,
    actor_kind         TEXT NOT NULL DEFAULT 'agent',
    actor_session_id   TEXT REFERENCES sessions(session_id) ON DELETE SET NULL,
    actor_event_id     INTEGER,
    actor_user_id      TEXT,
    idempotency_key    TEXT,
    payload_json       JSONB NOT NULL DEFAULT '{}',
    reason             TEXT,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_task_items_parent ON task_items (parent_id, position_key);
CREATE INDEX IF NOT EXISTS idx_task_items_status ON task_items (status) WHERE archived = FALSE;
CREATE INDEX IF NOT EXISTS idx_task_items_active_session ON task_items (active_for_session_id) WHERE active_for_session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_task_items_linked_session ON task_items (linked_session_id) WHERE linked_session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_task_operations_task ON task_operations (task_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_task_operations_idempotency
    ON task_operations (idempotency_key)
    WHERE idempotency_key IS NOT NULL;
