# Worker billing migration notes

- `registerBillingRoutes(app)` covers the legacy subscription/invoice/payment/escrow route set. It uses only Hono, D1, shared Worker guards/helpers, and Zod; no Bun SQL services or authoritative-event bypass.
- Use the actual legacy-compatible column `organizations.invoice_counter` (not `invoice_seq`). Counter increments, invoice insertion, conditional-write assertion, and mandatory audit insertion share one atomic D1 batch. Failed duplicate inserts and audit failures roll back the counter.
- All money columns and bound values remain canonical decimal TEXT. Invoice multiplication/summation and payment remaining-balance subtraction run through JavaScript BigInt. SQL does not calculate or cast money.
- Every mutable state predicate is in the SQL write itself. A no-op conditional write deliberately fails the subsequent batch assertion, preventing a detached audit entry. Schema AFTER UPDATE timestamp triggers do not affect SQLite `changes()` for that assertion.
- Payment/escrow inserts compare the invoice's original exact balance strings and require its current status to be open. Invoice void also excludes both live payments and live escrows. This adds protection against orphaning pending escrow that the legacy void implementation lacked.
- Known schema replacement-guard failures are handled like uniqueness conflicts, including rereading the idempotency key after a concurrent insert. Same semantic request returns 200; a changed request returns `idempotency_key_reused`/409.
- Public state fields are stripped on create and cannot set paid/succeeded/funded/chain references. Subscription patches allow only cancellation and cancel-at-period-end. Pending escrow terms remain editable; pending escrow can be discarded. There is intentionally no settlement route.

## Schema hardening needed outside this agent's ownership

The inspected migrations lack a database unique index for one non-canceled subscription per organization/customer/plan. HTTP creation is nevertheless race-safe through an atomic `INSERT ... SELECT ... NOT EXISTS` and batch assertion (verified concurrently on real D1). To make this invariant apply to direct database writes as requested, the schema owner should add:

```sql
CREATE UNIQUE INDEX subscriptions_one_live_per_customer_plan
ON subscriptions (org_id, customer_id, plan_id)
WHERE status <> 'canceled';
```

No migration/config/schema files were modified by the billing agent. Other existing guards/partial unique indexes are supplied by `worker/migrations/0001_schema.sql` and `0002_guards.sql`.
