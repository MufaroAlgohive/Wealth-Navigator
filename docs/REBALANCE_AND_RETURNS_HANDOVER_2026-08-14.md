# MINT Rebalance and Returns Handover — 14 August 2026

## Purpose and non-negotiable outcome

MINT needs one trustworthy performance and settlement chain. A strategy rebalance
must be explainable from proposal through IC approval, order fill, settlement,
model composition, client holdings/cash/reserve effects, and finally the app's
published returns. The public app must never display a made-up, stale, or
unexplained return.

The intended end state is a canonical daily strategy ledger with one certified
row per strategy/date. The app reads only certified values; drafts and audit
work must not change public values.

## Environments and safety boundaries

- `LIVE` and `UAT` are strictly separate. UAT research, votes, orders and
  proposals must never affect LIVE.
- Do not use IRESS locally. The Railway worker owns the live IRESS seat.
- UAT account is `56378`; do not send actual client/live money orders while
  testing.
- No historic execution price may be guessed from Yahoo. Use fill evidence or
  leave the period uncertified.
- Database migrations are supplied for a human to run. Do not run destructive
  migrations automatically.
- Preserve residual cash and execution reserve separately. General wallet cash
  is not rebalance funding.

## Current test rebalance

The active UAT proposal is **REB-2026-002 — Test Strategy**. It is not empty.
Its committee drill-down shows two intended model changes:

| Leg | Current outcome expected after settlement |
| --- | --- |
| `STX500` | decrease; proposed weight shown as 12.6% |
| `AME` | increase; proposed weight shown as 26.6% |

It is currently waiting for UAT committee approval. Its existing all-HOLD
screen is a separate empty draft/proposal display issue; it must not be used as
evidence that REB-2026-002 is empty.

### Expected lifecycle for REB-2026-002

1. UAT committee votes/uses its authorized manual approval path.
2. Proposal becomes eligible for the UAT rebalance/order-book path.
3. The order book creates one order-audit row for each execution leg.
4. Railway/approved execution path reports immutable fills.
5. Completion writes a retail `rebalance_batch` and one `rebalance_event` per
   filled buy/sell before it permits a strategy composition flip.
6. For a **strategy-wide** request, `strategies_c.holdings` changes from the
   approved proposed composition only after that boundary succeeds.
7. Client holdings, strategy cash/reserve events and the return boundary are
   written/reconciled. The public app can then read the next certified ledger
   result.

If the orders are visible in the blotter/UAT order book but model weights stay
unchanged, inspect the completion/settlement boundary before changing any
holdings manually. An order fill alone is not a completed rebalance.

### Important scope distinction

- `single_user`: changes one investor's holdings only. It **must not** change
  `strategies_c.holdings` or the strategy model weights.
- strategy-wide: changes the model basket. This is the scope expected for
  REB-2026-002; successful settlement must change the model weights.

## Known prior test evidence

Read-only retail audit found Test Strategy ID
`26daf728-8e95-4ff0-b9e7-69b382b0bb8c`.

- Its `strategies_c.holdings` were last updated on **10 August 2026**.
- No `rebalance_batch` for Test Strategy was created on or after **12 August**
  at the time of the audit.
- Some `stock_holdings_c` rows were touched on 13 August but carry older fill
  dates and `rebalance_batch_id = null`; these do not prove a completed modern
  settlement.

Therefore the old test cannot prove the new settlement path. Re-audit
REB-2026-002 after it reaches filled/settled status.

The repository contains a safe verification query:

`wealth-navigator/docs/UAT_REBALANCE_EVIDENCE_CHECK.sql`

It is read-only and checks batches, events, cash/reserve movements and return
boundary evidence. Use it after a UAT fill; do not alter historic rows to make
the check pass.

## Recent Wealth Navigator changes

Branch: `feat/Porting` on `MINT-Developement/Wealth-Navigator`.

| Commit | Change | State |
| --- | --- | --- |
| `fbb31e0` | Regression test that a rebalance boundary precedes model composition flip | pushed |
| `1c1110b` | Capture filled order execution evidence before settling a strategy rebalance | pushed |
| `01febb9` | Test evidence persistence ordering | pushed |
| `76b8adc` | Capture evidence for single-client settlements too | pushed |
| `785afe2` | Correct TypeScript boundary parameter for execution evidence | pushed |
| `95b1321` | Remove invalid `rebalance_event.strategy_id` insert; the actual retail schema has no such column | pushed |
| `c70f6bc` | Reject zero-change/all-HOLD proposals in both UI and API | pushed |

