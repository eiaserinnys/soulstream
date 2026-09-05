-- Canonical Claude background execution generations. The legacy
-- claude_background_tasks table remains an old-worker-compatible projection.
CREATE TABLE IF NOT EXISTS claude_background_task_generations (
    source_node              TEXT NOT NULL,
    session_id               TEXT NOT NULL,
    sdk_session_id           TEXT NOT NULL,
    task_id                  TEXT NOT NULL,
    initiating_tool_use_id   TEXT NOT NULL,
    generation_sequence      BIGSERIAL NOT NULL UNIQUE,
    generation_key           TEXT NOT NULL UNIQUE,
    relation_key             TEXT NOT NULL UNIQUE,
    completion_id            TEXT NOT NULL UNIQUE,
    status                   TEXT NOT NULL DEFAULT 'running',
    close_reason             TEXT,
    description              TEXT,
    summary                  TEXT,
    output_file              TEXT,
    terminal_revision        TEXT,
    notification_delivery_id TEXT,
    created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    terminal_at              TIMESTAMPTZ,
    PRIMARY KEY (
        source_node,
        session_id,
        sdk_session_id,
        task_id,
        initiating_tool_use_id
    ),
    CONSTRAINT claude_background_task_generations_status_check
        CHECK (status IN (
            'pending',
            'running',
            'completed',
            'failed',
            'stopped',
            'killed'
        ))
);

CREATE INDEX IF NOT EXISTS idx_claude_background_generations_active_session
    ON claude_background_task_generations(
        source_node,
        session_id,
        generation_sequence
    )
    WHERE status IN ('pending', 'running');

CREATE INDEX IF NOT EXISTS idx_claude_background_generations_task_resolution
    ON claude_background_task_generations(
        source_node,
        session_id,
        sdk_session_id,
        task_id,
        generation_sequence
    );

CREATE INDEX IF NOT EXISTS idx_claude_background_generations_delivery
    ON claude_background_task_generations(notification_delivery_id)
    WHERE notification_delivery_id IS NOT NULL;
