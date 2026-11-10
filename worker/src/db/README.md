# D1 schema inventory and integration contract

## Public database interface

- `createOrm(db: D1Database)` in `client.ts` returns the real `drizzle-orm/d1` connection with all schema exports. Table exports use camelCase (`emailTokens`, `auditLogs`); column properties and SQL names remain exactly snake_case (`password_hash`, `token_hash`, `org_id`). All 21 original tables and all their columns are retained, plus `rate_limits` (22 tables, 260 columns).
- Apply `worker/migrations/0001_schema.sql` then `0002_guards.sql`. Both are required. Drizzle declarations describe fields, defaults, CHECKs, indexes and FKs; handwritten migrations also implement triggers, which Drizzle cannot express. Never replace migrations with schema-only generated output or run schema push against a real database.
- Tenant relationships retain `(org_id, parent_id)` composite FKs and parent `(org_id, id)` uniqueness. SQLite foreign keys must remain enabled; D1 enables them. Audit rows intentionally have no foreign keys and remain append-only.
- `rate_limits(key TEXT PRIMARY KEY, count INTEGER NOT NULL DEFAULT 0, reset_at TEXT NOT NULL)`, with a reset-time index. Use an atomic `INSERT ... ON CONFLICT DO UPDATE ... RETURNING` rather than a read/increment race. Expiry is UTC ISO text.

## Exact representation changes

| PostgreSQL | D1/Drizzle | Integration requirement |
|---|---|---|
| UUID / gen_random_uuid() | TEXT primary key, no generated default | Generate `crypto.randomUUID()` in the Worker; no placeholder IDs or seeded accounts. |
| TIMESTAMPTZ / now() | TEXT UTC `YYYY-MM-DDTHH:mm:ss.sssZ`; SQLite strftime default | Bind `Date.toISOString()`. Every legacy timestamp column rejects noncanonical strings. AFTER UPDATE trigger maintains updated_at when caller does not change it. |
| BIGINT money | canonical unsigned integer TEXT, range 0..9223372036854775807 | Bind strings; compute using BigInt; never Number, CAST, SUM, or SQLite arithmetic on money. Positive amounts reject zero; invoice amount_paid allows zero and has exact length/lexical comparison to total_amount. |
| BIGINT chain_id/block_number/invoice_counter | INTEGER, bounded <=9007199254740991 | Bind safe integers. These identifiers/counters are not money. |
| BOOLEAN cancel_at_period_end | INTEGER CHECK IN (0,1) | Bind 0/1, not JavaScript booleans; Drizzle returns number. |
| JSONB line_items/payload/metadata | validated JSON TEXT | JSON.stringify on write and JSON.parse on read; line_items must be an array. |
| TEXT[] scopes/events | validated JSON array TEXT | Defaults are `["read"]` and `[]`; stringify arrays. |
| regex constraints | equivalent narrow SQLite GLOB/LIKE/length checks | Addresses/hashes remain exact lowercase 0x hex lengths; lowercase email and bounded slug shape retained. Application email validation remains stricter. |

Money columns: `plans.amount`, `subscriptions.amount`, `mandates.max_amount_per_period`, `invoices.total_amount`, `invoices.amount_paid`, `payments.amount`, `escrows.amount`, `transactions.amount`, `disputes.amount`.

## Financial and accounting boundary

Phase 2 deliberately disallows authoritative writes entirely. There is **no runtime capability switch, authoritative flag table, header, binding, or public helper**. Direct prepared SQL and Drizzle are subject to the same triggers. Ledger INSERT/UPDATE/DELETE always fail; payments cannot acquire succeeded/processing/failed, chain hash, payer, confirmation, or changed amount/chain/currency; escrow cannot acquire funded/released/refunded/settled/disputed or chain references. Invoices cannot acquire paid or nonzero amount_paid; non-draft price/customer/line_items cannot change. Payment pending-to-canceled and unfunded escrow release_after_days edits remain allowed. SQL guard errors contain `chain_controlled` for HTTP error mapping.

Subscriptions can start only incomplete with no verified period; only cancellation is allowed without events. Mandates can start only pending without verified references and cannot be updated. No endpoint should create mandates in this phase.

