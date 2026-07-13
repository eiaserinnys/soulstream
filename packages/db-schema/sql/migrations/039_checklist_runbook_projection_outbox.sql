CREATE TABLE IF NOT EXISTS checklist_runbook_projection_outbox (
    block_id           TEXT PRIMARY KEY,
    page_id            TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    source_hash        TEXT NOT NULL,
    processed_hash     TEXT,
    actor_kind         TEXT NOT NULL DEFAULT 'system',
    actor_session_id   TEXT REFERENCES sessions(session_id) ON DELETE SET NULL,
    actor_user_id      TEXT,
    routing_session_id TEXT REFERENCES sessions(session_id) ON DELETE SET NULL,
    attempts           INTEGER NOT NULL DEFAULT 0,
    last_error         TEXT,
    next_retry_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    lease_owner_node_id TEXT,
    lease_expires_at   TIMESTAMPTZ,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE checklist_runbook_projection_outbox ADD COLUMN IF NOT EXISTS page_id TEXT;
ALTER TABLE checklist_runbook_projection_outbox ADD COLUMN IF NOT EXISTS source_hash TEXT;
ALTER TABLE checklist_runbook_projection_outbox ADD COLUMN IF NOT EXISTS processed_hash TEXT;
ALTER TABLE checklist_runbook_projection_outbox ADD COLUMN IF NOT EXISTS actor_kind TEXT NOT NULL DEFAULT 'system';
ALTER TABLE checklist_runbook_projection_outbox ADD COLUMN IF NOT EXISTS actor_session_id TEXT;
ALTER TABLE checklist_runbook_projection_outbox ADD COLUMN IF NOT EXISTS actor_user_id TEXT;
ALTER TABLE checklist_runbook_projection_outbox ADD COLUMN IF NOT EXISTS routing_session_id TEXT;
ALTER TABLE checklist_runbook_projection_outbox ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE checklist_runbook_projection_outbox ADD COLUMN IF NOT EXISTS last_error TEXT;
ALTER TABLE checklist_runbook_projection_outbox ADD COLUMN IF NOT EXISTS next_retry_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE checklist_runbook_projection_outbox ADD COLUMN IF NOT EXISTS lease_owner_node_id TEXT;
ALTER TABLE checklist_runbook_projection_outbox ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ;
ALTER TABLE checklist_runbook_projection_outbox ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE checklist_runbook_projection_outbox ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE checklist_runbook_projection_outbox ALTER COLUMN page_id SET NOT NULL;
ALTER TABLE checklist_runbook_projection_outbox ALTER COLUMN source_hash SET NOT NULL;
ALTER TABLE checklist_runbook_projection_outbox DROP CONSTRAINT IF EXISTS checklist_runbook_projection_outbox_page_id_fkey;
ALTER TABLE checklist_runbook_projection_outbox ADD CONSTRAINT checklist_runbook_projection_outbox_page_id_fkey
    FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE CASCADE;
ALTER TABLE checklist_runbook_projection_outbox DROP CONSTRAINT IF EXISTS checklist_runbook_projection_outbox_actor_session_id_fkey;
ALTER TABLE checklist_runbook_projection_outbox ADD CONSTRAINT checklist_runbook_projection_outbox_actor_session_id_fkey
    FOREIGN KEY (actor_session_id) REFERENCES sessions(session_id) ON DELETE SET NULL;
ALTER TABLE checklist_runbook_projection_outbox DROP CONSTRAINT IF EXISTS checklist_runbook_projection_outbox_routing_session_id_fkey;
ALTER TABLE checklist_runbook_projection_outbox ADD CONSTRAINT checklist_runbook_projection_outbox_routing_session_id_fkey
    FOREIGN KEY (routing_session_id) REFERENCES sessions(session_id) ON DELETE SET NULL;
ALTER TABLE checklist_runbook_projection_outbox DROP CONSTRAINT IF EXISTS checklist_runbook_projection_outbox_actor_kind_check;
ALTER TABLE checklist_runbook_projection_outbox ADD CONSTRAINT checklist_runbook_projection_outbox_actor_kind_check
    CHECK (actor_kind IN ('agent','user','system'));
ALTER TABLE checklist_runbook_projection_outbox DROP CONSTRAINT IF EXISTS checklist_runbook_projection_outbox_actor_shape_check;
ALTER TABLE checklist_runbook_projection_outbox ADD CONSTRAINT checklist_runbook_projection_outbox_actor_shape_check
    CHECK (
      (actor_kind = 'agent' AND actor_session_id IS NOT NULL AND actor_user_id IS NULL)
      OR (actor_kind = 'user' AND actor_user_id IS NOT NULL)
      OR (actor_kind = 'system' AND actor_user_id IS NULL)
    );
ALTER TABLE checklist_runbook_projection_outbox DROP CONSTRAINT IF EXISTS checklist_runbook_projection_outbox_attempts_check;
ALTER TABLE checklist_runbook_projection_outbox ADD CONSTRAINT checklist_runbook_projection_outbox_attempts_check
    CHECK (attempts >= 0);

CREATE INDEX IF NOT EXISTS idx_checklist_runbook_projection_due
    ON checklist_runbook_projection_outbox(next_retry_at, updated_at, block_id)
    WHERE processed_hash IS DISTINCT FROM source_hash;

INSERT INTO checklist_runbook_projection_outbox (
  block_id, page_id, source_hash, actor_kind, actor_session_id
)
SELECT
  block.id,
  block.page_id,
  'reconcile:' || md5(
    block.block_type || E'\x1f' || block.text_plain || E'\x1f' || block.properties::text
  ),
  CASE
    WHEN COALESCE(
      block.updated_session_id, page.updated_session_id,
      block.created_session_id, page.created_session_id
    ) IS NULL THEN 'system'
    ELSE 'agent'
  END,
  COALESCE(
    block.updated_session_id, page.updated_session_id,
    block.created_session_id, page.created_session_id
  )
FROM blocks block
JOIN pages page ON page.id = block.page_id
WHERE block.block_type = 'checklist'
ON CONFLICT (block_id) DO NOTHING;
