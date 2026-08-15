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

The next family-wide decision report is
`scripts/audit-canonical-ledger-family.ts`. It classifies every active non-test
strategy using actual creation date, composition count, rebalance evidence,
canonical row coverage, ACTIVE rule and latest guarded publication. Only a
strategy with one composition and zero rebalance batches can enter the generic
static DRAFT generator; all others remain evidence-dependent.

The Retail family audit ran successfully on 2026-08-15. It classified ETF
Basket, MINT Famous Brands and UCT as `STATIC_DRAFT_CANDIDATE`: each has one
composition interval and no rebalance batch. ETF already has 100 complete DRAFT
rows from its 2026-03-20 creation date through 2026-08-14. Famous Brands and UCT
each still have only their earlier single-row DRAFT checkpoint and are the next
safe reconstruction targets. MINT Diversified Basket (two compositions), MINT
Multi-sector (two compositions), MyGrowthFund (four compositions and three
settled batches), Yield Basket (four compositions and four batches), and Blended
Focus (one composition but one settled batch) are `EVIDENCE_DEPENDENT`. Those
five must not be treated as static histories. Their execution/capital boundaries
must be proved or explicitly bridged before full-history certification.

`scripts/stage-static-canonical-ledger.ts` now generalises the ETF methodology
for strategies proven static by the family audit. Its price reader paginates
`stock_returns_c`; this fixed a calculator defect where Supabase's 1,000-row
response cap made Famous Brands appear stale after 2026-07-24. Missing exact
session closes use only the last known prior close (never a future close), with
each carried leg labelled `STORED_PRIOR_CLOSE_CARRY_FORWARD` in evidence. The
script is dry-run by default, rejects any non-DRAFT conflict, and requires both
`APPLY_CANONICAL_LEDGER_DRAFT=1` and
`REPLACE_CONFLICTING_CANONICAL_DRAFT=1` before a conflicting DRAFT checkpoint
can be replaced.

On 2026-08-15, MINT Famous Brands was reconstructed to 135 DRAFT rows from
2026-01-30 through 2026-08-14. It has 16 carried legs, a latest complete value
of 302,764 cents and latest SI/YTD of 6.3023587324%. UCT was reconstructed to
90 DRAFT rows from 2026-04-07 through 2026-08-14. It has two carried legs, a
latest complete value of 113,723 cents and latest SI/YTD of 7.3891858203%.
Their pre-existing 2026-08-07 DRAFT checkpoints were the only conflicts and
were replaced: Famous Brands 307,996 -> 306,838 cents; UCT 113,410 -> 114,216
cents. An idempotent rerun found all 135 and 90 rows matching, zero missing rows
and zero remaining conflicts. These histories remain DRAFT and do not alter the
public app until an explicit certification/cutover decision.

The evidence-dependent family audit was then expanded using
`AUDIT_STRATEGIES` and `SKIP_INSTITUTIONAL_AUDIT`. Blended Focus has one settled
2026-05-11 boundary with two fills but no cash/reserve/reconciliation row. Its
before snapshot held 8 OUT; the current composition holds 2 OUT and 2 STX500.
The fills record sale of 6 OUT at 7,085 cents and purchase of 2 STX500 at
12,422 cents, which independently derives 17,666 cents of continuity cash per
model lot. This is the next evidence-supported segmented-ledger candidate.

MyGrowthFund has three settled batches and twelve fills. Its two 2026-08-03
batches have cash/reserve evidence and CA reconciliations (103,847 = 103,847 +
0 cents, then 103,800 = 103,743 + 57 cents). Its earlier 2026-07-23 batch has no
reconciliation and must be separately bridged. Yield Basket has four batches
(three settled and one reversed) and twelve fills but zero cash, reserve or CA
reconciliation rows; it remains blocked from certification. Diversified and
Multi-sector remain unsupported because their composition changes have no
Retail settlement evidence at all.

