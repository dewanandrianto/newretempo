-- 0002_identity: users, sessions, email tokens, SIWE nonces.

CREATE TABLE users (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email             TEXT,
  email_verified_at TIMESTAMPTZ,
  password_hash     TEXT,                       -- Argon2id PHC string; never plaintext
  display_name      TEXT NOT NULL DEFAULT '',
  status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  last_login_at     TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT users_email_lowercase CHECK (email IS NULL OR email = lower(email)),
  CONSTRAINT users_email_shape CHECK (email IS NULL OR email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  CONSTRAINT users_password_needs_email CHECK (password_hash IS NULL OR email IS NOT NULL)
);
CREATE UNIQUE INDEX users_email_key ON users (email) WHERE email IS NOT NULL;

CREATE TABLE sessions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash      TEXT NOT NULL UNIQUE,         -- HMAC of the cookie token; the token itself is never stored
  auth_method     TEXT NOT NULL CHECK (auth_method IN ('password', 'siwe')),
  ip              TEXT,
  user_agent      TEXT,
  last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  idle_expires_at TIMESTAMPTZ NOT NULL,
  expires_at      TIMESTAMPTZ NOT NULL,
  revoked_at      TIMESTAMPTZ,
  revoked_reason  TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_idx ON sessions (user_id) WHERE revoked_at IS NULL;

CREATE TABLE email_tokens (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  purpose     TEXT NOT NULL CHECK (purpose IN ('verify_email', 'reset_password')),
  email       TEXT NOT NULL,                    -- address the token was issued for
  token_hash  TEXT NOT NULL UNIQUE,             -- hash only; the raw token exists only in the email
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX email_tokens_user_idx ON email_tokens (user_id, purpose) WHERE used_at IS NULL;

CREATE TABLE siwe_nonces (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nonce        TEXT NOT NULL UNIQUE,
  purpose      TEXT NOT NULL CHECK (purpose IN ('login', 'link')),
  address      TEXT NOT NULL CHECK (address ~ '^0x[0-9a-f]{40}$'),
  user_id      UUID REFERENCES users (id) ON DELETE CASCADE,   -- set for 'link'
  message_hash TEXT NOT NULL,                   -- the exact message the server issued
  expires_at   TIMESTAMPTZ NOT NULL,
  used_at      TIMESTAMPTZ,                     -- single use: set atomically on verify
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT siwe_link_needs_user CHECK (purpose <> 'link' OR user_id IS NOT NULL)
);
CREATE INDEX siwe_nonces_expiry_idx ON siwe_nonces (expires_at);

CREATE TRIGGER users_updated BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER sessions_updated BEFORE UPDATE ON sessions FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER email_tokens_updated BEFORE UPDATE ON email_tokens FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER siwe_nonces_updated BEFORE UPDATE ON siwe_nonces FOR EACH ROW EXECUTE FUNCTION set_updated_at();
