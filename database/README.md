# Legacy PostgreSQL Database Reference

The current local runtime uses `worker/migrations/` and `worker/src/db/` for Cloudflare D1/Drizzle. These PostgreSQL migrations remain unchanged as a legacy reference, not the default migration target. The current `bun run db:migrate` command is D1-local; use `bun run db:legacy:migrate` only with an intentionally configured legacy database. No existing PostgreSQL data was imported or deleted during the local migration.

PostgreSQL schema for RETEMPO, managed as ordered SQL migrations in `migrations/`.

| File | Contents |
| --- | --- |
| `0001_foundation.sql` | `updated_at` trigger, the `retempo_authoritative()` guard switch |
| `0002_identity.sql` | users, sessions, email tokens, SIWE nonces |
| `0003_tenancy.sql` | organizations, memberships (last-owner protection) |
| `0004_catalog.sql` | products, plans, customers, wallets, subscriptions, mandates |
| `0005_billing.sql` | invoices, payments, escrows, transactions, disputes |
| `0006_integrations.sql` | api_keys, webhooks, webhook_deliveries, audit_logs |
| `0007_financial_guards.sql` | triggers that make financial state chain-controlled, audit log append-only |

## Conventions

- UUID primary keys, `created_at` / `updated_at` on every table.
- Money is `BIGINT` USDC base units (6 decimals). No `NUMERIC` or float columns exist.
- Tenant isolation: every tenant table has `org_id`; references use composite foreign keys
  `(org_id, id)`, so a row can never point at another tenant's row, even if application code is wrong.
- Idempotency keys are unique per organization on invoices, payments and escrows. Partial unique
  indexes allow only one live payment and one live escrow per invoice, and one invoice per subscription period.
- Closed value sets are `TEXT` + `CHECK` constraints.
- Applied migrations are checksummed. Never edit one: add a new file.

## Setup

1. Start PostgreSQL (16+). With Docker:

   ```bash
   docker run -d --name retempo-pg --restart unless-stopped \
     -e POSTGRES_PASSWORD=choose-a-password -e POSTGRES_DB=retempo \
     -v retempo_pgdata:/var/lib/postgresql -p 127.0.0.1:5432:5432 postgres:18-alpine
   docker exec retempo-pg psql -U postgres -c "CREATE DATABASE retempo_test"
   ```

2. Put `DATABASE_URL` and `TEST_DATABASE_URL` in `.env` (see `/.env.example`).
3. Apply legacy migrations: `bun run db:legacy:migrate`. It is safe to re-run against the deliberately selected legacy database.

## Financial-state guard

Escrow status, payment success, invoice paid state and the `transactions` ledger can only change inside
a transaction that has run `SELECT set_config('retempo.authoritative', 'on', true)`. Only verified
blockchain-event processing (Phase 3) may do that, via `backend/src/services/chainEvents.ts`.
Nothing in the HTTP API does, so a request cannot mark an escrow funded, released, refunded or settled.