`scripts/stage-single-boundary-canonical-ledger.ts` now reconstructs and
validates the Blended Focus boundary. It refuses incomplete fills, requires fill
unit deltas to reproduce the post-boundary composition, derives continuity cash
from actual fills, paginates stored closes, labels prior-close carries, and
protects all non-DRAFT rows from replacement. The 2026-05-11 evidence exactly
reconciles OUT -6 and STX500 +2 with 17,666 cents remaining as strategy cash.
The boundary moved from 515,824 cents on 2026-05-08 to 520,246 cents on
2026-05-11, a normal +0.8572691461% return rather than a rebalance spike.

Blended Focus now has 135 matching DRAFT ledger rows from 2026-01-30 through
2026-08-14. The old 2026-08-12 DRAFT checkpoint (502,292 cents, cash omitted)
was replaced by the complete 520,232-cent value. The latest row is 500,697
cents of securities plus 17,666 cents of continuity cash = 518,363 cents, with
an initial simple-NAV SI/YTD of -1.0170158243% (superseded below). An
idempotent rerun found 135 existing matches, zero
missing rows and zero conflicts. Its guarded public publication still shows
500,697 cents and remains unchanged until certification/cutover.

That first Blended pass correctly reconstructed complete value but still used a
plain NAV-ratio return. The CEO workbook was re-opened and its formulas in
`06_Strategy_Ledger` and `07_Public_Strategy_View` were followed literally:
each starting, sold and rebalance-buy leg has its own entry/exit dates and
prices; period benchmarks use `MAX(leg entry date, mapped reference date)`;
closed legs after the benchmark contribute realised P/L; and return is summed
leg P/L divided by summed leg benchmarks. Recycled sale capital is represented
by the replacement leg plus any genuinely undeployed CASH leg, not treated as
unexplained performance.

Blended was therefore upgraded to `excel-leg-pnl-boundary-v2`. The latest DRAFT
complete value remains 518,363 cents, but the workbook-style returns are now:
1D -0.7731593677%, 1W/WTD -0.1188870477%, 1M 1.2206314244%, 3M
-0.7212776919%, and YTD/SI -0.9406586730%. Every metric carries a per-leg trace
of benchmark value, numerator value and P/L. All 135 DRAFT rows were replaced
with v2, then an idempotent rerun returned 135 matches, zero inserts, zero
conflicts and zero writes. The earlier -1.0170158243% was the superseded simple
NAV-ratio result and must not be promoted.

The MyGrowth evidence then clarified a second accounting distinction: raw
sell-minus-buy residual is not automatically public strategy CA. Client
`REBALANCE_RESIDUAL` balances can receive that cash, while public model CA is
authoritative only when recorded by
`strategy_rebalance_ca_reconciliation_c.strategy_ca_cents`. Blended has no CA
reconciliation and its batch records `net_proceeds = 0`, so fail-closed model
CA is zero. The realised OUT proceeds still contribute to the closed leg's P/L;
they are not lost, but the R176.66 residual must not be added to current public
basket value as unsupported cash.

Blended was therefore finalised as DRAFT version
`excel-leg-pnl-authoritative-ca-v3`: latest securities/complete value 500,697
cents, CA zero, 1D -0.8002203132%, 1W/WTD -0.1230765548%, 1M 1.2642432136%,
3M -0.7465364160%, and YTD/SI -0.9709534340%. The guarded value is also
500,697 cents and guarded YTD is -0.9771813036%, a difference of only
0.0062278696 percentage points. All 135 v3 DRAFT rows passed the final
idempotency check with zero inserts, conflicts, replacements or writes. The v2
518,363-cent cash-inclusive result is superseded and must not be promoted.

Important chart rule: a rebalance that returns residual capital to clients can
change raw open-basket value even though investment performance is continuous.
Charts must therefore use the canonical leg-P/L return/index series, never raw
`complete_value_cents` as an unadjusted chart ordinate across such a boundary.

## MyGrowth owner-level forensic audit and family isolation (2026-08-15)

The CEO-era MyGrowth process has now been checked against Retail records with
`scripts/audit-mygrowth-owner-rebalance.ts`. The script is read-only and emits
strategy compositions, batches, owner-scoped holdings, fills, residuals,
reserve evidence and model-CA reconciliations. Set
`AUDIT_SUMMARY_ONLY=1` for the compact owner/event report.