Focused verification after `95b1321` passed:

```text
src/lib/returns/seal-rebalance-boundary.test.ts    1 passed
src/lib/rebalance/complete-rebalance.test.ts       3 passed
```

The full production build should be confirmed by Vercel on the latest branch.

### Why the invalid-column correction matters

`rebalance_event` contains `batch_id`, `user_id`, `security_id`, side,
quantity, price/fill and date; it does not contain `strategy_id`. The first
implementation would fail before the return boundary could seal. The corrected
writer links the event to the strategy through `rebalance_batch`.

### Empty-proposal guard

An all-HOLD item is now rejected:

- UI: requires at least one increase, decrease, add or removal.
- API: independently compares current/proposed composition and returns 422 if
  there is no change.

This does **not** delete or alter an existing proposal.

## Required next implementation: one book per rebalance

The current UAT experience must not group successive rebalances into one
perpetual Test Strategy book. Each approved rebalance request must receive its
own immutable rebalance-book identity, linked to its request ID.

Desired behaviour:

1. `REB-2026-002` owns its own book and contains only its STX500/AME legs.
2. A subsequent Test Strategy proposal creates a new book (for example
   `REB-2026-003`) even if it targets the same strategy.
3. Blotter/order-book filtering defaults to the request/book ID, with an
   optional strategy history view.
4. Completion and `rebalance_batch` retain the request/book correlation.
5. Never merge rows from a new request into a prior pending/approved book.

Before implementing this, inspect the current book key construction in:

- `src/components/admin/order-book/pending-rebalance-sends.tsx`
- `src/components/admin/order-book/execution-view.tsx`
- `src/app/api/rebalance/requests/[id]/push/route.ts`
- `src/app/api/admin/orderbook/send-to-market/route.ts`

The correct durable key is the rebalance request ID, not strategy name.

## UAT settlement proof — REB-2026-002

The UAT STX500-to-AME test completed successfully after the post-fill recovery
path was used.

| Evidence | Verified result |
| --- | --- |
| Filled order legs | 6: each of three test owners sold 2 STX500 and bought 1 AME |
| Execution source | UAT self-fill only; no live broker order |
| Settlement batch | `e3bfb777-1031-4abd-92e5-41e1f3dcbddd`, `SETTLED` / `COMPLETE` on 14 Aug 2026 |
| Model result | STX500 `5 -> 3`; AME `11 -> 12`; model weights updated in OEM |
| Execution evidence | 6 immutable `rebalance_event` rows with fill prices/dates |
| Return boundary | Sealed against that batch; complete value and chain preserved |

The first settlement attempt failed safely because the OEM institutional auth
user was not a retail `auth.users` ID, while `rebalance_batch.created_by` has a
retail foreign key. Commit `8912dcf` resolves the actor to a valid retail
owner for this cross-project attribution case. The recovery endpoint is
UAT-only and idempotent only for incomplete settlement; do not click it again
after a successful batch exists.

### Cash/reserve audit gap discovered by this test

The UAT fill did update client residual balances and execution reserve
consumption, but it did **not** write
`strategy_rebalance_cash_events_c` or
`strategy_rebalance_reserve_events_c`. This is because the current
`settleRebalanceCashForClients` implementation updates residuals/transactions
directly and has no batch ID argument.

Do not backfill this completed test with invented opening balances. There is no
pre-settlement residual snapshot retained for the exact batch. For all future
settlements, replace the direct multi-step writes with one idempotent,
transactional retail RPC that:

1. receives the exact `rebalance_batch.id` returned by completion;
2. locks/reads the opening residual and reserve;
3. calculates the documented proceeds bridge from actual fills;
4. inserts one immutable cash event and one reserve event per affected owner;
5. updates the residual and reserve consumption in the same transaction;
6. rejects a duplicate batch/owner event if values disagree.

