-- D1 schema. Money is canonical integer TEXT, never a JavaScript number.
CREATE TABLE users (
  id                TEXT PRIMARY KEY NOT NULL,
  email             TEXT,
  email_verified_at TEXT,
  password_hash     TEXT,                       
  display_name      TEXT NOT NULL DEFAULT '',
  status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  last_login_at     TEXT,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CONSTRAINT users_email_lowercase CHECK (email IS NULL OR email = lower(email)),
  CONSTRAINT users_email_shape CHECK (email IS NULL OR email LIKE '%_@_%._%' AND email NOT GLOB '*[ ' || char(9) || char(10) || char(13) || ']*' AND length(email)-length(replace(email,'@','')) = 1),
  CONSTRAINT users_password_needs_email CHECK (password_hash IS NULL OR email IS NOT NULL),
  CHECK (email_verified_at IS NULL OR (typeof(email_verified_at) = 'text' AND length(email_verified_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', email_verified_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ', email_verified_at) = email_verified_at)),
  CHECK (last_login_at IS NULL OR (typeof(last_login_at) = 'text' AND length(last_login_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', last_login_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ', last_login_at) = last_login_at)),
  CHECK (created_at IS NULL OR (typeof(created_at) = 'text' AND length(created_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at)),
  CHECK (updated_at IS NULL OR (typeof(updated_at) = 'text' AND length(updated_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) = updated_at))
);

CREATE UNIQUE INDEX users_email_key ON users (email) WHERE email IS NOT NULL;

CREATE TABLE sessions (
  id              TEXT PRIMARY KEY NOT NULL,
  user_id         TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash      TEXT NOT NULL UNIQUE,         
  auth_method     TEXT NOT NULL CHECK (auth_method IN ('password', 'siwe')),
  ip              TEXT,
  user_agent      TEXT,
  last_seen_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  idle_expires_at TEXT NOT NULL,
  expires_at      TEXT NOT NULL,
  revoked_at      TEXT,
  revoked_reason  TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (last_seen_at IS NULL OR (typeof(last_seen_at) = 'text' AND length(last_seen_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', last_seen_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ', last_seen_at) = last_seen_at)),
  CHECK (idle_expires_at IS NULL OR (typeof(idle_expires_at) = 'text' AND length(idle_expires_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', idle_expires_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ', idle_expires_at) = idle_expires_at)),
  CHECK (expires_at IS NULL OR (typeof(expires_at) = 'text' AND length(expires_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', expires_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ', expires_at) = expires_at)),
  CHECK (revoked_at IS NULL OR (typeof(revoked_at) = 'text' AND length(revoked_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', revoked_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ', revoked_at) = revoked_at)),
  CHECK (created_at IS NULL OR (typeof(created_at) = 'text' AND length(created_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at)),
  CHECK (updated_at IS NULL OR (typeof(updated_at) = 'text' AND length(updated_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) = updated_at))
);

CREATE INDEX sessions_user_idx ON sessions (user_id) WHERE revoked_at IS NULL;

CREATE TABLE email_tokens (
  id          TEXT PRIMARY KEY NOT NULL,
  user_id     TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  purpose     TEXT NOT NULL CHECK (purpose IN ('verify_email', 'reset_password')),
  email       TEXT NOT NULL,                    
  token_hash  TEXT NOT NULL UNIQUE,             
  expires_at  TEXT NOT NULL,
  used_at     TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (expires_at IS NULL OR (typeof(expires_at) = 'text' AND length(expires_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', expires_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ', expires_at) = expires_at)),
  CHECK (used_at IS NULL OR (typeof(used_at) = 'text' AND length(used_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', used_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ', used_at) = used_at)),
  CHECK (created_at IS NULL OR (typeof(created_at) = 'text' AND length(created_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at)),
  CHECK (updated_at IS NULL OR (typeof(updated_at) = 'text' AND length(updated_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) = updated_at))
);

CREATE INDEX email_tokens_user_idx ON email_tokens (user_id, purpose) WHERE used_at IS NULL;

CREATE TABLE siwe_nonces (
  id           TEXT PRIMARY KEY NOT NULL,
  nonce        TEXT NOT NULL UNIQUE,
  purpose      TEXT NOT NULL CHECK (purpose IN ('login', 'link')),
  address      TEXT NOT NULL CHECK ((length(address) = 42 AND substr(address,1,2) = '0x' AND substr(address,3) NOT GLOB '*[^0-9a-f]*')),
  user_id      TEXT REFERENCES users (id) ON DELETE CASCADE,   
  message_hash TEXT NOT NULL,                   
  expires_at   TEXT NOT NULL,
  used_at      TEXT,                     
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CONSTRAINT siwe_link_needs_user CHECK (purpose <> 'link' OR user_id IS NOT NULL),
  CHECK (expires_at IS NULL OR (typeof(expires_at) = 'text' AND length(expires_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', expires_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ', expires_at) = expires_at)),
  CHECK (used_at IS NULL OR (typeof(used_at) = 'text' AND length(used_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', used_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ', used_at) = used_at)),
  CHECK (created_at IS NULL OR (typeof(created_at) = 'text' AND length(created_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at)),
  CHECK (updated_at IS NULL OR (typeof(updated_at) = 'text' AND length(updated_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) = updated_at))
);

CREATE INDEX siwe_nonces_expiry_idx ON siwe_nonces (expires_at);

CREATE TABLE organizations (
  id              TEXT PRIMARY KEY NOT NULL,
  name            TEXT NOT NULL CHECK (length(name) BETWEEN 2 AND 80),
  slug            TEXT NOT NULL CHECK (length(slug) BETWEEN 3 AND 40 AND slug NOT GLOB '*[^a-z0-9-]*' AND substr(slug,1,1) GLOB '[a-z0-9]' AND substr(slug,-1) GLOB '[a-z0-9]'),
  website         TEXT,
  industry        TEXT NOT NULL,
  country         TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_by      TEXT NOT NULL REFERENCES users (id),
  invoice_counter INTEGER NOT NULL DEFAULT 0 CHECK (invoice_counter >= 0) CHECK (invoice_counter <= 9007199254740991),  
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (created_at IS NULL OR (typeof(created_at) = 'text' AND length(created_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at)),
  CHECK (updated_at IS NULL OR (typeof(updated_at) = 'text' AND length(updated_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) = updated_at))
);

CREATE UNIQUE INDEX organizations_slug_key ON organizations (slug);

CREATE TABLE memberships (
  id         TEXT PRIMARY KEY NOT NULL,
  org_id     TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role       TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (org_id, user_id),
  CHECK (created_at IS NULL OR (typeof(created_at) = 'text' AND length(created_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at)),
  CHECK (updated_at IS NULL OR (typeof(updated_at) = 'text' AND length(updated_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) = updated_at))
);

CREATE INDEX memberships_user_idx ON memberships (user_id);

CREATE TABLE products (
  id          TEXT PRIMARY KEY NOT NULL,
  org_id      TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  name        TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  description TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 1000),
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (org_id, id),
  CHECK (created_at IS NULL OR (typeof(created_at) = 'text' AND length(created_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at)),
  CHECK (updated_at IS NULL OR (typeof(updated_at) = 'text' AND length(updated_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) = updated_at))
);

CREATE UNIQUE INDEX products_org_name_key ON products (org_id, lower(name));

CREATE TABLE plans (
  id          TEXT PRIMARY KEY NOT NULL,
  org_id      TEXT NOT NULL,
  product_id  TEXT NOT NULL,
  name        TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  amount      TEXT NOT NULL ,              
  currency    TEXT NOT NULL DEFAULT 'USDC' CHECK (currency = 'USDC'),
  "interval"  TEXT NOT NULL CHECK ("interval" IN ('week', 'month', 'year')),
  trial_days  INTEGER NOT NULL DEFAULT 0 CHECK (trial_days BETWEEN 0 AND 365),
  escrow_days INTEGER NOT NULL DEFAULT 0 CHECK (escrow_days BETWEEN 0 AND 90),
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, product_id) REFERENCES products (org_id, id) ON DELETE RESTRICT,
  CHECK (typeof(amount) = 'text' AND length(amount) BETWEEN 1 AND 19 AND amount NOT GLOB '*[^0-9]*' AND (amount = '0' OR substr(amount,1,1) BETWEEN '1' AND '9') AND (length(amount) < 19 OR amount <= '9223372036854775807') AND amount <> '0'),
  CHECK (created_at IS NULL OR (typeof(created_at) = 'text' AND length(created_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at)),
  CHECK (updated_at IS NULL OR (typeof(updated_at) = 'text' AND length(updated_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) = updated_at))
);

CREATE UNIQUE INDEX plans_product_name_key ON plans (product_id, lower(name));

CREATE INDEX plans_org_idx ON plans (org_id, status);

CREATE TABLE customers (
  id         TEXT PRIMARY KEY NOT NULL,
  org_id     TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  name       TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  email      TEXT NOT NULL CHECK (email = lower(email) AND email LIKE '%_@_%._%' AND email NOT GLOB '*[ ' || char(9) || char(10) || char(13) || ']*' AND length(email)-length(replace(email,'@','')) = 1),
  company    TEXT NOT NULL DEFAULT '' CHECK (length(company) <= 120),
  status     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (org_id, id),
  UNIQUE (org_id, email),
  CHECK (created_at IS NULL OR (typeof(created_at) = 'text' AND length(created_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at)),
  CHECK (updated_at IS NULL OR (typeof(updated_at) = 'text' AND length(updated_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) = updated_at))
);

CREATE TABLE wallets (
  id                  TEXT PRIMARY KEY NOT NULL,
  purpose             TEXT NOT NULL CHECK (purpose IN ('login', 'payout', 'customer')),
  org_id              TEXT REFERENCES organizations (id) ON DELETE CASCADE,
  user_id             TEXT REFERENCES users (id) ON DELETE CASCADE,
  customer_id         TEXT,
  address             TEXT NOT NULL CHECK ((length(address) = 42 AND substr(address,1,2) = '0x' AND substr(address,3) NOT GLOB '*[^0-9a-f]*')),  
  chain_id            INTEGER NOT NULL CHECK (chain_id > 0) CHECK (chain_id <= 9007199254740991),
  label               TEXT NOT NULL DEFAULT '' CHECK (length(label) <= 80),
  verified_at         TEXT,
  verification_method TEXT CHECK (verification_method IN ('siwe')),
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, customer_id) REFERENCES customers (org_id, id) ON DELETE CASCADE,
  CONSTRAINT wallets_purpose_shape CHECK (
    (purpose = 'login' AND user_id IS NOT NULL AND org_id IS NULL AND customer_id IS NULL AND verified_at IS NOT NULL)
    OR (purpose = 'payout' AND org_id IS NOT NULL AND customer_id IS NULL AND user_id IS NULL)
    OR (purpose = 'customer' AND org_id IS NOT NULL AND customer_id IS NOT NULL AND user_id IS NULL)
  ),
  CHECK (verified_at IS NULL OR (typeof(verified_at) = 'text' AND length(verified_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', verified_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ', verified_at) = verified_at)),
  CHECK (created_at IS NULL OR (typeof(created_at) = 'text' AND length(created_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at)),
  CHECK (updated_at IS NULL OR (typeof(updated_at) = 'text' AND length(updated_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) = updated_at))
);

CREATE UNIQUE INDEX wallets_login_address_key ON wallets (address) WHERE purpose = 'login';

CREATE UNIQUE INDEX wallets_payout_key ON wallets (org_id, address, chain_id) WHERE purpose = 'payout';

CREATE UNIQUE INDEX wallets_customer_key ON wallets (org_id, customer_id, address, chain_id) WHERE purpose = 'customer';

CREATE INDEX wallets_user_idx ON wallets (user_id) WHERE user_id IS NOT NULL;

CREATE TABLE subscriptions (
  id                   TEXT PRIMARY KEY NOT NULL,
  org_id               TEXT NOT NULL,
  customer_id          TEXT NOT NULL,
  plan_id              TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'incomplete'
                       CHECK (status IN ('incomplete', 'trialing', 'active', 'past_due', 'paused', 'canceled')),
  amount               TEXT NOT NULL ,   
  "interval"           TEXT NOT NULL CHECK ("interval" IN ('week', 'month', 'year')),
  current_period_start TEXT,
  current_period_end   TEXT,
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0 CHECK (cancel_at_period_end IN (0,1)),
  canceled_at          TEXT,
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, customer_id) REFERENCES customers (org_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (org_id, plan_id) REFERENCES plans (org_id, id) ON DELETE RESTRICT,
  CHECK (typeof(amount) = 'text' AND length(amount) BETWEEN 1 AND 19 AND amount NOT GLOB '*[^0-9]*' AND (amount = '0' OR substr(amount,1,1) BETWEEN '1' AND '9') AND (length(amount) < 19 OR amount <= '9223372036854775807') AND amount <> '0'),
  CHECK (current_period_start IS NULL OR (typeof(current_period_start) = 'text' AND length(current_period_start) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', current_period_start) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ', current_period_start) = current_period_start)),
  CHECK (current_period_end IS NULL OR (typeof(current_period_end) = 'text' AND length(current_period_end) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', current_period_end) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ', current_period_end) = current_period_end)),
  CHECK (canceled_at IS NULL OR (typeof(canceled_at) = 'text' AND length(canceled_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', canceled_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ', canceled_at) = canceled_at)),
  CHECK (created_at IS NULL OR (typeof(created_at) = 'text' AND length(created_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at)),
  CHECK (updated_at IS NULL OR (typeof(updated_at) = 'text' AND length(updated_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) = updated_at))
);

CREATE INDEX subscriptions_org_status_idx ON subscriptions (org_id, status);

CREATE INDEX subscriptions_customer_idx ON subscriptions (customer_id);

CREATE TABLE mandates (
  id                    TEXT PRIMARY KEY NOT NULL,
  org_id                TEXT NOT NULL,
  subscription_id       TEXT NOT NULL,
  customer_id           TEXT NOT NULL,
  payer_address         TEXT NOT NULL CHECK ((length(payer_address) = 42 AND substr(payer_address,1,2) = '0x' AND substr(payer_address,3) NOT GLOB '*[^0-9a-f]*')),
  chain_id              INTEGER NOT NULL CHECK (chain_id > 0) CHECK (chain_id <= 9007199254740991),
  token_address         TEXT NOT NULL CHECK ((length(token_address) = 42 AND substr(token_address,1,2) = '0x' AND substr(token_address,3) NOT GLOB '*[^0-9a-f]*')),
  max_amount_per_period TEXT NOT NULL ,
  period_seconds        INTEGER NOT NULL CHECK (period_seconds > 0),
  status                TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'revoked', 'expired')),
  contract_address      TEXT CHECK ((length(contract_address) = 42 AND substr(contract_address,1,2) = '0x' AND substr(contract_address,3) NOT GLOB '*[^0-9a-f]*')),
  onchain_ref           TEXT,
  valid_from            TEXT,
  valid_until           TEXT,
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, subscription_id) REFERENCES subscriptions (org_id, id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, customer_id) REFERENCES customers (org_id, id) ON DELETE RESTRICT,
  CHECK (typeof(max_amount_per_period) = 'text' AND length(max_amount_per_period) BETWEEN 1 AND 19 AND max_amount_per_period NOT GLOB '*[^0-9]*' AND (max_amount_per_period = '0' OR substr(max_amount_per_period,1,1) BETWEEN '1' AND '9') AND (length(max_amount_per_period) < 19 OR max_amount_per_period <= '9223372036854775807') AND max_amount_per_period <> '0'),
  CHECK (valid_from IS NULL OR (typeof(valid_from) = 'text' AND length(valid_from) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', valid_from) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ', valid_from) = valid_from)),
  CHECK (valid_until IS NULL OR (typeof(valid_until) = 'text' AND length(valid_until) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', valid_until) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ', valid_until) = valid_until)),
  CHECK (created_at IS NULL OR (typeof(created_at) = 'text' AND length(created_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at)),
  CHECK (updated_at IS NULL OR (typeof(updated_at) = 'text' AND length(updated_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) = updated_at))
);

CREATE INDEX mandates_subscription_idx ON mandates (subscription_id);

CREATE TABLE invoices (
  id              TEXT PRIMARY KEY NOT NULL,
  org_id          TEXT NOT NULL,
  customer_id     TEXT NOT NULL,
  subscription_id TEXT,
  number          TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'open', 'paid', 'void', 'uncollectible')),
  currency        TEXT NOT NULL DEFAULT 'USDC' CHECK (currency = 'USDC'),
  total_amount    TEXT NOT NULL ,
  amount_paid     TEXT NOT NULL DEFAULT '0',
  line_items      TEXT NOT NULL CHECK (json_valid(line_items) AND json_type(line_items) = 'array'),
  memo            TEXT NOT NULL DEFAULT '' CHECK (length(memo) <= 1000),
  period_start    TEXT,
  issued_at       TEXT,
  due_at          TEXT NOT NULL,
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  request_hash    TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (org_id, id),
  UNIQUE (org_id, number),
  UNIQUE (org_id, idempotency_key),
  FOREIGN KEY (org_id, customer_id) REFERENCES customers (org_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (org_id, subscription_id) REFERENCES subscriptions (org_id, id) ON DELETE RESTRICT,
  CHECK (typeof(total_amount) = 'text' AND length(total_amount) BETWEEN 1 AND 19 AND total_amount NOT GLOB '*[^0-9]*' AND (total_amount = '0' OR substr(total_amount,1,1) BETWEEN '1' AND '9') AND (length(total_amount) < 19 OR total_amount <= '9223372036854775807') AND total_amount <> '0'),
  CHECK (typeof(amount_paid) = 'text' AND length(amount_paid) BETWEEN 1 AND 19 AND amount_paid NOT GLOB '*[^0-9]*' AND (amount_paid = '0' OR substr(amount_paid,1,1) BETWEEN '1' AND '9') AND (length(amount_paid) < 19 OR amount_paid <= '9223372036854775807')),
  CHECK (length(amount_paid) < length(total_amount) OR (length(amount_paid) = length(total_amount) AND amount_paid <= total_amount)),
  CHECK (period_start IS NULL OR (typeof(period_start) = 'text' AND length(period_start) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', period_start) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ', period_start) = period_start)),
  CHECK (issued_at IS NULL OR (typeof(issued_at) = 'text' AND length(issued_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', issued_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ', issued_at) = issued_at)),
  CHECK (due_at IS NULL OR (typeof(due_at) = 'text' AND length(due_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', due_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ', due_at) = due_at)),
  CHECK (created_at IS NULL OR (typeof(created_at) = 'text' AND length(created_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at)),
  CHECK (updated_at IS NULL OR (typeof(updated_at) = 'text' AND length(updated_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) = updated_at))
);

CREATE UNIQUE INDEX invoices_subscription_period_key ON invoices (org_id, subscription_id, period_start)
  WHERE subscription_id IS NOT NULL AND period_start IS NOT NULL;

CREATE INDEX invoices_org_status_idx ON invoices (org_id, status, due_at);

CREATE INDEX invoices_customer_idx ON invoices (customer_id);

CREATE TABLE payments (
  id              TEXT PRIMARY KEY NOT NULL,
  org_id          TEXT NOT NULL,
  invoice_id      TEXT NOT NULL,
  customer_id     TEXT NOT NULL,
  amount          TEXT NOT NULL ,
  currency        TEXT NOT NULL DEFAULT 'USDC' CHECK (currency = 'USDC'),
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'processing', 'succeeded', 'failed', 'canceled')),
  chain_id        INTEGER NOT NULL CHECK (chain_id > 0) CHECK (chain_id <= 9007199254740991),
  payer_address   TEXT CHECK ((length(payer_address) = 42 AND substr(payer_address,1,2) = '0x' AND substr(payer_address,3) NOT GLOB '*[^0-9a-f]*')),
  tx_hash         TEXT CHECK ((length(tx_hash) = 66 AND substr(tx_hash,1,2) = '0x' AND substr(tx_hash,3) NOT GLOB '*[^0-9a-f]*')),
  failure_reason  TEXT,
  confirmed_at    TEXT,
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  request_hash    TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (org_id, id),
  UNIQUE (org_id, idempotency_key),
  FOREIGN KEY (org_id, invoice_id) REFERENCES invoices (org_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (org_id, customer_id) REFERENCES customers (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT payments_succeeded_has_tx CHECK (status <> 'succeeded' OR (tx_hash IS NOT NULL AND confirmed_at IS NOT NULL)),
  CHECK (typeof(amount) = 'text' AND length(amount) BETWEEN 1 AND 19 AND amount NOT GLOB '*[^0-9]*' AND (amount = '0' OR substr(amount,1,1) BETWEEN '1' AND '9') AND (length(amount) < 19 OR amount <= '9223372036854775807') AND amount <> '0'),
  CHECK (confirmed_at IS NULL OR (typeof(confirmed_at) = 'text' AND length(confirmed_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', confirmed_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ', confirmed_at) = confirmed_at)),
  CHECK (created_at IS NULL OR (typeof(created_at) = 'text' AND length(created_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at)),
  CHECK (updated_at IS NULL OR (typeof(updated_at) = 'text' AND length(updated_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) = updated_at))
);

CREATE UNIQUE INDEX payments_one_live_per_invoice ON payments (invoice_id)
  WHERE status IN ('pending', 'processing', 'succeeded');

CREATE UNIQUE INDEX payments_tx_key ON payments (chain_id, tx_hash) WHERE tx_hash IS NOT NULL;

CREATE INDEX payments_org_status_idx ON payments (org_id, status, created_at DESC);

CREATE TABLE escrows (
  id               TEXT PRIMARY KEY NOT NULL,
  org_id           TEXT NOT NULL,
  invoice_id       TEXT NOT NULL,
  customer_id      TEXT NOT NULL,
  payment_id       TEXT,
  amount           TEXT NOT NULL ,
  currency         TEXT NOT NULL DEFAULT 'USDC' CHECK (currency = 'USDC'),
  status           TEXT NOT NULL DEFAULT 'pending_funding'
                   CHECK (status IN ('pending_funding', 'funded', 'released', 'refunded', 'settled', 'disputed')),
  release_after_days INTEGER NOT NULL DEFAULT 0 CHECK (release_after_days BETWEEN 0 AND 90),
  release_at       TEXT,
  chain_id         INTEGER NOT NULL CHECK (chain_id > 0) CHECK (chain_id <= 9007199254740991),
  contract_address TEXT CHECK ((length(contract_address) = 42 AND substr(contract_address,1,2) = '0x' AND substr(contract_address,3) NOT GLOB '*[^0-9a-f]*')),
  onchain_escrow_id TEXT,
  funded_tx_hash   TEXT CHECK ((length(funded_tx_hash) = 66 AND substr(funded_tx_hash,1,2) = '0x' AND substr(funded_tx_hash,3) NOT GLOB '*[^0-9a-f]*')),
  settled_tx_hash  TEXT CHECK ((length(settled_tx_hash) = 66 AND substr(settled_tx_hash,1,2) = '0x' AND substr(settled_tx_hash,3) NOT GLOB '*[^0-9a-f]*')),
  idempotency_key  TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  request_hash     TEXT NOT NULL,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (org_id, id),
  UNIQUE (org_id, idempotency_key),
  FOREIGN KEY (org_id, invoice_id) REFERENCES invoices (org_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (org_id, customer_id) REFERENCES customers (org_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (org_id, payment_id) REFERENCES payments (org_id, id) ON DELETE RESTRICT,
  CHECK (typeof(amount) = 'text' AND length(amount) BETWEEN 1 AND 19 AND amount NOT GLOB '*[^0-9]*' AND (amount = '0' OR substr(amount,1,1) BETWEEN '1' AND '9') AND (length(amount) < 19 OR amount <= '9223372036854775807') AND amount <> '0'),
  CHECK (release_at IS NULL OR (typeof(release_at) = 'text' AND length(release_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', release_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ', release_at) = release_at)),
  CHECK (created_at IS NULL OR (typeof(created_at) = 'text' AND length(created_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at)),
  CHECK (updated_at IS NULL OR (typeof(updated_at) = 'text' AND length(updated_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) = updated_at))
);

CREATE UNIQUE INDEX escrows_one_live_per_invoice ON escrows (invoice_id)
  WHERE status IN ('pending_funding', 'funded', 'disputed');

CREATE INDEX escrows_org_status_idx ON escrows (org_id, status);

CREATE TABLE transactions (
  id           TEXT PRIMARY KEY NOT NULL,
  org_id       TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('payment', 'escrow_fund', 'escrow_release', 'escrow_refund', 'payout', 'refund')),
  direction    TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  amount       TEXT NOT NULL ,
  chain_id     INTEGER NOT NULL CHECK (chain_id > 0) CHECK (chain_id <= 9007199254740991),
  tx_hash      TEXT NOT NULL CHECK ((length(tx_hash) = 66 AND substr(tx_hash,1,2) = '0x' AND substr(tx_hash,3) NOT GLOB '*[^0-9a-f]*')),
  log_index    INTEGER NOT NULL CHECK (log_index >= 0),
  block_number INTEGER NOT NULL CHECK (block_number >= 0) CHECK (block_number <= 9007199254740991),
  from_address TEXT CHECK ((length(from_address) = 42 AND substr(from_address,1,2) = '0x' AND substr(from_address,3) NOT GLOB '*[^0-9a-f]*')),
  to_address   TEXT CHECK ((length(to_address) = 42 AND substr(to_address,1,2) = '0x' AND substr(to_address,3) NOT GLOB '*[^0-9a-f]*')),
  payment_id   TEXT,
  escrow_id    TEXT,
  status       TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'reverted')),
  occurred_at  TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (org_id, id),
  UNIQUE (chain_id, tx_hash, log_index),         
  FOREIGN KEY (org_id, payment_id) REFERENCES payments (org_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (org_id, escrow_id) REFERENCES escrows (org_id, id) ON DELETE RESTRICT,
  CHECK (typeof(amount) = 'text' AND length(amount) BETWEEN 1 AND 19 AND amount NOT GLOB '*[^0-9]*' AND (amount = '0' OR substr(amount,1,1) BETWEEN '1' AND '9') AND (length(amount) < 19 OR amount <= '9223372036854775807') AND amount <> '0'),
  CHECK (occurred_at IS NULL OR (typeof(occurred_at) = 'text' AND length(occurred_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', occurred_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ', occurred_at) = occurred_at)),
  CHECK (created_at IS NULL OR (typeof(created_at) = 'text' AND length(created_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at)),
  CHECK (updated_at IS NULL OR (typeof(updated_at) = 'text' AND length(updated_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) = updated_at))
);

CREATE INDEX transactions_org_time_idx ON transactions (org_id, occurred_at DESC);

CREATE TABLE disputes (
  id              TEXT PRIMARY KEY NOT NULL,
  org_id          TEXT NOT NULL,
  invoice_id      TEXT NOT NULL,
  customer_id     TEXT NOT NULL,
  payment_id      TEXT,
  escrow_id       TEXT,
  amount          TEXT NOT NULL ,
  reason          TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 2000),
  status          TEXT NOT NULL DEFAULT 'needs_response' CHECK (status IN ('needs_response', 'under_review', 'resolved', 'withdrawn')),
  respond_by      TEXT NOT NULL,
  resolution_note TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, invoice_id) REFERENCES invoices (org_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (org_id, customer_id) REFERENCES customers (org_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (org_id, payment_id) REFERENCES payments (org_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (org_id, escrow_id) REFERENCES escrows (org_id, id) ON DELETE RESTRICT,
  CHECK (typeof(amount) = 'text' AND length(amount) BETWEEN 1 AND 19 AND amount NOT GLOB '*[^0-9]*' AND (amount = '0' OR substr(amount,1,1) BETWEEN '1' AND '9') AND (length(amount) < 19 OR amount <= '9223372036854775807') AND amount <> '0'),
  CHECK (respond_by IS NULL OR (typeof(respond_by) = 'text' AND length(respond_by) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', respond_by) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ', respond_by) = respond_by)),
  CHECK (created_at IS NULL OR (typeof(created_at) = 'text' AND length(created_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at)),
  CHECK (updated_at IS NULL OR (typeof(updated_at) = 'text' AND length(updated_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) = updated_at))
);

CREATE INDEX disputes_org_status_idx ON disputes (org_id, status);

CREATE TABLE api_keys (
  id           TEXT PRIMARY KEY NOT NULL,
  org_id       TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  created_by   TEXT NOT NULL REFERENCES users (id),
  name         TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  prefix       TEXT NOT NULL UNIQUE,            
  key_hash     TEXT NOT NULL,                   
  scopes       TEXT NOT NULL DEFAULT '["read"]' CHECK (json_valid(scopes) AND json_type(scopes) = 'array'),
  last_used_at TEXT,
  expires_at   TEXT,
  revoked_at   TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (org_id, id),
  CHECK (last_used_at IS NULL OR (typeof(last_used_at) = 'text' AND length(last_used_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', last_used_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ', last_used_at) = last_used_at)),
  CHECK (expires_at IS NULL OR (typeof(expires_at) = 'text' AND length(expires_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', expires_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ', expires_at) = expires_at)),
  CHECK (revoked_at IS NULL OR (typeof(revoked_at) = 'text' AND length(revoked_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', revoked_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ', revoked_at) = revoked_at)),
  CHECK (created_at IS NULL OR (typeof(created_at) = 'text' AND length(created_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at)),
  CHECK (updated_at IS NULL OR (typeof(updated_at) = 'text' AND length(updated_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) = updated_at))
);

CREATE INDEX api_keys_org_idx ON api_keys (org_id) WHERE revoked_at IS NULL;

CREATE TABLE webhooks (
  id                        TEXT PRIMARY KEY NOT NULL,
  org_id                    TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  url                       TEXT NOT NULL CHECK (substr(url,1,8) = 'https://'),
  description               TEXT NOT NULL DEFAULT '',
  events                    TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(events) AND json_type(events) = 'array'),
  status                    TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  signing_secret_ciphertext TEXT NOT NULL,
  created_at                TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at                TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (org_id, id),
  CHECK (created_at IS NULL OR (typeof(created_at) = 'text' AND length(created_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at)),
  CHECK (updated_at IS NULL OR (typeof(updated_at) = 'text' AND length(updated_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) = updated_at))
);

CREATE TABLE webhook_deliveries (
  id               TEXT PRIMARY KEY NOT NULL,
  org_id           TEXT NOT NULL,
  webhook_id       TEXT NOT NULL,
  event_id         TEXT NOT NULL,
  event_type       TEXT NOT NULL,
  payload          TEXT NOT NULL CHECK (json_valid(payload)),
  status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'failed')),
  attempts         INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at  TEXT,
  response_status  INTEGER,
  last_error       TEXT,
  delivered_at     TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (webhook_id, event_id),               
  FOREIGN KEY (org_id, webhook_id) REFERENCES webhooks (org_id, id) ON DELETE CASCADE,
  CHECK (next_attempt_at IS NULL OR (typeof(next_attempt_at) = 'text' AND length(next_attempt_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', next_attempt_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ', next_attempt_at) = next_attempt_at)),
  CHECK (delivered_at IS NULL OR (typeof(delivered_at) = 'text' AND length(delivered_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', delivered_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ', delivered_at) = delivered_at)),
  CHECK (created_at IS NULL OR (typeof(created_at) = 'text' AND length(created_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at)),
  CHECK (updated_at IS NULL OR (typeof(updated_at) = 'text' AND length(updated_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) = updated_at))
);

CREATE INDEX webhook_deliveries_due_idx ON webhook_deliveries (next_attempt_at) WHERE status = 'pending';

CREATE TABLE audit_logs (
  id            TEXT PRIMARY KEY NOT NULL,
  org_id        TEXT,
  actor_user_id TEXT,
  actor_type    TEXT NOT NULL CHECK (actor_type IN ('user', 'system', 'api_key', 'chain')),
  action        TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id   TEXT,
  metadata      TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata)),
  ip            TEXT,
  user_agent    TEXT,
  request_id    TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (created_at IS NULL OR (typeof(created_at) = 'text' AND length(created_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at)),
  CHECK (updated_at IS NULL OR (typeof(updated_at) = 'text' AND length(updated_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) = updated_at))
);

CREATE INDEX audit_logs_org_time_idx ON audit_logs (org_id, created_at DESC);

CREATE INDEX audit_logs_resource_idx ON audit_logs (resource_type, resource_id);

CREATE TABLE rate_limits (key TEXT PRIMARY KEY NOT NULL, count INTEGER NOT NULL DEFAULT 0 CHECK (count >= 0), reset_at TEXT NOT NULL);
CREATE INDEX rate_limits_reset_idx ON rate_limits (reset_at);

CREATE TRIGGER users_updated AFTER UPDATE ON users WHEN NEW.updated_at = OLD.updated_at BEGIN UPDATE users SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = NEW.id; END;

CREATE TRIGGER sessions_updated AFTER UPDATE ON sessions WHEN NEW.updated_at = OLD.updated_at BEGIN UPDATE sessions SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = NEW.id; END;

CREATE TRIGGER email_tokens_updated AFTER UPDATE ON email_tokens WHEN NEW.updated_at = OLD.updated_at BEGIN UPDATE email_tokens SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = NEW.id; END;

CREATE TRIGGER siwe_nonces_updated AFTER UPDATE ON siwe_nonces WHEN NEW.updated_at = OLD.updated_at BEGIN UPDATE siwe_nonces SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = NEW.id; END;

CREATE TRIGGER organizations_updated AFTER UPDATE ON organizations WHEN NEW.updated_at = OLD.updated_at BEGIN UPDATE organizations SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = NEW.id; END;

CREATE TRIGGER memberships_updated AFTER UPDATE ON memberships WHEN NEW.updated_at = OLD.updated_at BEGIN UPDATE memberships SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = NEW.id; END;

CREATE TRIGGER products_updated AFTER UPDATE ON products WHEN NEW.updated_at = OLD.updated_at BEGIN UPDATE products SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = NEW.id; END;

CREATE TRIGGER plans_updated AFTER UPDATE ON plans WHEN NEW.updated_at = OLD.updated_at BEGIN UPDATE plans SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = NEW.id; END;

CREATE TRIGGER customers_updated AFTER UPDATE ON customers WHEN NEW.updated_at = OLD.updated_at BEGIN UPDATE customers SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = NEW.id; END;

CREATE TRIGGER wallets_updated AFTER UPDATE ON wallets WHEN NEW.updated_at = OLD.updated_at BEGIN UPDATE wallets SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = NEW.id; END;

CREATE TRIGGER subscriptions_updated AFTER UPDATE ON subscriptions WHEN NEW.updated_at = OLD.updated_at BEGIN UPDATE subscriptions SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = NEW.id; END;

CREATE TRIGGER mandates_updated AFTER UPDATE ON mandates WHEN NEW.updated_at = OLD.updated_at BEGIN UPDATE mandates SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = NEW.id; END;

CREATE TRIGGER invoices_updated AFTER UPDATE ON invoices WHEN NEW.updated_at = OLD.updated_at BEGIN UPDATE invoices SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = NEW.id; END;

CREATE TRIGGER payments_updated AFTER UPDATE ON payments WHEN NEW.updated_at = OLD.updated_at BEGIN UPDATE payments SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = NEW.id; END;

CREATE TRIGGER escrows_updated AFTER UPDATE ON escrows WHEN NEW.updated_at = OLD.updated_at BEGIN UPDATE escrows SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = NEW.id; END;

CREATE TRIGGER transactions_updated AFTER UPDATE ON transactions WHEN NEW.updated_at = OLD.updated_at BEGIN UPDATE transactions SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = NEW.id; END;

CREATE TRIGGER disputes_updated AFTER UPDATE ON disputes WHEN NEW.updated_at = OLD.updated_at BEGIN UPDATE disputes SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = NEW.id; END;

CREATE TRIGGER api_keys_updated AFTER UPDATE ON api_keys WHEN NEW.updated_at = OLD.updated_at BEGIN UPDATE api_keys SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = NEW.id; END;

CREATE TRIGGER webhooks_updated AFTER UPDATE ON webhooks WHEN NEW.updated_at = OLD.updated_at BEGIN UPDATE webhooks SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = NEW.id; END;

CREATE TRIGGER webhook_deliveries_updated AFTER UPDATE ON webhook_deliveries WHEN NEW.updated_at = OLD.updated_at BEGIN UPDATE webhook_deliveries SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = NEW.id; END;
