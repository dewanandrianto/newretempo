-- 0007_financial_guards: database-level protection for financial state.
-- These triggers are the last line of defence. Even a buggy or compromised API
-- handler cannot mark an escrow funded/released/refunded/settled, mark a payment
-- succeeded, mark an invoice paid or write a ledger row, because those changes are
-- only legal inside a transaction that has switched on retempo.authoritative.
-- Only verified blockchain-event processing (Phase 3) is allowed to do that.

CREATE OR REPLACE FUNCTION audit_logs_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only' USING ERRCODE = '42501';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_logs_no_update BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_logs_immutable();

-- ESCROWS --------------------------------------------------------------------
CREATE OR REPLACE FUNCTION escrows_guard() RETURNS trigger AS $$
BEGIN
  IF retempo_authoritative() THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'pending_funding' OR NEW.payment_id IS NOT NULL OR NEW.release_at IS NOT NULL
       OR NEW.contract_address IS NOT NULL OR NEW.onchain_escrow_id IS NOT NULL
       OR NEW.funded_tx_hash IS NOT NULL OR NEW.settled_tx_hash IS NOT NULL THEN
      RAISE EXCEPTION 'escrows can only be created as pending_funding without chain references' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'pending_funding' THEN
      RAISE EXCEPTION 'only unfunded escrow records can be deleted' USING ERRCODE = '42501';
    END IF;
    RETURN OLD;
  END IF;

  -- UPDATE: merchants may only change release_after_days while unfunded.
  IF NEW.status IS DISTINCT FROM OLD.status
     OR NEW.amount IS DISTINCT FROM OLD.amount
     OR NEW.invoice_id IS DISTINCT FROM OLD.invoice_id
     OR NEW.customer_id IS DISTINCT FROM OLD.customer_id
     OR NEW.payment_id IS DISTINCT FROM OLD.payment_id
     OR NEW.release_at IS DISTINCT FROM OLD.release_at
     OR NEW.contract_address IS DISTINCT FROM OLD.contract_address
     OR NEW.onchain_escrow_id IS DISTINCT FROM OLD.onchain_escrow_id
     OR NEW.funded_tx_hash IS DISTINCT FROM OLD.funded_tx_hash
     OR NEW.settled_tx_hash IS DISTINCT FROM OLD.settled_tx_hash
     OR (NEW.release_after_days IS DISTINCT FROM OLD.release_after_days AND OLD.status <> 'pending_funding') THEN
    RAISE EXCEPTION 'escrow state is controlled by verified chain events' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER escrows_guard_trg BEFORE INSERT OR UPDATE OR DELETE ON escrows
  FOR EACH ROW EXECUTE FUNCTION escrows_guard();

-- PAYMENTS -------------------------------------------------------------------
CREATE OR REPLACE FUNCTION payments_guard() RETURNS trigger AS $$
BEGIN
  IF retempo_authoritative() THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'pending' OR NEW.tx_hash IS NOT NULL OR NEW.confirmed_at IS NOT NULL OR NEW.payer_address IS NOT NULL THEN
      RAISE EXCEPTION 'payments can only be created as pending without chain data' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'payments cannot be deleted' USING ERRCODE = '42501';
  END IF;

  IF NEW.amount IS DISTINCT FROM OLD.amount
     OR NEW.invoice_id IS DISTINCT FROM OLD.invoice_id
     OR NEW.customer_id IS DISTINCT FROM OLD.customer_id
     OR NEW.tx_hash IS DISTINCT FROM OLD.tx_hash
     OR NEW.payer_address IS DISTINCT FROM OLD.payer_address
     OR NEW.confirmed_at IS DISTINCT FROM OLD.confirmed_at
     OR (NEW.status IS DISTINCT FROM OLD.status AND NOT (OLD.status = 'pending' AND NEW.status = 'canceled')) THEN
    RAISE EXCEPTION 'payment state is controlled by verified chain events' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER payments_guard_trg BEFORE INSERT OR UPDATE OR DELETE ON payments
  FOR EACH ROW EXECUTE FUNCTION payments_guard();

-- INVOICES -------------------------------------------------------------------
CREATE OR REPLACE FUNCTION invoices_guard() RETURNS trigger AS $$
BEGIN
  IF retempo_authoritative() THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status NOT IN ('draft', 'open') OR NEW.amount_paid <> 0 THEN
      RAISE EXCEPTION 'invoices are created unpaid' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'only draft invoices can be deleted' USING ERRCODE = '42501';
    END IF;
    RETURN OLD;
  END IF;

  IF NEW.amount_paid IS DISTINCT FROM OLD.amount_paid
     OR (NEW.status = 'paid' AND OLD.status <> 'paid')
     OR (OLD.status = 'paid' AND NEW.status IS DISTINCT FROM OLD.status)
     OR (OLD.status <> 'draft' AND (
          NEW.total_amount IS DISTINCT FROM OLD.total_amount
          OR NEW.line_items IS DISTINCT FROM OLD.line_items
          OR NEW.customer_id IS DISTINCT FROM OLD.customer_id)) THEN
    RAISE EXCEPTION 'invoice amounts and paid state are not editable here' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER invoices_guard_trg BEFORE INSERT OR UPDATE OR DELETE ON invoices
  FOR EACH ROW EXECUTE FUNCTION invoices_guard();

-- TRANSACTIONS (verified chain ledger) -----------------------------------------
CREATE OR REPLACE FUNCTION transactions_guard() RETURNS trigger AS $$
BEGIN
  IF NOT retempo_authoritative() THEN
    RAISE EXCEPTION 'transactions are written only from verified chain events' USING ERRCODE = '42501';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER transactions_guard_trg BEFORE INSERT OR UPDATE OR DELETE ON transactions
  FOR EACH ROW EXECUTE FUNCTION transactions_guard();