Then the existing CA-reconciliation migration can require those events without
leaving an audit hole. This is an implementation requirement before calling
the LIVE cash ledger fully audit-complete.

## Returns/Excel programme — the main remaining goal

### Target design

Create/finish a canonical daily ledger (one row per strategy/date) that
behaves like the supplied `Public_strategy_view` workbook:

- opening positions and lots;
- daily official closes and as-of date;
- strategy cash, residual cash and execution reserve distinctly;
- buys, sells, fees and rebalances at actual execution evidence;
- closing securities value, NAV and P/L;
- WTD, 1M, 3M, YTD, since-inception and as-of dates from the same ledger;
- immutable audit fields showing source/quality/certification.

The app should fetch certified canonical returns rather than recomputing each
card/chart independently in the frontend.

### Existing canonical work

- `strategy_canonical_daily_ledger_c` has been created and is **DRAFT only**.
- DRAFT candidate rows were staged for MyGrowthFund, MINT Famous Brands, UCT
  and Blended Focus. They are not public-app facing.
- MINT app adapter commit `df537ace` overlays only rows whose status is
  `CERTIFIED`; therefore merging it does not change values while data is DRAFT.
- The existing app/effective return views remain the source shown to users
  until a strategy/date is certified.

### Accuracy rules

- Use exchange trading sessions and the last available close on non-trading
  dates. The prior-close rule was audited against Yahoo data.
- Yahoo is suitable for price-history cross-checks/cache repair, not for
  invented rebalance execution price.
- If a security close is missing, report the affected strategy/date as
  uncertified rather than substituting an arbitrary price.
- Effective return chains, not raw basket value, prevent false rebalance
  cliffs.
- Cash introduced by a rebalance is not performance. Preserve return
  continuity at the settlement boundary.

### Known evidence gaps — do not guess

| Strategy/item | Gap | Correct action |
| --- | --- | --- |
| Diversified | 18 Jun GRT reduction missing batch/event/fill | obtain execution evidence or keep affected period uncertified |
| Multi-sector | 16 Jun NY1 reduction missing batch/event/fill | obtain execution evidence or keep affected period uncertified |
| ETF Basket | missing STXID Yahoo close | use another approved source or show uncertified |
| Yield Basket | opening evidence incomplete | reconcile inception lots/cash before certification |
| Test Strategy | intentionally excluded from historic canonical reconstruction | use only as UAT settlement test |

### Practical next sequence for the next agent

1. Do not change public app returns.
2. Finish a strategy-by-strategy workbook comparison from inception for all
   non-test strategies, beginning with Yield Basket and then the remaining
   strategy family.
3. Compare workbook NAV/return calculations to the DRAFT ledger for every
   requested range, not only 1M.
4. Classify each date as `CERTIFIED`, `DRAFT`, or `UNVERIFIABLE` with a reason.
5. Fix only source data errors backed by evidence; make repairs insert-only
   where possible and never overwrite historical prices without a reviewed
   migration.
6. Promote only reviewed rows to `CERTIFIED`.
7. Verify the MINT app card, strategy detail and chart show precisely the same
   ledger dates/returns.
8. After the ledger is stable, retire redundant views/tables only after proving
   nothing still reads them. The desired end state is one canonical read model,
   not many competing calculations.

## Rebalance database evidence map

Retail:

- `rebalance_batch`: settlement batch, before/planned/after snapshots,
  effective date and state.
- `rebalance_event`: immutable buy/sell execution evidence linked to batch.
- `strategy_rebalance_cash_events_c`: cash movements and invariant checks.
- `strategy_rebalance_reserve_events_c`: reserve use/shortfall trace.
- `strategy_rebalance_ca_reconciliation_c`: model capital equals securities
  value plus strategy CA.
- `strategy_rebalance_residuals`: residual cash balance per owner/strategy.

Institutional:

- `rebalance_request_c`: proposal, current/proposed composition, UAT/LIVE
  scope, vote/approval status.
- `rebalance_vote_c`: votes.
- `oems_order_audit`: order legs and immutable fills from the execution path.

The target correlation chain is:

```text
rebalance_request_c (request/book ID)
  -> oems_order_audit (each order leg and fill)
  -> rebalance_batch (settlement boundary)
  -> rebalance_event + cash/reserve/reconciliation rows
  -> strategy canonical daily ledger
  -> certified MINT app returns/chart
```

