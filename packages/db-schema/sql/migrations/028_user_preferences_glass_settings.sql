-- Document the expanded user_preferences JSONB contract.
-- No column is needed: account liquid glass settings live under prefs.glass.
COMMENT ON COLUMN user_preferences.prefs IS
  'Dashboard preferences JSON: appearance, wallpaper, and liquid glass settings.';
