-- Merchant wallet proof is a separate, short-lived capability. It cannot become a login session.
ALTER TABLE siwe_nonces ADD COLUMN session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE;

CREATE TABLE merchant_wallet_challenges (
  id         TEXT PRIMARY KEY NOT NULL,
  nonce      TEXT NOT NULL UNIQUE,
  org_id     TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  address    TEXT NOT NULL CHECK (length(address) = 42 AND substr(address, 1, 2) = '0x' AND substr(address, 3) NOT GLOB '*[^0-9a-f]*'),
  chain_id   INTEGER NOT NULL CHECK (chain_id = 5042002),
  message_hash TEXT NOT NULL CHECK (length(message_hash) = 64 AND message_hash NOT GLOB '*[^0-9a-f]*'),
  expires_at TEXT NOT NULL CHECK (typeof(expires_at) = 'text' AND length(expires_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', expires_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ', expires_at) = expires_at),
  used_at    TEXT CHECK (used_at IS NULL OR (typeof(used_at) = 'text' AND length(used_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', used_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ', used_at) = used_at)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) CHECK (typeof(created_at) = 'text' AND length(created_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at)
);

CREATE INDEX merchant_wallet_challenges_expiry_idx ON merchant_wallet_challenges(expires_at);
CREATE INDEX merchant_wallet_challenges_scope_idx ON merchant_wallet_challenges(org_id, user_id, session_id, address);