Financial record IDs, tenant IDs, request_hash and idempotency_key are immutable. REPLACE cannot erase/recreate invoices/payments/escrows through primary keys, request keys, invoice numbers or live-payment/live-escrow unique indexes. Last-owner delete/demotion/tenant-movement and owner REPLACE are blocked. Audit UPDATE/DELETE/REPLACE are blocked. Uniqueness retains one live payment and escrow per invoice, per-org idempotency, one invoice per subscription period, and chain event/log replay protection.

A future verified-event implementation requires a **new reviewed migration** and isolated internal writer, not relaxing these guards in HTTP. Its design must verify chain/contract/log identity and canonicality first, then atomically D1.batch the event deduplication, financial state transitions, exact BigInt-derived invoice accounting and append-only audit. Because D1 has no interactive transactions or secure transaction-local session variables, a writable boolean in a shared database is not an acceptable substitute for isolation. This phase provides no event writer and no path to activate one.

## Full column inventory

The following inventory is generated from SQLite metadata and was checked column-for-column against the original 21 PostgreSQL table definitions. `?` means nullable; all unmarked columns are NOT NULL. `TEXT` representations follow the rules above; unchanged TEXT field names and values retain their original meaning.

### users

`id` TEXT, `email` TEXT?, `email_verified_at` TEXT?, `password_hash` TEXT?, `display_name` TEXT, `status` TEXT, `last_login_at` TEXT?, `created_at` TEXT, `updated_at` TEXT

### sessions

`id` TEXT, `user_id` TEXT, `token_hash` TEXT, `auth_method` TEXT, `ip` TEXT?, `user_agent` TEXT?, `last_seen_at` TEXT, `idle_expires_at` TEXT, `expires_at` TEXT, `revoked_at` TEXT?, `revoked_reason` TEXT?, `created_at` TEXT, `updated_at` TEXT

### email_tokens

`id` TEXT, `user_id` TEXT, `purpose` TEXT, `email` TEXT, `token_hash` TEXT, `expires_at` TEXT, `used_at` TEXT?, `created_at` TEXT, `updated_at` TEXT

### siwe_nonces

`id` TEXT, `nonce` TEXT, `purpose` TEXT, `address` TEXT, `user_id` TEXT?, `message_hash` TEXT, `expires_at` TEXT, `used_at` TEXT?, `created_at` TEXT, `updated_at` TEXT

### organizations

`id` TEXT, `name` TEXT, `slug` TEXT, `website` TEXT?, `industry` TEXT, `country` TEXT, `status` TEXT, `created_by` TEXT, `invoice_counter` INTEGER, `created_at` TEXT, `updated_at` TEXT

### memberships

`id` TEXT, `org_id` TEXT, `user_id` TEXT, `role` TEXT, `created_at` TEXT, `updated_at` TEXT

### products

`id` TEXT, `org_id` TEXT, `name` TEXT, `description` TEXT, `status` TEXT, `created_at` TEXT, `updated_at` TEXT

### plans

`id` TEXT, `org_id` TEXT, `product_id` TEXT, `name` TEXT, `amount` TEXT, `currency` TEXT, `interval` TEXT, `trial_days` INTEGER, `escrow_days` INTEGER, `status` TEXT, `created_at` TEXT, `updated_at` TEXT

### customers

`id` TEXT, `org_id` TEXT, `name` TEXT, `email` TEXT, `company` TEXT, `status` TEXT, `created_at` TEXT, `updated_at` TEXT

### wallets

`id` TEXT, `purpose` TEXT, `org_id` TEXT?, `user_id` TEXT?, `customer_id` TEXT?, `address` TEXT, `chain_id` INTEGER, `label` TEXT, `verified_at` TEXT?, `verification_method` TEXT?, `created_at` TEXT, `updated_at` TEXT

### subscriptions

`id` TEXT, `org_id` TEXT, `customer_id` TEXT, `plan_id` TEXT, `status` TEXT, `amount` TEXT, `interval` TEXT, `current_period_start` TEXT?, `current_period_end` TEXT?, `cancel_at_period_end` INTEGER, `canceled_at` TEXT?, `created_at` TEXT, `updated_at` TEXT

### mandates