The evidence corroborates the operational account of a partial, irregular
rebalance. MyGrowth currently has six distinct owner accounts, but its twelve
historical `rebalance_event` rows cover only two owners: Siliziwe Mafika and
Ncumolwethu Damane. On the final 2026-08-03 boundary, Siliziwe bought the model
quantity of four STXACW while Ncumolwethu bought five; Ncumolwethu's active
holding still carries five. Luli Maswanganye remains on the pre-rebalance
basket. Zenande Sidlayi and Tsie M Masilo each carry 18 STXCAP rather than the
model seven. Mpumelelo Maswanganye has the current model quantities but all four
rows remain unfilled. These differences must be treated as owner-level facts,
not silently normalised into model history.

The first 2026-07-23 MyGrowth boundary has owner cash/reserve events but no
model-CA reconciliation. The first 2026-08-03 boundary certifies model CA of
zero cents; the second certifies 57 cents. Client residual balances are not
model CA. No other CA amount may be inferred from proceeds or owner residuals.
Before certifying another strategy, obtain the business owner's explicit list
of strategies intended to carry model CA and reconcile each list entry to
`strategy_rebalance_ca_reconciliation_c`.

MINT Diversified Basket has two stored composition intervals but no current
owner holdings, no `rebalance_batch`, and no `rebalance_event`. Its June
composition change is therefore not a proven executed rebalance and remains
uncertified.

The OEM path had a structural family-ownership defect: strategy-wide grouping,
single-client filtering and some order payloads used only `user_id`, allowing a
parent and family member to be merged. The 2026-08-15 fix makes the effective
owner key `(user_id, family_member_id)` across the impact preview, parked and
settled order booking, completion evidence and post-fill cash settlement. When
an old order payload says `family_member_id=null`, the completion and cash
writers now recover the authoritative owner from the touched holding. Residual
and execution-reserve reads are also family-scoped, and the atomic settlement
RPC receives `family_member_id`.

This prevents new single-owner or family-member rebalances from reproducing the
historical cross-owner corruption. It does not rewrite the historical MyGrowth
rows; any correction of those rows requires a separately approved,
owner-by-owner reconciliation.

## Strategy CA at new purchase, separate from the 8% reserve (2026-08-15)

The purchase contract now follows the same accounting identity as the
cash-aware front end and return ledger:

`complete model value = securities value + model CA`

Model CA is strategy capital. The 8% execution reserve is owner-level money
held against execution variance and fees. They are deliberately distinct:

- `strategy_valuation_rules_c.continuity_cash_per_lot_cents` is the effective
  model CA per whole strategy lot;
- `strategy_rebalance_residuals.balance_cents` carries the owner's allocated
  strategy cash sleeve;
- `transactions.buffer_cents - buffer_consumed_cents` is the unused execution
  reserve and must never be added to model CA;
- the reserve is charged at purchase and the current implementation can consume
  it for rebalance brokerage/custody fees, buy-fill slippage and gated month-end
  AUM settlement; any remainder is returned on a full exit;
- the complete purchase denominator is securities per lot plus model CA per
  lot, while the existing capped reserve bridge may cover a small price drift
  but may not mint an extra lot.

The read-only `scripts/audit-strategy-model-cash.ts` inventory found active
model CA of 57 cents per lot for MyGrowthFund and 49,194 cents per lot for
Yield Basket. The other non-test active strategies currently have zero model
CA. No current composition JSON contains an explicit synthetic CASH holding;
the authoritative amount is therefore the effective ACTIVE valuation rule and
its reconciliation evidence, not an invented ticker leg.

Migration `20260815000001_strategy_purchase_model_cash.sql` reuses existing
balance tables rather than creating another cash ledger. It adds explicit
purchase evidence to `transactions` (`strategy_id`, model lots, model cash and
allocation timestamp) and creates the service-role-only, idempotent
`record_strategy_purchase_with_model_cash` RPC. The RPC locks the purchase,
reads the effective CA rule itself, inserts all pending security holdings,
credits `model lots × CA per lot` to the exact `(user_id, family_member_id,
strategy_id)` residual balance, and stamps the transaction in one database
transaction. It accepts no client-provided cash amount.

