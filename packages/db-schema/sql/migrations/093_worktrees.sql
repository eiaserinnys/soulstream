-- 093: centrally owned node-local Git worktrees and optional session binding.
--
-- Additive for rolling deployment: existing sessions remain unbound and older
-- workers do not need either table or column.

CREATE TABLE IF NOT EXISTS worktrees (
    id                         TEXT PRIMARY KEY,
    node_id                    TEXT NOT NULL,
    repo_id                    TEXT NOT NULL,
    canonical_path             TEXT NOT NULL,
    branch                     TEXT NOT NULL,
    created_from_sha           TEXT NOT NULL,
    owner_task_id              TEXT REFERENCES tasks(id) ON DELETE SET NULL,
    -- Immutable attribution, intentionally not an FK: deleting the creating
    -- session must not make a node-local worktree undeletable.
    created_by_session_id      TEXT NOT NULL,
    state                      TEXT NOT NULL DEFAULT 'ready',
    setup_mode                 TEXT NOT NULL DEFAULT 'none',
    setup_required             BOOLEAN NOT NULL DEFAULT FALSE,
    setup_status               TEXT NOT NULL DEFAULT 'not_requested',
    managed_paths              JSONB NOT NULL DEFAULT '[]'::jsonb,
    worktree_identity          TEXT NOT NULL,
    branch_delete_expected_sha TEXT,
    branch_delete_marker_ref   TEXT,
    last_error_code            TEXT,
    last_error_message         TEXT,
    created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    removed_at                 TIMESTAMPTZ,
    branch_deleted_at          TIMESTAMPTZ,
    CONSTRAINT worktrees_state_check
        CHECK (state IN ('ready', 'removing', 'removed')),
    CONSTRAINT worktrees_setup_mode_check
        CHECK (setup_mode IN ('none', 'shared_dependencies')),
    CONSTRAINT worktrees_setup_status_check
        CHECK (setup_status IN ('not_requested', 'ready', 'failed')),
    CONSTRAINT worktrees_managed_paths_array_check
        CHECK (jsonb_typeof(managed_paths) = 'array')
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_worktrees_live_branch
    ON worktrees(node_id, repo_id, branch)
    WHERE state <> 'removed';

CREATE UNIQUE INDEX IF NOT EXISTS uq_worktrees_live_path
    ON worktrees(node_id, canonical_path)
    WHERE state <> 'removed';

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS worktree_id TEXT;

ALTER TABLE sessions DROP CONSTRAINT IF EXISTS sessions_worktree_id_fkey;
ALTER TABLE sessions ADD CONSTRAINT sessions_worktree_id_fkey
    FOREIGN KEY (worktree_id) REFERENCES worktrees(id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_sessions_active_worktree
    ON sessions(worktree_id)
    WHERE worktree_id IS NOT NULL AND status IN ('initializing', 'running');


-- Replaces the existing function at the same signature. Worktree validation is
-- serialized on the worktree row; rejected resume preserves the historical
-- applied=false return contract.
CREATE OR REPLACE FUNCTION session_apply_running_transition(
    p_session_id                 TEXT,
    p_review_state               TEXT,
    p_expected_terminal_event_id INTEGER,
    p_terminal_resume            BOOLEAN,
    p_updated_at                 TIMESTAMPTZ
) RETURNS TABLE (
    applied BOOLEAN, status TEXT, termination_reason TEXT,
    termination_detail TEXT, review_state TEXT, last_assistant_text TEXT,
    termination_event_id INTEGER, updated_at TIMESTAMPTZ, last_event_id INTEGER
) LANGUAGE plpgsql AS $$
DECLARE
    v_row_count INTEGER := 0;
    v_worktree_id TEXT;
    v_worktree_state TEXT;
    v_setup_required BOOLEAN;
    v_setup_status TEXT;
BEGIN
    SELECT session.worktree_id INTO v_worktree_id
      FROM sessions AS session
     WHERE session.session_id = p_session_id
     FOR UPDATE;

    IF v_worktree_id IS NOT NULL THEN
        SELECT worktree.state, worktree.setup_required, worktree.setup_status
          INTO v_worktree_state, v_setup_required, v_setup_status
          FROM worktrees AS worktree
         WHERE worktree.id = v_worktree_id
         FOR UPDATE;
        IF NOT FOUND
           OR v_worktree_state <> 'ready'
           OR (v_setup_required AND v_setup_status <> 'ready')
           OR EXISTS (
             SELECT 1 FROM sessions AS active
              WHERE active.worktree_id = v_worktree_id
                AND active.session_id <> p_session_id
                AND active.status IN ('initializing', 'running')
           ) THEN
            RETURN QUERY
            SELECT FALSE, session.status, session.termination_reason,
                   session.termination_detail, session.review_state,
                   session.last_assistant_text, session.termination_event_id,
                   session.updated_at, session.last_event_id
              FROM sessions AS session
             WHERE session.session_id = p_session_id;
            RETURN;
        END IF;
    END IF;

    IF p_terminal_resume THEN
        UPDATE sessions AS session
           SET status = 'running', termination_reason = NULL,
               termination_detail = NULL, termination_event_id = NULL,
               last_assistant_text = NULL, review_state = p_review_state,
               updated_at = p_updated_at
         WHERE session.session_id = p_session_id
           AND session.status IN ('completed', 'error', 'interrupted')
           AND session.termination_event_id IS NOT DISTINCT FROM p_expected_terminal_event_id;
    ELSE
        UPDATE sessions AS session
           SET status = 'running', termination_reason = NULL,
               termination_detail = NULL, review_state = p_review_state,
               updated_at = p_updated_at
         WHERE session.session_id = p_session_id
           AND session.status NOT IN ('completed', 'error', 'interrupted');
    END IF;
    GET DIAGNOSTICS v_row_count = ROW_COUNT;

    IF p_terminal_resume AND v_row_count = 1 THEN
        UPDATE session_deliveries
           SET state = 'superseded', aggregate_state = 'consumed',
               consumed_at = p_updated_at,
               consumed_reason = 'superseded by terminal resume',
               superseded_at = p_updated_at,
               superseded_terminal_revision = p_expected_terminal_event_id::text,
               attempt_token = NULL, attempt_expires_at = NULL,
               updated_at = p_updated_at
         WHERE source_session_id = p_session_id
           AND intent = 'completion_notification'
           AND source = 'completion_notifier'
           AND producer_kind = 'child_session'
           AND producer_terminal_revision = p_expected_terminal_event_id::text
           AND state IN ('pending', 'claimed', 'dispatching', 'queued');
    END IF;

    RETURN QUERY
    SELECT v_row_count = 1, session.status, session.termination_reason,
           session.termination_detail, session.review_state,
           session.last_assistant_text, session.termination_event_id,
           session.updated_at, session.last_event_id
      FROM sessions AS session
     WHERE session.session_id = p_session_id;
END;
$$;
