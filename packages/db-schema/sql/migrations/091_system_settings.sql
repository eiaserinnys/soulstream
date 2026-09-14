-- 091: PostgreSQL-owned global system settings.
--
-- The seed is deliberately non-destructive: operators may apply this migration
-- again or deploy it after a manually-created policy without overwriting the
-- existing value or CAS version.

CREATE TABLE IF NOT EXISTS system_settings (
    setting_key TEXT PRIMARY KEY,
    value        JSONB NOT NULL,
    version      BIGINT NOT NULL DEFAULT 1,
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by   TEXT NOT NULL,
    CONSTRAINT system_settings_key_nonempty CHECK (length(btrim(setting_key)) > 0),
    CONSTRAINT system_settings_value_object CHECK (jsonb_typeof(value) = 'object'),
    CONSTRAINT system_settings_version_positive CHECK (version > 0),
    CONSTRAINT system_settings_updated_by_nonempty CHECK (length(btrim(updated_by)) > 0)
);

INSERT INTO system_settings (setting_key, value, version, updated_by)
VALUES (
    'session_review_policy',
    '{"source_allowlist":["slack","soul-app","external-llm","clipper"]}'::JSONB,
    1,
    'migration:091_system_settings'
)
ON CONFLICT (setting_key) DO NOTHING;