Both `api/record-investment.js` and `api/child-invest.js` call that RPC. Both
derive whole lots server-side from the complete model value. The child route no
longer trusts its legacy client-supplied units field. Focused investment tests
cover the separation with a R400 lot made of R350 securities and R50 CA: five
lots allocate R250 CA while the R160 8% reserve remains on the transaction.

Deployment order is mandatory: apply the Wealth Navigator migration before
deploying the MINT purchase API changes. The RPC fails closed if the migration
or an effective ACTIVE CA rule is missing, so no client can be charged and left
with only part of a strategy allocation.

The business owner clarified that Siliziwe, Ncumolwethu and the KG account are
the real accounts relevant to the historical MyGrowth review; the remaining
accounts may be excluded as UAT-like for that certification exercise. Match KG
to an exact database identity before any historical correction—initials alone
are not sufficient evidence.

Next after deployment: audit pre-migration purchases for those confirmed real
owners and Yield Basket, then prepare a separately reviewed, idempotent
backfill. Do not infer missing model CA from client residuals, reserve balances
or sell proceeds.

### Post-migration historical purchase audit result

`scripts/audit-pre-migration-model-cash.ts` now performs that audit without any
writes. It considers only non-test strategies with a non-zero effective ACTIVE
CA rule, joins each purchase through its transaction-linked active holdings,
and accepts model lots only when every constituent has the same positive whole
number ratio to the effective composition. It reports the owner's current
residual and the transaction's 8% reserve separately. Test Strategy and owners
whose profile is marked `is_test=true` can never become backfill candidates.

The 2026-08-15 run found three purchase groups after a non-zero CA rule became
effective. All three were Yield Basket transactions owned by the explicitly
test-marked Mpumelelo Maswanganye profile and were classified
`EXCLUDED_TEST_PROFILE`. One reproduced exactly one Yield model lot; the other
two had zero purchase base and inconsistent constituent ratios. There were no
eligible LIVE backfill candidates and no MyGrowth post-rule transaction-linked
purchase gap.

Therefore no historical write migration is warranted from the available
evidence. Existing real MyGrowth owners received or failed to receive cash at
the rebalance settlement boundary, which must be reconciled against their
batch/cash/reserve evidence—not rewritten as a purchase credit. Future adult
and child purchases are protected by the atomic purchase RPC already deployed.

### MyGrowth independently anchored post-boundary ledger

`scripts/stage-mygrowth-post-boundary-ledger.ts` now reconstructs the proven
MyGrowth segment beginning 2026-08-03. It requires exactly the two settled
COMPLETE batches on that date, both CA reconciliations, the final open
composition and an ACTIVE rule whose 57-cent CA equals the last reconciliation.
The public model remains four STXACW; Ncumolwethu's fifth share is explicitly
recorded as an owner-level exception and cannot change the model ledger.

The 2026-08-15 dry run produced nine exact JSE-session rows through 14 Aug. The
latest row is 104,680 cents of securities plus 57 cents of CA = 104,737 cents,
with zero-cent variance to the guarded publication. Latest 1D is
-0.2181658823%; 1W and WTD are -0.5799825341%. The 1M, 3M, YTD and SI metrics
are null with `REFERENCE_PRECEDES_PROVEN_2026_08_03_CA_BOUNDARY`, because those
ranges cross the unreconciled 23 Jul boundary.

The DRAFT apply inserted eight new rows and replaced the single old 12 Aug
`excel-leg-v1` DRAFT checkpoint (105,065 cents) with the exact-close result
(105,196 cents). No certified/public row was touched. An immediate idempotency
rerun returned nine matching sessions, zero inserts, zero conflicts, zero
replacements, zero writes and zero-cent latest variance. Ledger version is
`excel-segmented-post-ca-boundary-v1`.

### MyGrowth 23 July historical boundary repair

`scripts/audit-mygrowth-20260723-boundary.ts` independently rechecks the missing
23 Jul CA reconciliation. It requires the settled COMPLETE batch, exact model
delta (`STX40 -3`, `GLPROP +3`), matching fill/cash/reserve owner sets, complete
fill prices, exact stored 23 Jul closes and a later authoritative zero-CA
checkpoint.

