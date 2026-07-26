-- 046: persistent Claude background task lifecycle journal
--
-- Apply after 045 and before code reads durable background lifecycle state.

CREATE TABLE IF NOT EXISTS claude_background_tasks (
    source_node              TEXT NOT NULL,
    session_id               TEXT NOT NULL,
    task_id                  TEXT NOT NULL,
    sdk_session_id           TEXT,
    status                   TEXT NOT NULL DEFAULT 'running',
    close_reason             TEXT,
    description              TEXT,
    summary                  TEXT,
    output_file              TEXT,
    tool_use_id              TEXT,
    terminal_revision        TEXT,
    notification_delivery_id TEXT,
    created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    terminal_at              TIMESTAMPTZ,
    PRIMARY KEY (source_node, session_id, task_id),
    CONSTRAINT claude_background_tasks_status_check
        CHECK (status IN (
            'pending',
            'running',
            'completed',
            'failed',
            'stopped',
            'killed'
        ))
);

CREATE INDEX IF NOT EXISTS idx_claude_background_tasks_active_node
    ON claude_background_tasks(source_node, updated_at, session_id, task_id)
    WHERE status IN ('pending', 'running');

CREATE INDEX IF NOT EXISTS idx_claude_background_tasks_delivery
    ON claude_background_tasks(notification_delivery_id)
    WHERE notification_delivery_id IS NOT NULL;