## Publication and local-worktree notes

- Author required for commits: `tsiemasilo-dev
  <253701962+tsiemasilo-dev@users.noreply.github.com>`.
- Push requested after every deliberate code/document change.
- Wealth Navigator has unrelated dirty files (`next.config.ts`, IC governance
  migration, handover artifacts and `supabase/.temp/`). Do not stage or reset
  them unless explicitly asked.
- MINT branch is `features/fees2`; Wealth Navigator branch is `feat/Porting`.

## Immediate checklist

- [ ] Let REB-2026-002 be manually approved in UAT.
- [ ] Send it through its UAT order-book path and wait for actual fills.
- [ ] Run `UAT_REBALANCE_EVIDENCE_CHECK.sql` against its exact batch.
- [ ] Confirm model `strategies_c.holdings` changes only if scope is
      strategy-wide.
- [ ] Confirm app-facing strategy weights update only after that boundary and
      certified-return processing.
- [ ] Implement request-ID-scoped rebalance books for all future tests.
- [ ] Resume the ledger/Excel audit without changing public values until
      certification.

## 15 Aug 2026 continuation: static publication recovery

Six static strategies stopped receiving guarded publication rows after
10 Aug because they had no ACTIVE `strategy_valuation_rules_c` record. A
reviewed, idempotent migration restored rules for Blended Focus, ETF Basket,
MINT Diversified Basket, MINT Famous Brands, MINT Multi-sector and UCT from
their last fully checked publication anchor. No holding, price, investor
balance or historic return was overwritten.

The legacy RPC `calculate_daily_strategy_metrics('2026-08-14')` was tested and
failed safely with `relation "strategies" does not exist`. It belongs to the
old schema and is not the production guarded publisher. Do not repair it by
only renaming its table: its calculation contract is legacy and separate from
the current cash/rebalance chain.

Current writer ownership:

1. Primary strategy publisher: MINT `server/index.cjs`,
   `computeAndSaveStrategyReturns`, using `strategies_c`, effective composition
   logs, active valuation rules, a 15% daily spike guard and the guarded RPC.
2. Controlled fallback: Wealth Navigator
   `src/lib/returns/publish-eod-returns.ts`, opt-in only.
3. MyMintAdmin's `_returns-publish.js` remains retired; reconnecting it would
   create a competing writer.

A dry run found two defects in the fallback before any row was published:

- it treated `strategy_valuation_rules_c.effective_from` as the composition
  date, creating false rebalance bridges for newly seeded static rules;
- it read only recent intraday ticks, skipping SYGEMF and STXNDQ despite exact
  stored 14 Aug closes.

The fallback now resolves composition from `strategy_composition_log_c`,
requires an ACTIVE valuation rule, prefers the exact requested-date
`stock_returns_c` close, records price provenance and validates the oldest
timestamp used across all holdings. Public writes remain guarded and opt-in.

The first corrected 14 Aug dry run resolved all previously missing prices and
produced ordinary chain plans for UCT, Yield Basket, MINT Famous Brands, ETF
Basket, Blended Focus and MyGrowthFund. Diversified and Multi-sector exposed
real unsealed composition boundaries (the known 18 Jun GRT and 16 Jun NY1
evidence gaps). The fallback now refuses any such boundary; it never invents a
bridge. Those strategies remain stale/uncertified until their transition
evidence is repaired.

Operator command (dry-run unless the explicit apply flag is set):

```powershell
$env:EOD_RETURN_RECOVERY_DATE='2026-08-14'
.\node_modules\.bin\vite-node.cmd scripts\run-eod-return-recovery.ts
```

Only after the dry-run has no unexplained skips/failures:

```powershell
$env:APPLY_EOD_RETURN_RECOVERY='1'
.\node_modules\.bin\vite-node.cmd scripts\run-eod-return-recovery.ts
```

Verify the persisted rows without writing anything:

```powershell
$env:EOD_RETURN_RECOVERY_DATE='2026-08-14'
.\node_modules\.bin\vite-node.cmd scripts\verify-eod-return-recovery.ts
```

