-- Class-scoped inference: a class code may carry an encrypted tkslopper
-- classroom group key (tkgk_), and each device remembers the class it joined
-- so model calls can use that class's aliases, budget and kill switches.
-- Existing codes and devices keep the global inference configuration.
ALTER TABLE class_codes ADD COLUMN inference_key_ciphertext TEXT;
ALTER TABLE class_codes ADD COLUMN inference_key_iv TEXT;
ALTER TABLE class_codes ADD COLUMN inference_key_hint TEXT;
-- Bumped by every attach or removal so a slow attach cannot undo a newer change.
ALTER TABLE class_codes ADD COLUMN inference_key_version INTEGER NOT NULL DEFAULT 0;

CREATE TABLE device_classes (
  owner_hash TEXT PRIMARY KEY,
  class_code_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX device_classes_class
  ON device_classes(class_code_hash);
