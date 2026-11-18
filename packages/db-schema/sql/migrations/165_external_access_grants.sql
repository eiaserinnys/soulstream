-- 165: external access grants, input receipts, replies (card #1457)
--
-- Shared base for expiring access links (#1457) and inbound webhooks (#1458):
-- one grant row per issued credential, one receipt per admitted external request,
-- and the replies the target agent explicitly posts back. Keys are stored as a
-- sha256 hash; signature mode keeps the signing secret because verification
-- needs the original value (design 2.7). Obsolete rows stay for history and are
-- filtered by revoked_at/expires_at when a request is resolved.

CREATE TABLE IF NOT EXISTS external_access_grants (
    id UUID PRIMARY KEY,
    kind TEXT NOT NULL,
    owner_email TEXT NOT NULL REFERENCES users(email),
    label TEXT NOT NULL,
    target_session_id TEXT NOT NULL,
    permissions TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    auth_mode TEXT NOT NULL,
    key_hash CHAR(64),
    signing_secret TEXT,
    preamble TEXT,
    expires_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_used_at TIMESTAMPTZ,
    CONSTRAINT external_access_grants_kind_check
        CHECK (kind IN ('link', 'inbound_webhook')),
    CONSTRAINT external_access_grants_label_nonempty
        CHECK (length(btrim(label)) > 0),
    CONSTRAINT external_access_grants_auth_mode_check
        CHECK (auth_mode IN ('key', 'signature')),
    CONSTRAINT external_access_grants_permissions_check
        CHECK (permissions <@ ARRAY['send', 'read_own', 'read_history', 'control']::TEXT[]),
    CONSTRAINT external_access_grants_key_material_check
        CHECK (
            (auth_mode = 'key' AND key_hash IS NOT NULL AND signing_secret IS NULL)
            OR
            (auth_mode = 'signature' AND key_hash IS NULL AND signing_secret IS NOT NULL)
        )
);

CREATE INDEX IF NOT EXISTS idx_external_access_grants_owner
    ON external_access_grants (owner_email, created_at DESC);

-- The receipt is the idempotency boundary: one row per (grant, request_id).
-- Its payload keeps the exact intervention body that was registered in the
-- delivery ledger so a retry re-registers the same normalized payload hash.
CREATE TABLE IF NOT EXISTS external_input_receipts (
    grant_id UUID NOT NULL REFERENCES external_access_grants(id) ON DELETE CASCADE,
    request_id TEXT NOT NULL,
    request_hash CHAR(64) NOT NULL,
    delivery_id TEXT NOT NULL UNIQUE,
    target_session_id TEXT NOT NULL,
    payload JSONB NOT NULL,
    caller_info JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (grant_id, request_id)
);

CREATE TABLE IF NOT EXISTS external_replies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    grant_id UUID NOT NULL,
    request_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    text TEXT NOT NULL DEFAULT '',
    final BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    FOREIGN KEY (grant_id, request_id)
        REFERENCES external_input_receipts(grant_id, request_id) ON DELETE CASCADE
);

-- A request is closed by exactly one final reply (design 2.3).
CREATE UNIQUE INDEX IF NOT EXISTS uq_external_replies_final
    ON external_replies (grant_id, request_id)
    WHERE final;
