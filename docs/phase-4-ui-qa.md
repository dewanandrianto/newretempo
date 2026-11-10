# Phase 4 UI and Integration QA

## Scope and outcome

Tested the actual compiled frontend against the public Worker, private verifier, isolated persistent D1 databases and a fresh signed local Arc node. Covered merchant plan publication/capability creation, customer approval/payment/recovery, portal, overview, payment list, merchant escrow controls and renewal invoice/payment. This is not a full accessibility certification or independent security audit.

Nine concrete issues were corrected. Final execution is authoritative in `phase-4-evidence/final-checks.json`; all ten commands pass. Browser page exceptions: none. Checkout, portal, overview and merchant escrow document widths fit 320/360/390/768/1440 px.

| ID | Severity | Category | Issue | Status |
|---|---|---|---|---|
| QA-01 | Medium | Functional | Generated checkout path had no router alias | Fixed |
| QA-02 | Low | Accessibility | Private checkout input inherited link text in its accessible name | Fixed |
| QA-03 | Medium | Visual | Implicit overview grid tracks expanded to min-content width | Fixed |
| QA-04 | Medium | Visual | Invisible chart-axis labels still reserved flex width | Fixed |
| QA-05 | Medium | Visual | Long contract-action buttons exceeded narrow portal cards | Fixed |
| QA-06 | Medium | Visual | Connected wallet balance and address overflowed mobile toolbar | Fixed |
| QA-07 | Medium | Functional | Confirmed customer collections remained hardcoded zero | Fixed |
| QA-08 | High | Functional | Next-period subscription invoice/checkout path was incomplete | Fixed |
| QA-09 | Medium | UX | Live navigation linked to invented invoice/checkout fixtures | Fixed |

## Reproductions and resolution

### QA-01 — Checkout URL alias

- URL: `/checkout/<real capability>`.
- Steps: create a merchant capability, open its returned URL.
- Expected: actual customer checkout. Observed: not-found route although `/pay/:sessionId` existed.
- Fix: retain `/pay` compatibility and add `/checkout/:sessionId` alias.
- Proof: final merchant-generated capability is opened and paid through this route in the signed browser scenario.

### QA-02 — Accessible capability field

- URL: `/app/subscriptions`, Checkout link dialog.
- Steps: create the 24-hour link, locate its input by the visible label.
- Expected: input named `Private checkout URL`. Observed: the nested `Open checkout` link was included in the accessible name.
- Fix: explicitly name the real input; the browser can retrieve and use the actual generated capability without guessing a UUID.
- Proof: `merchantPublishAndCheckout` and `renewalInvoiceInBrowser` in `tests/helpers/checkout-browser.mjs`.

### QA-03 — Overview grid

- URL: `/app`, with a verified payment and escrow.
- Steps: load real records and resize to 320 px.
- Expected: grid cards remain inside the viewport. Observed: implicit tracks expanded for long ledger content.
- Fix: explicit zero-minimum single-column tracks before responsive multi-column overrides; no document overflow hiding.
- Proof: `signed-dashboard-mobile.png` and the final document-width assertions.

### QA-04 — Revenue chart labels

- URL: `/app`, revenue card, 12-month range.
- Steps: display twelve real monthly buckets at 320 px.
- Expected: readable in-bounds labels. Observed: twelve flex labels retained intrinsic width even when visually invisible.
- Fix: positioned axis ticks, endpoint alignment and fewer visible ticks on small screens. Exact base-unit totals and tooltips remain independent of the dimensionless chart coordinates.
- Proof: final overview width assertions and `final-script-tests.log` exact-revenue regressions.

### QA-05 — Portal action labels

- URL: `/portal`, actual active subscription and escrow.
- Steps: resize finite-budget/refund controls to 320 px.
- Expected: complete legible action labels inside cards. Observed: nowrap buttons extended beyond the card.
- Fix: contract action buttons have bounded width, wrapping and a minimum accessible height.
- Proof: final real portal width assertions and `signed-customer-portal.png`.

### QA-06 — Connected-wallet toolbar

- URL: `/app`, connected funded test wallet.
- Steps: show the actual balance/address and profile controls at 320 px.
- Expected: usable in-bounds navigation. Observed: the full balance badge competed with the wallet address and profile button.
- Fix: compact mode hides only its balance badge below the small breakpoint; the address/control remains visible and full balance remains available elsewhere. No monetary rounding or document clipping is used.
- Proof: final connected-wallet overview/escrow width assertions and `signed-dashboard-mobile.png`.

### QA-07 — Customer collections

- URL: `/app/customers`.
- Steps: reconcile a successful payment, inspect the customer's confirmed collections.
- Expected: exact confirmed owned payment sum. Observed: a legacy hardcoded zero.
- Fix: derive gross confirmed collections from successful projected payments belonging to that customer, excluding pending and foreign-customer records.
- Proof: `scripts/billing-identities.test.ts` exercises exact amounts above JavaScript's safe integer range.

### QA-08 — Manual renewal invoice

- URLs: `/app/invoices`, next-period checkout.
- Steps: after a paid initial subscription, create/finalize its next invoice and generate a checkout.
- Expected: exact subscription price, quantity one, full UTC period identity and a new reconciled charge.
- Observed: the form could only create standalone invoices; the display mapper discarded subscription identity/time precision; base-open but privately paid invoices could be selected again.
- Fix: matching-customer subscription selection, immutable amount/quantity, exact UTC period, preserved invoice subscription identity and exclusion of privately paid candidates. Unsupported or absent eligible invoices fail clearly.
- Proof: `scripts/renewal-invoice.test.ts`, real workerd renewal tests and the final browser-created invoice → finalized capability → actual signed renewal → distinct paid invoice/escrow. The exact period is read back from D1. Screenshot: `signed-renewal-invoice.png`.

### QA-09 — Invented navigation targets

- URLs: dashboard sidebar and public footer.
- Steps: follow the exported preview links.
- Expected: live destinations or explicitly supplied private capabilities. Observed: invented checkout/invoice fixture identifiers.
- Fix: remove invalid fixture links and retain the real wallet-owned portal. Checkout links are generated privately from actual records.
- Proof: the navigation regression in `scripts/billing-identities.test.ts`.

## Evidence limitations

Screenshots reside in `docs/phase-4-evidence/`. Intermediate browser failures were captured to shared failure filenames; those files are historical and some earlier captures were overwritten during iteration. Do not mistake them for the final result. Final successful screenshots, machine-readable receipts/transactions, source fingerprints and full command logs are retained.

Known production and accounting boundaries remain documented in `phase-4-verification.md`; none are represented as deployed or audited functionality.
