ALTER TABLE cards ADD COLUMN limit_resume_session_id text NULL;
ALTER TABLE cards ADD COLUMN limit_resume_at timestamptz NULL;
ALTER TABLE cards ADD CONSTRAINT cards_limit_resume_check CHECK (
  (limit_resume_session_id IS NULL AND limit_resume_at IS NULL)
  OR
  (limit_resume_session_id IS NOT NULL
    AND status = 'blocked' AND blocked_kind IS NOT NULL AND blocked_kind = 'limit'
    AND assignee_kind IS NOT NULL AND assignee_kind = 'session'
    AND assignee_session_id IS NOT NULL
    AND limit_resume_session_id = assignee_session_id
    AND NOT archived)
);
