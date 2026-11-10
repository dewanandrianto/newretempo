CREATE TABLE chain_plan_terms (
 org_id TEXT NOT NULL,
 plan_id TEXT NOT NULL,
 preparation TEXT NOT NULL CHECK(json_valid(preparation)),
 PRIMARY KEY(org_id,plan_id),
 FOREIGN KEY(org_id,plan_id) REFERENCES plans(org_id,id) ON DELETE RESTRICT
);
CREATE TRIGGER chain_plan_terms_immutable BEFORE UPDATE ON chain_plan_terms BEGIN SELECT RAISE(ABORT,'chain plan terms are immutable'); END;
CREATE TABLE chain_checkouts (
 id TEXT PRIMARY KEY NOT NULL,
 token_hash TEXT NOT NULL UNIQUE CHECK(length(token_hash)=64),
 org_id TEXT NOT NULL,
 subscription_id TEXT NOT NULL,
 invoice_id TEXT NOT NULL,
 expires_at TEXT NOT NULL,
 FOREIGN KEY(org_id,subscription_id) REFERENCES subscriptions(org_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(org_id,invoice_id) REFERENCES invoices(org_id,id) ON DELETE RESTRICT
);
CREATE TABLE chain_charge_preparations (
 org_id TEXT NOT NULL,
 invoice_id TEXT NOT NULL,
 subscription_id TEXT NOT NULL,
 charge_number TEXT NOT NULL,
 PRIMARY KEY(org_id,invoice_id),
 UNIQUE(org_id,subscription_id,charge_number),
 FOREIGN KEY(org_id,invoice_id) REFERENCES invoices(org_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(org_id,subscription_id) REFERENCES subscriptions(org_id,id) ON DELETE RESTRICT
);
CREATE TABLE chain_checkout_preparations (
 org_id TEXT NOT NULL,
 subscription_id TEXT NOT NULL,
 customer_wallet TEXT NOT NULL,
 external_ref TEXT NOT NULL,
 subscription_key TEXT NOT NULL,
 PRIMARY KEY(org_id,subscription_id),
 FOREIGN KEY(org_id,subscription_id) REFERENCES subscriptions(org_id,id) ON DELETE RESTRICT
);
CREATE TRIGGER chain_checkout_preparations_immutable BEFORE UPDATE ON chain_checkout_preparations BEGIN SELECT RAISE(ABORT,'chain subscription identity is immutable'); END;
CREATE TRIGGER chain_bound_subscription_lifecycle BEFORE UPDATE OF status,cancel_at_period_end,canceled_at ON subscriptions
WHEN EXISTS (SELECT 1 FROM chain_checkout_preparations p WHERE p.org_id=OLD.org_id AND p.subscription_id=OLD.id)
AND (NEW.status IS NOT OLD.status OR NEW.cancel_at_period_end IS NOT OLD.cancel_at_period_end OR NEW.canceled_at IS NOT OLD.canceled_at)
BEGIN SELECT RAISE(ABORT,'chain-bound subscription requires contract cancellation'); END;