The read-only audit passed every identity for both affected real owners. Per
owner, STX40 sale proceeds were 30,105 cents, GLPROP cost was 15,258 cents and
the 14,847-cent difference exactly matched the credited owner residual. Each
owner's 5,227-cent rebalance fee was fully consumed from their separate 8%
execution reserve with zero shortfall. The exact after-model close was 127,842
cents: STXNDQ 53,840 + SYGEMF 9,324 + SYG500 49,420 + GLPROP 15,258. The next
3 Aug CA checkpoint independently records zero CA.

This supports the missing public-model identity `127,842 = 127,842 + 0` without
converting owner residual or reserve into model cash. Migration
`20260815000002_mygrowth_20260723_ca_reconciliation.sql` is idempotent and
fail-closed: it rechecks the immutable totals and exact closes before inserting
the single missing reconciliation, refuses conflicting existing evidence and
does not alter holdings, client cash, reserve, canonical returns or public
values. After it is applied, rerun the audit and then extend the MyGrowth
workbook ledger across the newly evidenced boundary.

### MyGrowth full multi-boundary canonical ledger

After the 23 July reconciliation was applied, the read-only audit found the
stored row and reproduced it exactly. `scripts/stage-mygrowth-canonical-ledger.ts`
now reconstructs MyGrowth from its first JSE session on 20 April 2026 through
the latest guarded publication. It validates all four dated compositions, all
three settled/COMPLETE batches, all three CA reconciliations, and a single
unambiguous model fill price for every model-unit delta. Same-day 3 August
boundaries are applied in creation order. Ncumolwethu's extra fifth STXACW
share remains an owner exception and is excluded from the four-share public
model.

The 2026-08-15 dry run produced 81 daily JSE-session rows through 14 August,
with four explicitly labelled prior-close carries. The latest row is 104,680
cents of securities plus 57 cents of authoritative strategy CA = 104,737
cents, exactly matching the guarded publication. Period returns use the Excel
leg-P/L method across exits and entries instead of raw basket-value jumps. The
latest computed values are 1D -0.2181658823%, 1W/WTD -0.5799825341%, 1M
-0.5903384746%, 3M -1.9343315033%, and YTD/SI 1.8835008744%. The old guarded
YTD is 8.7069670537%; this material methodology difference remains DRAFT and
must not reach the app until workbook and provider certification pass.

Draft replacement is a single upsert statement keyed by strategy/date. It can
replace only DRAFT conflicts and refuses any certified conflict. The previous
nine-row post-August draft is therefore superseded without a delete/insert
gap, while public values remain untouched.

### AUM read-only reconciliation

The 2026-08-15 live-data audit defines current AUM as active securities at the
latest available price + unused transaction reserve + strategy rebalance
residual - already-consumed AUM fees, grouped by owner/family/strategy. Test
profiles, test wallets and UAT strategies are excluded.

Canonical LIVE AUM was R19,763.91. The Cockpit `/api/client-book` legacy
snapshot route returned R16,822.53, understating AUM by R2,941.38 because it
sums the latest `client_strategy_returns_c` snapshot instead of current
holdings and cash. `/api/strategies` returned R19,779.11, overstating AUM by
R15.20; that variance exactly equals AUM fees already consumed but not
subtracted by that route. No UAT value leaked into this snapshot. Both routes
must be moved to one shared holdings-based server calculation before this AUM
audit is considered closed.

`src/lib/aum/canonical-retail-aum.ts` now implements that shared calculation.
It fails closed when a valid holding lacks a market price, prefers recent
intraday evidence, then stored EOD closes, and only then the security's stored
last price. Structurally invalid holdings without an owner, strategy or
security are excluded before UUID queries. Transaction reserve is counted once
per owner/family/strategy position and only for posted, unreversed purchases.

Both `/api/strategies` and `/api/client-book` now consume the shared result.
The client-book keeps the legacy snapshot only for its separate day/YTD P&L
fields. Focused tests cover one-time reserve/residual counting, fee subtraction
and independent UAT/test exclusion. A live read-only rerun reproduced the
audited total exactly: 1,976,391 cents (R19,763.91), including 1,520 cents of
consumed AUM fees removed once, across six real investors and 33 active holding
rows. No database write is involved in the AUM calculation.
