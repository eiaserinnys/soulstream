ALTER TABLE runbooks ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'open';
ALTER TABLE runbooks ADD COLUMN IF NOT EXISTS completed_kind TEXT;
ALTER TABLE runbooks ADD COLUMN IF NOT EXISTS completed_session_id TEXT;
ALTER TABLE runbooks ADD COLUMN IF NOT EXISTS completed_event_id INTEGER;
ALTER TABLE runbooks ADD COLUMN IF NOT EXISTS completed_user_id TEXT;
ALTER TABLE runbooks ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;

ALTER TABLE runbooks DROP CONSTRAINT IF EXISTS runbooks_status_check;
ALTER TABLE runbooks ADD CONSTRAINT runbooks_status_check
    CHECK (status IN ('open','completed'));

ALTER TABLE runbooks DROP CONSTRAINT IF EXISTS runbooks_completed_kind_check;
ALTER TABLE runbooks ADD CONSTRAINT runbooks_completed_kind_check
    CHECK (completed_kind IN ('agent','user'));

ALTER TABLE runbooks DROP CONSTRAINT IF EXISTS runbooks_completed_session_id_fkey;
ALTER TABLE runbooks ADD CONSTRAINT runbooks_completed_session_id_fkey
    FOREIGN KEY (completed_session_id) REFERENCES sessions(session_id) ON DELETE SET NULL;

ALTER TABLE runbooks DROP CONSTRAINT IF EXISTS runbooks_completed_event_fkey;
ALTER TABLE runbooks ADD CONSTRAINT runbooks_completed_event_fkey
    FOREIGN KEY (completed_session_id, completed_event_id)
    REFERENCES events(session_id, id) ON DELETE SET NULL;
