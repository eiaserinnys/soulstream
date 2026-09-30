-- Independent private R2 configurations; no environment fallback.
INSERT INTO system_settings (setting_key, value, version, updated_by)
VALUES
  ('board_r2', '{"endpoint":"","bucket":"","accessKeyId":"","secretAccessKey":""}'::jsonb, 1, 'migration:r2-storage'),
  ('attachment_r2', '{"endpoint":"","bucket":"","accessKeyId":"","secretAccessKey":""}'::jsonb, 1, 'migration:r2-storage')
ON CONFLICT (setting_key) DO NOTHING;
