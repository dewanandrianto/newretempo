-- Existing append-only canonical events are indexed in place; no global history scan per read.
CREATE INDEX events_plan ON events(json_extract(body,'$.address'),json_extract(body,'$.args.planKey')) WHERE json_extract(body,'$.name') IN ('PlanCreated','PlanUpdated');
CREATE INDEX events_subscription ON events(json_extract(body,'$.address'),json_extract(body,'$.args.subKey'));
CREATE INDEX events_escrow ON events(json_extract(body,'$.address'),json_extract(body,'$.args.escrowKey'));
CREATE INDEX events_account ON events(json_extract(body,'$.address'),json_extract(body,'$.args.account'));
CREATE INDEX events_payment ON events(json_extract(body,'$.address'),json_extract(body,'$.args.subKey'),json_extract(body,'$.args.chargeNumber'),json_extract(body,'$.args.planKey'),json_extract(body,'$.args.customer'),json_extract(body,'$.args.merchant'),json_extract(body,'$.args.amount'),json_extract(body,'$.name'));
CREATE TABLE history_pages(token TEXT PRIMARY KEY, snapshot_id TEXT NOT NULL, scope TEXT NOT NULL, binding_hash TEXT NOT NULL, cursor TEXT NOT NULL, high_water INTEGER NOT NULL, after_row INTEGER NOT NULL, expires INTEGER NOT NULL);
CREATE INDEX history_pages_expiry ON history_pages(expires);