The post-apply idempotency run on 15 Aug returned zero failures. UCT, Yield
Basket, MINT Famous Brands, ETF Basket, Blended Focus and MyGrowthFund all
reported `already published today`; Test Strategy already had its own row.
MINT Diversified Basket and MINT Multi-sector remained blocked at their known
unsealed composition boundaries. This is the intended fail-closed result.
The verifier reads only columns that exist on the guarded audit table; daily
percentage fields remain consumer-view calculations and are not duplicated in
the audit-row verifier.

Persisted 14 Aug verification result (all six rows passed complete-value
identity, full price coverage, composition snapshot and chain reconciliation):

| Strategy | Securities cents | Continuity cash cents | Complete cents | YTD % |
| --- | ---: | ---: | ---: | ---: |
| Blended Focus | 500697 | 0 | 500697 | -0.9771813036 |
| ETF Basket | 237139 | 0 | 237139 | 14.2574680705 |
| MINT Famous Brands | 302764 | 0 | 302764 | 9.2726424089 |
| MyGrowthFund | 104680 | 57 | 104737 | 8.7069670537 |
| UCT | 113723 | 0 | 113723 | 10.9731301795 |
| Yield Basket | 184747 | 49194 | 233941 | 17.0657736272 |

Every row records `STORED_EOD_CLOSE`, `mode=chain`,
`composition_source=strategy_composition_log_c`, and
`boundary_bridge_required=false`. Diversified and Multi-sector have no 14 Aug
recovery row by design; evidence repair must precede their next publication.

Verification on 15 Aug:

- recovery dry-run after apply: 0 failures; published rows were idempotently
  skipped and both unsealed boundaries remained blocked;
- read-only persisted-row verifier: 6 rows, 6/6 complete-value identities;
- focused TypeScript compile of the publisher, Supabase server helper and both
  operator scripts: passed;
- `git diff --check`: passed;
- full repository `npm run typecheck`: still blocked by pre-existing errors in
  unrelated Bun tests, `office-crypto`, settlement fixtures and gift-worker
  fixtures; none of the errors reference the recovery files.

Next precision gate: use the read-only
`scripts/audit-unsealed-return-boundaries.ts` report to search all known retail
rebalance batches, execution events, cash events, reserve events and CA
reconciliations for the Diversified and Multi-sector composition changes. Do
not seal either boundary unless this report exposes exact, internally
consistent execution evidence.
The audit also checks the institutional `oems_order_audit` and
`oems_fill_settlement_c` mirrors for GRT/NY1 orders when institutional service
credentials are supplied; this is the final existing-system evidence search
before a boundary is classified as unsupported.

Retail boundary audit result on 15 Aug:

- MINT Diversified Basket: composition changed on 18 Jun from GRT 28 to 22,
  removed VKE/CML/INL and reduced DSY/MTN/SBK/MRP/STX500/STXNDQ. Retail contains
  no matching `rebalance_batch`, `rebalance_event`, cash event, reserve event or
  CA reconciliation for this strategy.
- MINT Multi-sector: composition changed on 16 Jun from NY1 6 to 4, removed TGA
  and added STX500 2. Retail contains no matching batch, event, cash event,
  reserve event or CA reconciliation.
- Therefore neither boundary may be sealed from Retail evidence. They remain
  deliberately stale/uncertified.
- The institutional GRT/NY1 order-mirror query was completed. It found no GRT
  order and only one unrelated NY1 order: manual buy order `700003` for two
  units on 27 Jul, cancelled with zero filled and no settlement record. It is
  not evidence for the 16 Jun model change.
- Final classification: the 18 Jun Diversified and 16 Jun Multi-sector
  boundaries are `UNSUPPORTED_EXECUTION_EVIDENCE`. Keep their affected periods
  stale/uncertified. Do not infer fills, proceeds or continuity cash from the
  composition deltas alone.

Next certification audit is implemented as the read-only
`scripts/audit-historical-certification-gaps.ts`. It compares Yield Basket and
ETF Basket inception metadata, effective compositions, valuation rules,
guarded publications, effective/raw return ranges, canonical DRAFT rows and
all stored STXID closes. Its purpose is to identify the exact first
unverifiable date before any promotion decision.

Historical certification audit result on 15 Aug:

