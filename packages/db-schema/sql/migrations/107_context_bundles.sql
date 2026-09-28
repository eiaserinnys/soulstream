CREATE TABLE IF NOT EXISTS context_bundles (
    bundle_id TEXT PRIMARY KEY,
    description TEXT NOT NULL DEFAULT '',
    atom_contexts JSONB NOT NULL DEFAULT '[]'::jsonb,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT context_bundles_bundle_id_nonempty CHECK (length(bundle_id) > 0),
    CONSTRAINT context_bundles_bundle_id_format CHECK (bundle_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]*$'),
    CONSTRAINT context_bundles_atom_contexts_array CHECK (jsonb_typeof(atom_contexts) = 'array'),
    CONSTRAINT context_bundles_version_positive CHECK (version > 0)
);

ALTER TABLE agent_profiles
    ADD COLUMN IF NOT EXISTS context_bundles JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE agent_profiles
    DROP CONSTRAINT IF EXISTS agent_profiles_context_bundles_array;

ALTER TABLE agent_profiles
    ADD CONSTRAINT agent_profiles_context_bundles_array
    CHECK (jsonb_typeof(context_bundles) = 'array');
