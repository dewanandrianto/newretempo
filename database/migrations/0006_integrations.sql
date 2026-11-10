-- 0006_integrations: api_keys, webhooks, webhook_deliveries, audit_logs.

CREATE TABLE api_keys (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  created_by   UUID NOT NULL REFERENCES users (id),
  name         TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  prefix       TEXT NOT NULL UNIQUE,            -- public lookup id, e.g. rtk_test_ab12cd34
  key_hash     TEXT NOT NULL,                   -- keyed hash of the secret; the secret is shown once and never stored
  scopes       TEXT[] NOT NULL DEFAULT ARRAY['read']::TEXT[],
  last_used_at TIMESTAMPTZ,
  expires_at   TIMESTAMPTZ,
  revoked_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, id)
);
CREATE INDEX api_keys_org_idx ON api_keys (org_id) WHERE revoked_at IS NULL;

-- Schema only in Phase 2: no endpoint creates webhooks yet.
-- signing_secret_ciphertext must hold an authenticated-encryption ciphertext (the secret
-- has to be recoverable to sign deliveries, so it cannot be a one-way hash).
CREATE TABLE webhooks (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                    UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  url                       TEXT NOT NULL CHECK (url ~ '^https://'),
  description               TEXT NOT NULL DEFAULT '',
  events                    TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  status                    TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  signing_secret_ciphertext TEXT NOT NULL,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, id)
);

CREATE TABLE webhook_deliveries (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           UUID NOT NULL,
  webhook_id       UUID NOT NULL,
  event_id         UUID NOT NULL,
  event_type       TEXT NOT NULL,
  payload          JSONB NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'failed')),
  attempts         INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at  TIMESTAMPTZ,
  response_status  INTEGER,
  last_error       TEXT,
  delivered_at     TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (webhook_id, event_id),               -- an event is delivered to an endpoint at most once
  FOREIGN KEY (org_id, webhook_id) REFERENCES webhooks (org_id, id) ON DELETE CASCADE
);
CREATE INDEX webhook_deliveries_due_idx ON webhook_deliveries (next_attempt_at) WHERE status = 'pending';

-- Append-only. No foreign keys on purpose: audit history must outlive users and tenants.
CREATE TABLE audit_logs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID,
  actor_user_id UUID,
  actor_type    TEXT NOT NULL CHECK (actor_type IN ('user', 'system', 'api_key', 'chain')),
  action        TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id   UUID,
  metadata      JSONB NOT NULL DEFAULT '{}'::jsonb,
  ip            TEXT,
  user_agent    TEXT,
  request_id    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_org_time_idx ON audit_logs (org_id, created_at DESC);
CREATE INDEX audit_logs_resource_idx ON audit_logs (resource_type, resource_id);

CREATE TRIGGER api_keys_updated BEFORE UPDATE ON api_keys FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER webhooks_updated BEFORE UPDATE ON webhooks FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER webhook_deliveries_updated BEFORE UPDATE ON webhook_deliveries FOR EACH ROW EXECUTE FUNCTION set_updated_at();
