-- 0001_foundation: shared helpers.
-- Conventions for every migration in this directory:
--   * UUID primary keys (gen_random_uuid()).
--   * created_at / updated_at on every table; updated_at maintained by trigger.
--   * Money is BIGINT USDC base units (6 decimals). Never NUMERIC/FLOAT for balances.
--   * Every tenant-owned table has org_id; cross-table references include org_id
--     in a composite foreign key so a row can never point at another tenant's row.
--   * Closed value sets are TEXT + CHECK (easy to evolve, no enum migrations).

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- True only inside a transaction that ran:
--   SELECT set_config('retempo.authoritative', 'on', true);
-- Phase 3 chain-event processing is the only code allowed to do that. Merchant-facing
-- API code never does, which is what keeps funded / released / settled states
-- unreachable from HTTP requests.
CREATE OR REPLACE FUNCTION retempo_authoritative() RETURNS boolean AS $$
  SELECT coalesce(current_setting('retempo.authoritative', true), '') = 'on';
$$ LANGUAGE sql STABLE;
