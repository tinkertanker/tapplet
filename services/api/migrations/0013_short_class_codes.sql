ALTER TABLE class_codes ADD COLUMN short_code_hash TEXT;

CREATE UNIQUE INDEX class_codes_short_code
  ON class_codes(short_code_hash);