`id` TEXT, `org_id` TEXT, `subscription_id` TEXT, `customer_id` TEXT, `payer_address` TEXT, `chain_id` INTEGER, `token_address` TEXT, `max_amount_per_period` TEXT, `period_seconds` INTEGER, `status` TEXT, `contract_address` TEXT?, `onchain_ref` TEXT?, `valid_from` TEXT?, `valid_until` TEXT?, `created_at` TEXT, `updated_at` TEXT

### invoices

`id` TEXT, `org_id` TEXT, `customer_id` TEXT, `subscription_id` TEXT?, `number` TEXT, `status` TEXT, `currency` TEXT, `total_amount` TEXT, `amount_paid` TEXT, `line_items` TEXT, `memo` TEXT, `period_start` TEXT?, `issued_at` TEXT?, `due_at` TEXT, `idempotency_key` TEXT, `request_hash` TEXT, `created_at` TEXT, `updated_at` TEXT

### payments

`id` TEXT, `org_id` TEXT, `invoice_id` TEXT, `customer_id` TEXT, `amount` TEXT, `currency` TEXT, `status` TEXT, `chain_id` INTEGER, `payer_address` TEXT?, `tx_hash` TEXT?, `failure_reason` TEXT?, `confirmed_at` TEXT?, `idempotency_key` TEXT, `request_hash` TEXT, `created_at` TEXT, `updated_at` TEXT

### escrows

`id` TEXT, `org_id` TEXT, `invoice_id` TEXT, `customer_id` TEXT, `payment_id` TEXT?, `amount` TEXT, `currency` TEXT, `status` TEXT, `release_after_days` INTEGER, `release_at` TEXT?, `chain_id` INTEGER, `contract_address` TEXT?, `onchain_escrow_id` TEXT?, `funded_tx_hash` TEXT?, `settled_tx_hash` TEXT?, `idempotency_key` TEXT, `request_hash` TEXT, `created_at` TEXT, `updated_at` TEXT

### transactions

`id` TEXT, `org_id` TEXT, `kind` TEXT, `direction` TEXT, `amount` TEXT, `chain_id` INTEGER, `tx_hash` TEXT, `log_index` INTEGER, `block_number` INTEGER, `from_address` TEXT?, `to_address` TEXT?, `payment_id` TEXT?, `escrow_id` TEXT?, `status` TEXT, `occurred_at` TEXT, `created_at` TEXT, `updated_at` TEXT

### disputes

`id` TEXT, `org_id` TEXT, `invoice_id` TEXT, `customer_id` TEXT, `payment_id` TEXT?, `escrow_id` TEXT?, `amount` TEXT, `reason` TEXT, `status` TEXT, `respond_by` TEXT, `resolution_note` TEXT?, `created_at` TEXT, `updated_at` TEXT

### api_keys

`id` TEXT, `org_id` TEXT, `created_by` TEXT, `name` TEXT, `prefix` TEXT, `key_hash` TEXT, `scopes` TEXT, `last_used_at` TEXT?, `expires_at` TEXT?, `revoked_at` TEXT?, `created_at` TEXT, `updated_at` TEXT

### webhooks

`id` TEXT, `org_id` TEXT, `url` TEXT, `description` TEXT, `events` TEXT, `status` TEXT, `signing_secret_ciphertext` TEXT, `created_at` TEXT, `updated_at` TEXT

### webhook_deliveries

`id` TEXT, `org_id` TEXT, `webhook_id` TEXT, `event_id` TEXT, `event_type` TEXT, `payload` TEXT, `status` TEXT, `attempts` INTEGER, `next_attempt_at` TEXT?, `response_status` INTEGER?, `last_error` TEXT?, `delivered_at` TEXT?, `created_at` TEXT, `updated_at` TEXT

### audit_logs

`id` TEXT, `org_id` TEXT?, `actor_user_id` TEXT?, `actor_type` TEXT, `action` TEXT, `resource_type` TEXT, `resource_id` TEXT?, `metadata` TEXT, `ip` TEXT?, `user_agent` TEXT?, `request_id` TEXT?, `created_at` TEXT, `updated_at` TEXT

### rate_limits

`key` TEXT, `count` INTEGER, `reset_at` TEXT
