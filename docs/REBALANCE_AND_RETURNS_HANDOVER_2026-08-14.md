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
