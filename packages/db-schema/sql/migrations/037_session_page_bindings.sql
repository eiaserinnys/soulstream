CREATE TABLE IF NOT EXISTS session_page_bindings (
    session_id             TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE,
    node_id                TEXT NOT NULL,
    target_page_id         TEXT,
    target_block_id        TEXT,
    target_expected_version INTEGER,
    daily_date             DATE NOT NULL,
    session_type           TEXT NOT NULL,
    legacy_folder_id       TEXT,
    legacy_container_kind  TEXT,
    legacy_container_id    TEXT,
    source_runbook_item_id TEXT,
    page_state             TEXT NOT NULL DEFAULT 'pending'
                           CHECK (page_state IN ('pending','bound','manual_repair')),
    legacy_state           TEXT NOT NULL DEFAULT 'pending'
                           CHECK (legacy_state IN ('pending','completed','manual_repair')),
    attempts               INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    last_error             TEXT,
    next_retry_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT session_page_bindings_anchor_shape CHECK (
      (target_page_id IS NULL AND target_block_id IS NULL AND target_expected_version IS NULL)
      OR (target_page_id IS NOT NULL AND target_block_id IS NOT NULL
          AND target_expected_version IS NOT NULL AND target_expected_version > 0)
    ),
    CONSTRAINT session_page_bindings_container_shape CHECK (
      (legacy_container_kind IS NULL AND legacy_container_id IS NULL)
      OR (legacy_container_kind IS NOT NULL AND legacy_container_id IS NOT NULL)
    ),
    CONSTRAINT session_page_bindings_container_kind_check CHECK (
      legacy_container_kind IS NULL OR legacy_container_kind IN ('folder','runbook')
    )
);

CREATE INDEX IF NOT EXISTS idx_session_page_bindings_due
    ON session_page_bindings(node_id, next_retry_at, created_at)
    WHERE page_state = 'pending'
       OR (page_state = 'bound' AND legacy_state = 'pending');

CREATE UNIQUE INDEX IF NOT EXISTS uq_blocks_primary_session_ref
    ON blocks ((properties ->> 'sessionId'))
    WHERE block_type = 'session_ref'
      AND properties ->> 'primary' = 'true';
