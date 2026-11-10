-- Phase 2 deliberately has NO authoritative bypass, flag table, connection flag,
-- request binding, or event-ingestion API. Only a reviewed future migration may
-- introduce an isolated verified-event writer. All ledger writes are denied.
CREATE TRIGGER audit_logs_no_update BEFORE UPDATE ON audit_logs BEGIN SELECT RAISE(ABORT, 'audit_logs is append-only'); END;
CREATE TRIGGER audit_logs_no_delete BEFORE DELETE ON audit_logs BEGIN SELECT RAISE(ABORT, 'audit_logs is append-only'); END;
CREATE TRIGGER audit_logs_no_replace BEFORE INSERT ON audit_logs WHEN EXISTS (SELECT 1 FROM audit_logs WHERE id = NEW.id) BEGIN SELECT RAISE(ABORT, 'audit_logs is append-only'); END;

CREATE TRIGGER memberships_keep_owner_delete BEFORE DELETE ON memberships
WHEN OLD.role = 'owner' AND EXISTS (SELECT 1 FROM organizations WHERE id = OLD.org_id)
AND NOT EXISTS (SELECT 1 FROM memberships WHERE org_id = OLD.org_id AND role = 'owner' AND id <> OLD.id)
BEGIN SELECT RAISE(ABORT, 'organization must keep at least one owner'); END;
CREATE TRIGGER memberships_keep_owner_update BEFORE UPDATE ON memberships
WHEN OLD.role = 'owner' AND (NEW.role <> 'owner' OR NEW.org_id IS NOT OLD.org_id)
AND EXISTS (SELECT 1 FROM organizations WHERE id = OLD.org_id)
AND NOT EXISTS (SELECT 1 FROM memberships WHERE org_id = OLD.org_id AND role = 'owner' AND id <> OLD.id)
BEGIN SELECT RAISE(ABORT, 'organization must keep at least one owner'); END;
CREATE TRIGGER memberships_no_replace BEFORE INSERT ON memberships
WHEN EXISTS (SELECT 1 FROM memberships WHERE (id = NEW.id OR (org_id = NEW.org_id AND user_id = NEW.user_id)) AND role = 'owner')
BEGIN SELECT RAISE(ABORT, 'owner memberships cannot be replaced'); END;

CREATE TRIGGER escrows_guard_insert BEFORE INSERT ON escrows
WHEN NEW.status <> 'pending_funding' OR NEW.payment_id IS NOT NULL OR NEW.release_at IS NOT NULL
OR NEW.contract_address IS NOT NULL OR NEW.onchain_escrow_id IS NOT NULL
OR NEW.funded_tx_hash IS NOT NULL OR NEW.settled_tx_hash IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'chain_controlled: escrows can only be created as pending_funding without chain references'); END;
CREATE TRIGGER escrows_guard_delete BEFORE DELETE ON escrows WHEN OLD.status <> 'pending_funding'
BEGIN SELECT RAISE(ABORT, 'chain_controlled: only unfunded escrow records can be deleted'); END;
CREATE TRIGGER escrows_guard_update BEFORE UPDATE ON escrows
WHEN NEW.status IS NOT OLD.status OR NEW.amount IS NOT OLD.amount
OR NEW.invoice_id IS NOT OLD.invoice_id OR NEW.customer_id IS NOT OLD.customer_id
OR NEW.payment_id IS NOT OLD.payment_id OR NEW.release_at IS NOT OLD.release_at
OR NEW.contract_address IS NOT OLD.contract_address OR NEW.onchain_escrow_id IS NOT OLD.onchain_escrow_id
OR NEW.funded_tx_hash IS NOT OLD.funded_tx_hash OR NEW.settled_tx_hash IS NOT OLD.settled_tx_hash
OR NEW.chain_id IS NOT OLD.chain_id OR NEW.currency IS NOT OLD.currency
OR (NEW.release_after_days IS NOT OLD.release_after_days AND OLD.status <> 'pending_funding')
BEGIN SELECT RAISE(ABORT, 'chain_controlled: escrow state is controlled by verified chain events'); END;

CREATE TRIGGER payments_guard_insert BEFORE INSERT ON payments
WHEN NEW.status <> 'pending' OR NEW.tx_hash IS NOT NULL OR NEW.confirmed_at IS NOT NULL OR NEW.payer_address IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'chain_controlled: payments can only be created as pending without chain data'); END;
CREATE TRIGGER payments_guard_delete BEFORE DELETE ON payments
BEGIN SELECT RAISE(ABORT, 'chain_controlled: payments cannot be deleted'); END;
CREATE TRIGGER payments_guard_update BEFORE UPDATE ON payments
WHEN NEW.amount IS NOT OLD.amount OR NEW.invoice_id IS NOT OLD.invoice_id OR NEW.customer_id IS NOT OLD.customer_id
OR NEW.tx_hash IS NOT OLD.tx_hash OR NEW.payer_address IS NOT OLD.payer_address OR NEW.confirmed_at IS NOT OLD.confirmed_at
OR NEW.chain_id IS NOT OLD.chain_id OR NEW.currency IS NOT OLD.currency
OR (NEW.status IS NOT OLD.status AND NOT (OLD.status = 'pending' AND NEW.status = 'canceled'))
BEGIN SELECT RAISE(ABORT, 'chain_controlled: payment state is controlled by verified chain events'); END;

