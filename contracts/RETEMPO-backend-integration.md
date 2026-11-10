# RETEMPO: Backend Integration Plan (design only)

> Historical imported PostgreSQL integration proposal. The active backend is Workers/Hono + D1/Drizzle, which stores monetary base units as canonical integer TEXT, not JavaScript numbers or SQL BIGINT casts. The migration number, transaction-local PostgreSQL authority flag, database-role model and old phase numbers below are not a D1 implementation or authorization to enable settlement writes. A reviewed isolated verified-event writer/migration is still required; all authoritative financial writes currently fail closed. See `docs/phase-2-verification.md` and `contracts/README.md`.

Parent: [`RETEMPO-design.md`](./RETEMPO-design.md). Nothing in this document is implemented yet. Phase 2 code and the database are unchanged.

## 1. Status of integration pieces

| Piece | Status |
| --- | --- |
| Phase 2 tables for plans, subscriptions, mandates, invoices, payments, escrows, transactions, disputes | exists (needs additive migration 0008) |
| DB guards that block API-driven funded/released/paid states | exists and tested |
| `runAuthoritative` seam | exists, unused |
| Event decoder, indexer, cursor table, reconciler | **not started** |
| Webhooks and API-key request authentication | **not started** (Phase 2 left them incomplete) |
| Web app Arc Mainnet chain config and contract addresses | **not started** |

## 2. Identifier mapping

| Phase 2 record | On-chain key | Computation |
| --- | --- | --- |
| plan (UUID) | `planKey` | `keccak256(abi.encode(merchant, externalRef))`, `externalRef = bytes32(uint256(uint128(uuid)))` |
| subscription (UUID) | `subKey` | `keccak256(abi.encode(customer, externalRef))` |
| invoice (UUID) | `invoiceRef` and `escrowKey` | `escrowKey = keccak256(abi.encode(merchant, invoiceRef))` |
| recurring escrow | `invoiceRef = keccak256(abi.encode(subKey, chargeNumber))` | derived on-chain |
| payment | `(chainId, txHash, logIndex)` of `SubscriptionPaymentProcessed` or `EscrowFunded` | unique already |

The backend computes keys before the customer sends a transaction, stores them, and matches events by key plus the stored wallet address. An event whose key is unknown to the database is stored but never attached to a tenant.

## 3. Event to database mapping

| Event | Effect (authoritative path only) |
| --- | --- |
| `PlanCreated`, `PlanUpdated` | set `plans.onchain_plan_key`, `payout`, active flag |
| `SubscriptionCreated` | `subscriptions.onchain_key`, status `active` or `trialing`, `next_charge_at` |
| `SubscriptionPaymentProcessed` | insert `transactions` (`subscription_payment`), mark linked payment `succeeded` with tx hash, invoice `paid`, advance period, link `escrow_key` |
| `SubscriptionCanceled` | status `canceled` |
| `MandateCreated` / `MandateRevoked` | upsert `mandates` caps, expiry, status `active` or `revoked` |
| `EscrowCreated` / `EscrowFunded` | escrow `funded`, set vesting fields, contract address, funded tx hash |
| `VestedClaimed` | `claimed` total, ledger `escrow_release` |
| `RefundCredited` | `refunded` total, ledger `escrow_refund` |
| `DisputeOpened` / `DisputeResponded` | dispute row `needs_response` / `under_review`, escrow `disputed` |
| `DisputeResolved` / `DisputeExpired` / `SettlementAccepted` | dispute `resolved`, escrow `settled`, amounts to merchant and customer |
| `EscrowClosed` | final escrow status from `outcome` |
| `Withdrawn` | ledger `payout` |
| OZ role and pause events | `audit_logs` (`actor_type = chain`) and an ops alert |

Statuses stay inside the existing sets: `released` is used when the outcome is `FullyVested`, `refunded` for `Refunded`, `settled` for `Resolved`, `Expired` and `Settled`.

## 4. Migration 0008 outline (additive, not yet written)

- `plans`: `onchain_plan_key text unique`, `payout_address text`.
- `subscriptions`: `onchain_key text unique`, `next_charge_at timestamptz`, `charge_count int`.
- `mandates`: `max_total_amount bigint`, `spent_amount bigint`, `nonce int`, `expires_at` (reuse `valid_until`), `onchain_key text`.
- `escrows`: `vest_start timestamptz`, `vest_duration_seconds int`, `claimed_amount bigint`, `awarded_amount bigint`, `refunded_amount bigint`, `escrow_key text unique`, `arbitrator_address text`, `customer_may_refund bool`; keep the existing authoritative guards and extend them to the new columns.
- `transactions.kind`: add `subscription_payment`, `mandate_charge`, `withdrawal`.
- `disputes`: `onchain_reason_hash`, `ruling_hash`, `opened_at_chain`.
- New `indexer_cursors(chain_id, contract_address, last_block, last_block_hash)` and `chain_events_raw(chain_id, tx_hash, log_index, block_number, block_hash, contract, event, payload jsonb)` with the same unique key as `transactions`.
- A dedicated database role for the indexer, and `retempo_authoritative()` changed to require it (Phase 2 hardening H1).

## 5. Indexer requirements

- **Source of truth:** RETEMPO contract logs only. Do not index USDC `Transfer` logs for business state. Arc emits USDC transfers from two emitters (18-decimal system logs and 6-decimal ERC-20 logs), and reading both double counts.
- **Confirmations:** Arc documents deterministic finality on inclusion, so one confirmation is the documented minimum. The indexer still stores `block_hash`, checks parent continuity, and treats a mismatch as an incident that stops ingestion until reviewed.
- **Duplicates and replay:** insert raw events with `ON CONFLICT (chain_id, tx_hash, log_index) DO NOTHING`; process only newly inserted rows; every handler is idempotent and re-runnable from any block (replay safe).
- **Ordering:** process by `(block_number, log_index)`; apply each transaction in one database transaction through `runAuthoritative`.
- **Reconciliation:** a periodic job reads `getEscrow`/`claimableAmount` and compares to the database; any difference raises an alert and is never auto-corrected.
- **Reorganizations:** not expected per Arc finality, but the cursor design supports a bounded rewind (delete rows above a block, re-ingest).
- **Unknown or malformed events:** stored raw, flagged, and never applied.
- **Amounts:** event amounts are 6-decimal base units; store as `BIGINT`; reject values above 1e15 as impossible.
- **Chain and address allowlist:** the indexer only accepts logs from the configured chain ID and the two configured contract addresses.

## 6. Webhooks and alerts (design only)

Candidate webhook events after the indexer exists: `payment.succeeded`, `subscription.created`, `subscription.canceled`, `mandate.revoked`, `escrow.funded`, `escrow.claimed`, `escrow.refunded`, `dispute.opened`, `dispute.resolved`. They stay **incomplete** until implemented and tested. Ops alerts (page immediately): `Paused`, any role event, `DefaultAdminTransferScheduled`, `ArbitratorAdded`, `ConfigUpdated`, any reconciliation difference, indexer lag.

## 7. Compatibility rules

No breaking change to existing endpoints. New columns are nullable until the indexer fills them. Demo analytics stay labeled demo until real indexed data exists. The merchant UI keeps showing `not_deployed` until a real, verified contract address is configured.
