-- Extend the provider allowlist without changing saved models or encrypted keys.
CREATE TABLE admin_model_settings_next (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  provider TEXT NOT NULL CHECK (
    provider IN ('openai-compatible', 'anthropic', 'opencode', 'opencode-go', 'openrouter', 'fixture')
  ),
  model TEXT NOT NULL,
  base_url TEXT NOT NULL,
  api_key_ciphertext TEXT,
  api_key_iv TEXT,
  updated_at TEXT NOT NULL,
  CHECK (
    (api_key_ciphertext IS NULL AND api_key_iv IS NULL) OR
    (api_key_ciphertext IS NOT NULL AND api_key_iv IS NOT NULL)
  )
);
INSERT INTO admin_model_settings_next SELECT * FROM admin_model_settings;
DROP TABLE admin_model_settings;
ALTER TABLE admin_model_settings_next RENAME TO admin_model_settings;