CREATE TRIGGER invoices_guard_insert BEFORE INSERT ON invoices
WHEN NEW.status NOT IN ('draft', 'open') OR NEW.amount_paid <> '0'
BEGIN SELECT RAISE(ABORT, 'chain_controlled: invoices are created unpaid'); END;
CREATE TRIGGER invoices_guard_delete BEFORE DELETE ON invoices WHEN OLD.status <> 'draft'
BEGIN SELECT RAISE(ABORT, 'chain_controlled: only draft invoices can be deleted'); END;
CREATE TRIGGER invoices_guard_update BEFORE UPDATE ON invoices
WHEN NEW.amount_paid IS NOT OLD.amount_paid OR (NEW.status = 'paid' AND OLD.status <> 'paid')
OR (OLD.status = 'paid' AND NEW.status IS NOT OLD.status)
OR (OLD.status <> 'draft' AND (NEW.total_amount IS NOT OLD.total_amount OR NEW.line_items IS NOT OLD.line_items OR NEW.customer_id IS NOT OLD.customer_id))
BEGIN SELECT RAISE(ABORT, 'chain_controlled: invoice amounts and paid state are not editable here'); END;

CREATE TRIGGER transactions_guard_insert BEFORE INSERT ON transactions BEGIN SELECT RAISE(ABORT, 'chain_controlled: transactions are written only from verified chain events'); END;
CREATE TRIGGER transactions_guard_update BEFORE UPDATE ON transactions BEGIN SELECT RAISE(ABORT, 'chain_controlled: transactions are written only from verified chain events'); END;
CREATE TRIGGER transactions_guard_delete BEFORE DELETE ON transactions BEGIN SELECT RAISE(ABORT, 'chain_controlled: transactions are written only from verified chain events'); END;

CREATE TRIGGER subscriptions_guard_insert BEFORE INSERT ON subscriptions
WHEN NEW.status <> 'incomplete' OR NEW.current_period_start IS NOT NULL OR NEW.current_period_end IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'chain_controlled: subscription activation requires verified chain events'); END;
CREATE TRIGGER subscriptions_guard_update BEFORE UPDATE ON subscriptions
WHEN NEW.current_period_start IS NOT OLD.current_period_start OR NEW.current_period_end IS NOT OLD.current_period_end
OR (NEW.status IS NOT OLD.status AND NEW.status <> 'canceled')
BEGIN SELECT RAISE(ABORT, 'chain_controlled: subscription activation requires verified chain events'); END;
CREATE TRIGGER mandates_guard_insert BEFORE INSERT ON mandates
WHEN NEW.status <> 'pending' OR NEW.contract_address IS NOT NULL OR NEW.onchain_ref IS NOT NULL OR NEW.valid_from IS NOT NULL OR NEW.valid_until IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'chain_controlled: mandate activation requires verified chain events'); END;
CREATE TRIGGER mandates_guard_update BEFORE UPDATE ON mandates
BEGIN SELECT RAISE(ABORT, 'chain_controlled: mandate changes require verified chain events'); END;

CREATE TRIGGER invoices_immutable_request BEFORE UPDATE ON invoices WHEN NEW.id IS NOT OLD.id OR NEW.org_id IS NOT OLD.org_id OR NEW.idempotency_key IS NOT OLD.idempotency_key OR NEW.request_hash IS NOT OLD.request_hash BEGIN SELECT RAISE(ABORT, 'financial identity and idempotency are immutable'); END;
CREATE TRIGGER invoices_no_replace BEFORE INSERT ON invoices WHEN EXISTS (SELECT 1 FROM invoices WHERE id = NEW.id OR (org_id = NEW.org_id AND (idempotency_key = NEW.idempotency_key OR number = NEW.number))) BEGIN SELECT RAISE(ABORT, 'financial records cannot be replaced'); END;

CREATE TRIGGER payments_immutable_request BEFORE UPDATE ON payments WHEN NEW.id IS NOT OLD.id OR NEW.org_id IS NOT OLD.org_id OR NEW.idempotency_key IS NOT OLD.idempotency_key OR NEW.request_hash IS NOT OLD.request_hash BEGIN SELECT RAISE(ABORT, 'financial identity and idempotency are immutable'); END;
CREATE TRIGGER payments_no_replace BEFORE INSERT ON payments WHEN EXISTS (SELECT 1 FROM payments WHERE id = NEW.id OR (invoice_id = NEW.invoice_id AND status IN ('pending','processing','succeeded')) OR (org_id = NEW.org_id AND (idempotency_key = NEW.idempotency_key))) BEGIN SELECT RAISE(ABORT, 'financial records cannot be replaced'); END;

CREATE TRIGGER escrows_immutable_request BEFORE UPDATE ON escrows WHEN NEW.id IS NOT OLD.id OR NEW.org_id IS NOT OLD.org_id OR NEW.idempotency_key IS NOT OLD.idempotency_key OR NEW.request_hash IS NOT OLD.request_hash BEGIN SELECT RAISE(ABORT, 'financial identity and idempotency are immutable'); END;
CREATE TRIGGER escrows_no_replace BEFORE INSERT ON escrows WHEN EXISTS (SELECT 1 FROM escrows WHERE id = NEW.id OR (invoice_id = NEW.invoice_id AND status IN ('pending_funding','funded','disputed')) OR (org_id = NEW.org_id AND (idempotency_key = NEW.idempotency_key))) BEGIN SELECT RAISE(ABORT, 'financial records cannot be replaced'); END;

CREATE TRIGGER subscriptions_no_replace BEFORE INSERT ON subscriptions WHEN EXISTS (SELECT 1 FROM subscriptions WHERE id = NEW.id) BEGIN SELECT RAISE(ABORT, 'subscriptions cannot be replaced'); END;
CREATE TRIGGER mandates_no_replace BEFORE INSERT ON mandates WHEN EXISTS (SELECT 1 FROM mandates WHERE id = NEW.id) BEGIN SELECT RAISE(ABORT, 'mandates cannot be replaced'); END;
