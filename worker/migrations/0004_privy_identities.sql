-- Forward-compatible Privy identity mapping. Existing user/session rows remain untouched.
-- auth_provider is nullable so legacy sessions retain their original auth_method.
ALTER TABLE sessions ADD COLUMN auth_provider TEXT CHECK (auth_provider IS NULL OR auth_provider = 'privy');

CREATE TABLE privy_identities (
  privy_user_id TEXT PRIMARY KEY NOT NULL CHECK (length(privy_user_id) BETWEEN 10 AND 255 AND substr(privy_user_id, 1, 10) = 'did:privy:'),
  user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (typeof(created_at) = 'text' AND length(created_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at)
);

CREATE INDEX privy_identities_user_idx ON privy_identities(user_id);