- Yield Basket remains `DRAFT_REQUIRES_EVIDENCE`. The strategy was created on
  30 Jan 2026, while its composition log begins 1 Jan and its legacy raw rows
  begin in 2023. The 15 Jun and 1 Jul transitions have no matching batch or
  capital evidence; the 14 Jul batch also has no capital reconciliation.
- Yield's 13 Aug DRAFT Excel-leg result is YTD/SI `7.62670048%`; the guarded
  comparison is `16.2206%`, an `8.59389952` percentage-point variance. Do not
  promote either number as the Excel-certified answer until the transitions
  and opening capital are evidenced.
- ETF Basket was created on 20 Mar 2026. Legacy effective/raw history beginning
  in 2023 and the generic 1 Jan composition date must not be treated as ETF
  inception evidence.
- STXID is present in `stock_returns_c`: 214 rows from 1 Dec 2025 through
  14 Aug 2026. The actual ETF creation-date close is 4,517 cents and the 14 Aug
  close is 4,630 cents. The targeted required-date check has zero missing
  closes. The earlier STXID blocker was a Yahoo-provider gap/capped audit, not
  a missing canonical stored close.
- Safe next move: generate an insert-only ETF DRAFT ledger beginning 20 Mar
  2026 from its unchanged five-leg composition and stored closes. Do not use
  pre-creation legacy rows and do not expose DRAFT values to the MINT app.

ETF DRAFT staging is implemented in
`scripts/stage-etf-canonical-ledger.ts`. It is dry-run by default and refuses
to overwrite any existing ETF canonical row. It requires exactly one unchanged
five-leg composition, every JSE trading session from actual creation through
the latest guarded publication, and five exact stored closes per session. It
calculates 1D, 1W, WTD, 1M, 3M, YTD and SI from one NAV series. Set
`APPLY_CANONICAL_LEDGER_DRAFT=1` only after reviewing the dry-run summary.

First ETF dry run produced 100 fully priced JSE-session rows from 20 Mar through
14 Aug and exactly reconciled the 14 Aug close to 237,139 cents. Its 14 Aug
periods from the unified daily NAV series are: 1D -0.11456925%, 1W/WTD
0.66518941%, 1M 0.74173828%, 3M 0.07258395%, and YTD/SI 12.05305461%.
The guarded view's 1D 0.987565% and YTD 14.25746807% are not equivalent: the
former spans the last available guarded publication rather than the previous
trading-day close, while the latter inherits a legacy seed predating the
strategy's 20 Mar creation. Keep the new calculation DRAFT until independent
comparison, but treat this as a confirmed semantic defect in the old period
calculator.

Before inserting ETF DRAFT rows, run
`scripts/verify-etf-stored-closes-yahoo.ts`. It compares the five exact stored
JSE-session price series from 20 Mar through 14 Aug with Yahoo's independent
daily chart series, reports missing dates and cent variances per security, and
never writes to the database. A missing Yahoo series is evidence of provider
unavailability, not permission to invent or replace a close.

The 15 Aug independent-price attempt returned zero Yahoo 2026 points for all
five ETF symbols. Both documented Railway IRESS history domains returned
`Application not found`; the deployed OEMS API requires an authenticated staff
session. Therefore independent provider verification is currently unavailable,
not failed. ETF DRAFT rows must carry
`independent_provider_check=UNAVAILABLE_2026_SERIES` and remain blocked from
certification until a reviewed IRESS/export/workbook comparison is supplied.

The ETF DRAFT apply completed on 15 Aug: 100 JSE-session rows were inserted
from 20 Mar through 14 Aug. No public/effective return row was changed. Verify
the persisted result with `scripts/verify-etf-canonical-ledger.ts`; it requires
exact calendar coverage, DRAFT-only status, complete-value identity on every
row, the independent-provider block on every row, a single evidence hash and a
14 Aug complete value of 237,139 cents.

Persisted verification passed: 100/100 JSE dates matched, 100/100
complete-value identities passed, every row is DRAFT on
`excel-static-lot-v1`, every row records the provider-unavailable block, and
the latest seven period metrics equal the reviewed dry run. This completes ETF
DRAFT construction; it does not authorize certification or public cutover.
