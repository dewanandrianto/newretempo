-- 0005_billing: invoices, payments, escrows, transactions, disputes.
-- Money is BIGINT USDC base units. Idempotency keys are unique per organization.

CREATE TABLE invoices (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID NOT NULL,
  customer_id     UUID NOT NULL,
  subscription_id UUID,
  number          TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'open', 'paid', 'void', 'uncollectible')),
  currency        TEXT NOT NULL DEFAULT 'USDC' CHECK (currency = 'USDC'),
  total_amount    BIGINT NOT NULL CHECK (total_amount > 0),
  amount_paid     BIGINT NOT NULL DEFAULT 0 CHECK (amount_paid >= 0 AND amount_paid <= total_amount),
  line_items      JSONB NOT NULL CHECK (jsonb_typeof(line_items) = 'array'),
  memo            TEXT NOT NULL DEFAULT '' CHECK (length(memo) <= 1000),
  period_start    TIMESTAMPTZ,
  issued_at       TIMESTAMPTZ,
  due_at          TIMESTAMPTZ NOT NULL,
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  request_hash    TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (org_id, number),
  UNIQUE (org_id, idempotency_key),
  FOREIGN KEY (org_id, customer_id) REFERENCES customers (org_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (org_id, subscription_id) REFERENCES subscriptions (org_id, id) ON DELETE RESTRICT
);
-- One invoice per subscription billing period.
CREATE UNIQUE INDEX invoices_subscription_period_key ON invoices (org_id, subscription_id, period_start)
  WHERE subscription_id IS NOT NULL AND period_start IS NOT NULL;
CREATE INDEX invoices_org_status_idx ON invoices (org_id, status, due_at);
CREATE INDEX invoices_customer_idx ON invoices (customer_id);

CREATE TABLE payments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID NOT NULL,
  invoice_id      UUID NOT NULL,
  customer_id     UUID NOT NULL,
  amount          BIGINT NOT NULL CHECK (amount > 0),
  currency        TEXT NOT NULL DEFAULT 'USDC' CHECK (currency = 'USDC'),
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'processing', 'succeeded', 'failed', 'canceled')),
  chain_id        BIGINT NOT NULL CHECK (chain_id > 0),
  payer_address   TEXT CHECK (payer_address ~ '^0x[0-9a-f]{40}$'),
  tx_hash         TEXT CHECK (tx_hash ~ '^0x[0-9a-f]{64}$'),
  failure_reason  TEXT,
  confirmed_at    TIMESTAMPTZ,
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  request_hash    TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (org_id, idempotency_key),
  FOREIGN KEY (org_id, invoice_id) REFERENCES invoices (org_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (org_id, customer_id) REFERENCES customers (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT payments_succeeded_has_tx CHECK (status <> 'succeeded' OR (tx_hash IS NOT NULL AND confirmed_at IS NOT NULL))
);
-- At most one live payment per invoice: blocks duplicate payment creation.
CREATE UNIQUE INDEX payments_one_live_per_invoice ON payments (invoice_id)
  WHERE status IN ('pending', 'processing', 'succeeded');
CREATE UNIQUE INDEX payments_tx_key ON payments (chain_id, tx_hash) WHERE tx_hash IS NOT NULL;
CREATE INDEX payments_org_status_idx ON payments (org_id, status, created_at DESC);

CREATE TABLE escrows (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           UUID NOT NULL,
  invoice_id       UUID NOT NULL,
  customer_id      UUID NOT NULL,
  payment_id       UUID,
  amount           BIGINT NOT NULL CHECK (amount > 0),
  currency         TEXT NOT NULL DEFAULT 'USDC' CHECK (currency = 'USDC'),
  status           TEXT NOT NULL DEFAULT 'pending_funding'
                   CHECK (status IN ('pending_funding', 'funded', 'released', 'refunded', 'settled', 'disputed')),
  release_after_days INTEGER NOT NULL DEFAULT 0 CHECK (release_after_days BETWEEN 0 AND 90),
  release_at       TIMESTAMPTZ,
  chain_id         BIGINT NOT NULL CHECK (chain_id > 0),
  contract_address TEXT CHECK (contract_address ~ '^0x[0-9a-f]{40}$'),
  onchain_escrow_id TEXT,
  funded_tx_hash   TEXT CHECK (funded_tx_hash ~ '^0x[0-9a-f]{64}$'),
  settled_tx_hash  TEXT CHECK (settled_tx_hash ~ '^0x[0-9a-f]{64}$'),
  idempotency_key  TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  request_hash     TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (org_id, idempotency_key),
  FOREIGN KEY (org_id, invoice_id) REFERENCES invoices (org_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (org_id, customer_id) REFERENCES customers (org_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (org_id, payment_id) REFERENCES payments (org_id, id) ON DELETE RESTRICT
);
-- One live escrow per invoice.
CREATE UNIQUE INDEX escrows_one_live_per_invoice ON escrows (invoice_id)
  WHERE status IN ('pending_funding', 'funded', 'disputed');
CREATE INDEX escrows_org_status_idx ON escrows (org_id, status);

-- Verified onchain events. Written only by authoritative (chain-event) code paths.
CREATE TABLE transactions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       UUID NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('payment', 'escrow_fund', 'escrow_release', 'escrow_refund', 'payout', 'refund')),
  direction    TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  amount       BIGINT NOT NULL CHECK (amount > 0),
  chain_id     BIGINT NOT NULL CHECK (chain_id > 0),
  tx_hash      TEXT NOT NULL CHECK (tx_hash ~ '^0x[0-9a-f]{64}$'),
  log_index    INTEGER NOT NULL CHECK (log_index >= 0),
  block_number BIGINT NOT NULL CHECK (block_number >= 0),
  from_address TEXT CHECK (from_address ~ '^0x[0-9a-f]{40}$'),
  to_address   TEXT CHECK (to_address ~ '^0x[0-9a-f]{40}$'),
  payment_id   UUID,
  escrow_id    UUID,
  status       TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'reverted')),
  occurred_at  TIMESTAMPTZ NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (chain_id, tx_hash, log_index),         -- a chain event can be ingested exactly once
  FOREIGN KEY (org_id, payment_id) REFERENCES payments (org_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (org_id, escrow_id) REFERENCES escrows (org_id, id) ON DELETE RESTRICT
);
CREATE INDEX transactions_org_time_idx ON transactions (org_id, occurred_at DESC);

CREATE TABLE disputes (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID NOT NULL,
  invoice_id      UUID NOT NULL,
  customer_id     UUID NOT NULL,
  payment_id      UUID,
  escrow_id       UUID,
  amount          BIGINT NOT NULL CHECK (amount > 0),
  reason          TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 2000),
  status          TEXT NOT NULL DEFAULT 'needs_response' CHECK (status IN ('needs_response', 'under_review', 'resolved', 'withdrawn')),
  respond_by      TIMESTAMPTZ NOT NULL,
  resolution_note TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, invoice_id) REFERENCES invoices (org_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (org_id, customer_id) REFERENCES customers (org_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (org_id, payment_id) REFERENCES payments (org_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (org_id, escrow_id) REFERENCES escrows (org_id, id) ON DELETE RESTRICT
);
CREATE INDEX disputes_org_status_idx ON disputes (org_id, status);

CREATE TRIGGER invoices_updated BEFORE UPDATE ON invoices FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER payments_updated BEFORE UPDATE ON payments FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER escrows_updated BEFORE UPDATE ON escrows FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER transactions_updated BEFORE UPDATE ON transactions FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER disputes_updated BEFORE UPDATE ON disputes FOR EACH ROW EXECUTE FUNCTION set_updated_at();
