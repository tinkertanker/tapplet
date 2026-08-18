-- Per-owner token version. Bumping an owner's row to N invalidates every
-- device token whose payload version is below N (legacy tokens count as 0),
-- giving operators per-device revocation without rotating the global signing
-- secret. To revoke one iPad's access today:
--   npx wrangler d1 execute classroom-widgets-studio --remote --command \
--     "INSERT INTO owner_token_versions(owner_hash, token_version)
--      VALUES('<owner-hash>', 1)
--      ON CONFLICT(owner_hash) DO UPDATE SET token_version = token_version + 1"
CREATE TABLE IF NOT EXISTS owner_token_versions (
  owner_hash TEXT PRIMARY KEY,
  token_version INTEGER NOT NULL DEFAULT 0 CHECK (token_version >= 0)
);
