-- 0004_catalog: products, plans, customers, wallets, subscriptions, mandates.
-- Each tenant table exposes UNIQUE (org_id, id) so children can use a composite
-- foreign key (org_id, parent_id) and can never reference another tenant's row.

CREATE TABLE products (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  name        TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  description TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 1000),
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, id)
);
CREATE UNIQUE INDEX products_org_name_key ON products (org_id, lower(name));

CREATE TABLE plans (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL,
  product_id  UUID NOT NULL,
  name        TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  amount      BIGINT NOT NULL CHECK (amount > 0),              -- USDC base units (6 decimals)
  currency    TEXT NOT NULL DEFAULT 'USDC' CHECK (currency = 'USDC'),
  "interval"  TEXT NOT NULL CHECK ("interval" IN ('week', 'month', 'year')),
  trial_days  INTEGER NOT NULL DEFAULT 0 CHECK (trial_days BETWEEN 0 AND 365),
  escrow_days INTEGER NOT NULL DEFAULT 0 CHECK (escrow_days BETWEEN 0 AND 90),
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, product_id) REFERENCES products (org_id, id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX plans_product_name_key ON plans (product_id, lower(name));
CREATE INDEX plans_org_idx ON plans (org_id, status);

CREATE TABLE customers (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  name       TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  email      TEXT NOT NULL CHECK (email = lower(email) AND email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  company    TEXT NOT NULL DEFAULT '' CHECK (length(company) <= 120),
  status     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (org_id, email)
);

-- Wallet associations. Only public addresses are stored; never keys or seed phrases.
--   login:    a user's SIWE-verified wallet (one user per address)
--   payout:   an organization's settlement address
--   customer: a customer's payer address
CREATE TABLE wallets (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  purpose             TEXT NOT NULL CHECK (purpose IN ('login', 'payout', 'customer')),
  org_id              UUID REFERENCES organizations (id) ON DELETE CASCADE,
  user_id             UUID REFERENCES users (id) ON DELETE CASCADE,
  customer_id         UUID,
  address             TEXT NOT NULL CHECK (address ~ '^0x[0-9a-f]{40}$'),  -- stored lowercase
  chain_id            BIGINT NOT NULL CHECK (chain_id > 0),
  label               TEXT NOT NULL DEFAULT '' CHECK (length(label) <= 80),
  verified_at         TIMESTAMPTZ,
  verification_method TEXT CHECK (verification_method IN ('siwe')),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, customer_id) REFERENCES customers (org_id, id) ON DELETE CASCADE,
  CONSTRAINT wallets_purpose_shape CHECK (
    (purpose = 'login' AND user_id IS NOT NULL AND org_id IS NULL AND customer_id IS NULL AND verified_at IS NOT NULL)
    OR (purpose = 'payout' AND org_id IS NOT NULL AND customer_id IS NULL AND user_id IS NULL)
    OR (purpose = 'customer' AND org_id IS NOT NULL AND customer_id IS NOT NULL AND user_id IS NULL)
  )
);
CREATE UNIQUE INDEX wallets_login_address_key ON wallets (address) WHERE purpose = 'login';
CREATE UNIQUE INDEX wallets_payout_key ON wallets (org_id, address, chain_id) WHERE purpose = 'payout';
CREATE UNIQUE INDEX wallets_customer_key ON wallets (org_id, customer_id, address, chain_id) WHERE purpose = 'customer';
CREATE INDEX wallets_user_idx ON wallets (user_id) WHERE user_id IS NOT NULL;

-- A subscription starts as 'incomplete': no payment authorization exists in Phase 2,
-- so nothing here may claim to be 'active' until a verified onchain event says so.
CREATE TABLE subscriptions (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id               UUID NOT NULL,
  customer_id          UUID NOT NULL,
  plan_id              UUID NOT NULL,
  status               TEXT NOT NULL DEFAULT 'incomplete'
                       CHECK (status IN ('incomplete', 'trialing', 'active', 'past_due', 'paused', 'canceled')),
  amount               BIGINT NOT NULL CHECK (amount > 0),   -- price snapshot at creation
  "interval"           TEXT NOT NULL CHECK ("interval" IN ('week', 'month', 'year')),
  current_period_start TIMESTAMPTZ,
  current_period_end   TIMESTAMPTZ,
  cancel_at_period_end BOOLEAN NOT NULL DEFAULT false,
  canceled_at          TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, customer_id) REFERENCES customers (org_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (org_id, plan_id) REFERENCES plans (org_id, id) ON DELETE RESTRICT
);
CREATE INDEX subscriptions_org_status_idx ON subscriptions (org_id, status);
CREATE INDEX subscriptions_customer_idx ON subscriptions (customer_id);

-- Payment authorizations for recurring pulls. Schema only in Phase 2; no endpoint creates these.
CREATE TABLE mandates (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                UUID NOT NULL,
  subscription_id       UUID NOT NULL,
  customer_id           UUID NOT NULL,
  payer_address         TEXT NOT NULL CHECK (payer_address ~ '^0x[0-9a-f]{40}$'),
  chain_id              BIGINT NOT NULL CHECK (chain_id > 0),
  token_address         TEXT NOT NULL CHECK (token_address ~ '^0x[0-9a-f]{40}$'),
  max_amount_per_period BIGINT NOT NULL CHECK (max_amount_per_period > 0),
  period_seconds        INTEGER NOT NULL CHECK (period_seconds > 0),
  status                TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'revoked', 'expired')),
  contract_address      TEXT CHECK (contract_address ~ '^0x[0-9a-f]{40}$'),
  onchain_ref           TEXT,
  valid_from            TIMESTAMPTZ,
  valid_until           TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, subscription_id) REFERENCES subscriptions (org_id, id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, customer_id) REFERENCES customers (org_id, id) ON DELETE RESTRICT
);
CREATE INDEX mandates_subscription_idx ON mandates (subscription_id);

CREATE TRIGGER products_updated BEFORE UPDATE ON products FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER plans_updated BEFORE UPDATE ON plans FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER customers_updated BEFORE UPDATE ON customers FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER wallets_updated BEFORE UPDATE ON wallets FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER subscriptions_updated BEFORE UPDATE ON subscriptions FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER mandates_updated BEFORE UPDATE ON mandates FOR EACH ROW EXECUTE FUNCTION set_updated_at();
