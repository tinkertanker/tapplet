-- Bind uncertain CLI retries to their original allocation, not mutable labels.
-- Existing codes, aliases, usage and expiry remain unchanged.
ALTER TABLE class_codes ADD COLUMN allocation_id TEXT;
