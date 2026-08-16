# Canonical daily strategy certification

## Outcome

`strategy_canonical_daily_ledger_c` is the one physical public strategy ledger.
The MINT app reads only rows whose `certification_status` is `CERTIFIED`. The
daily process extends that ledger after the JSE close without performing return
calculations in the browser.

```text
Yahoo official closes -> stock_returns_c
                              |
                              v
canonical-ledger-daily (17:30 UTC, weekdays)
  1. exact-close DRAFT reconstruction
  2. SQL re-price + cash + evidence checks under row lock
                              |
                 pass --------+-------- fail
                  |                     |
                  v                     v
              CERTIFIED              stays DRAFT
                  |
                  v
       /api/returns/approved -> every MINT strategy card/chart/factsheet
```

## Components

| Component | Purpose |
|---|---|
| `src/lib/returns/publish-canonical-ledger-draft.ts` | Reconstructs the Excel-style row from the effective model composition, exact stored closes, strategy CA and settled rebalance evidence. |
| `src/lib/returns/publish-canonical-ledger-certification.ts` | Runs readable prechecks and asks the atomic SQL function to promote the DRAFT. |
| `src/app/api/cron/canonical-ledger-daily/route.ts` | The only scheduled orchestration route: DRAFT first, certification second. |
| `strategy_canonical_daily_ledger_c` | The single physical public ledger; DRAFT rows are invisible to the app. |
| `certify_strategy_canonical_daily_ledger_c` | Repeats material checks in PostgreSQL under a row lock and records a non-human system actor. |
| `get_strategy_return_range_audit_c` | Read-only operations comparison for the guarded publication chain. It never certifies or writes values. |

## Certification gates

A row remains DRAFT if any gate fails:

1. The date is not a confirmed JSE trading day.
2. The immediately preceding canonical checkpoint is not CERTIFIED.
3. The evidence hash changed between inspection and promotion.
4. `complete = securities + continuity cash` does not hold exactly.
5. Any active model holding lacks an exact `stock_returns_c` close for the date.
6. PostgreSQL's independent re-price differs by even one cent.
7. Strategy CA differs from the effective ACTIVE valuation rule.
8. Any of 1D, 1W, WTD, 1M, 3M, YTD or SI lacks a date, denominator or return.
9. Composition or CA changed without a settled, complete, unreversed rebalance,
   fills, CA reconciliation and an evidence-backed boundary rebuild.
10. The strategy has no manually certified seed. New strategies deliberately
    stop here for first-day review; subsequent days are automatic.

## Idempotency and failure behaviour

- Re-running the cron for an already certified date returns
  `already-certified`; it does not rewrite the row.
- A failed certification leaves the DRAFT and the previous certified public
  close untouched. The app therefore shows stale-but-labelled certified truth,
  never a partially trusted value.
- A DRAFT evidence hash is passed into the RPC and checked again after locking,
  preventing a concurrent draft replacement from being certified accidentally.
- Certification uses `certification_actor = SYSTEM:WEALTH_NAVIGATOR_DAILY_V1`.
  It does not impersonate a staff member's `auth.users` identity.

## Deployment order

1. Apply migrations in order:
   - `20260816000003_automatic_canonical_daily_certification.sql`
   - `20260816000004_strategy_return_range_audit_rpc.sql`
2. Confirm `CRON_SECRET` exists in the Wealth Navigator Vercel project. The new
   endpoint refuses to run when it is absent.
3. Deploy the Wealth Navigator branch.
4. Invoke a read-safe historical date that is already certified. Expected:
   the draft writer skips the immutable row and certification reports
   `already-certified` for every active non-test strategy.
5. On the next JSE close, confirm the route returns `phase: complete` and the
   count `certified + alreadyCertified = total`.
6. Query the ledger: every published strategy should share the same latest
   certified trading date; any DRAFT must include the exact blocking reason in
   the route logs.

## New strategies

A newly curated strategy automatically participates in DRAFT generation when
it has an active composition, an ACTIVE valuation rule and exact closes. Its
first row intentionally remains DRAFT until staff certify the inception model
and evidence. From the next trading close onward, the normal automatic chain
continues without adding a new table or frontend calculation.

## Independent provider cross-check

Automatic certification is based on the exact EOD closes already persisted in
`stock_returns_c`; the SQL gate independently re-prices every active model leg
from those stored closes. Yahoo/IRESS comparison remains a separate audit so a
provider outage or unit-scale error cannot silently change public values.

As at 2026-08-16, the external Yahoo comparison for `STXID` is quarantined
because its observed Yahoo-to-stored scale is approximately 0.00998. ETF Basket
and Yield Basket therefore do not yet have independent Yahoo sign-off for that
leg. This does not bypass the exact stored-close certification checks. Resolve
the quarantine with authoritative IRESS history before calling those two
strategies externally provider-certified.
