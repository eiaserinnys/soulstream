ALTER TABLE recurring_jobs
    ADD COLUMN IF NOT EXISTS model_preset_fallbacks JSONB;
