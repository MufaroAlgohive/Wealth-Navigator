# MINT Canonical Returns, Valuation and AUM Operations Handbook

Version: 1.0  
Operational owner: MINT Engineering and Investment Operations  
Applies to: MINT app, Wealth Navigator OEM, daily close publication, strategy rebalances and LIVE retail AUM

## 1. Executive answer

The single physical source-of-truth table for public strategy performance is:

`public.strategy_canonical_daily_ledger_c`

Only rows whose `certification_status = 'CERTIFIED'` are fit for public display. A DRAFT row is evidence that the daily calculation ran, not permission to publish it. The last certified close remains public if a newer date cannot be certified.

This table is deliberately not the only table in the system. It is the final strategy-performance ledger. Prices, strategy definitions, rebalances, cash movements and client ownership remain separate evidence ledgers. Combining those into one mutable table would destroy provenance and make reconciliation harder.

The single LIVE retail AUM calculation is implemented in `src/lib/aum/canonical-retail-aum.ts`. It is consumed by Cockpit, Strategies, Finance, Investors, Wealth Manager, Research Lab and Equities. Test users and UAT strategies are excluded by `src/lib/aum/retail-live-scope.ts`.

## 2. Two truths that must not be confused

| Truth | Meaning | Canonical source |
|---|---|---|
| Strategy model truth | What one model lot was worth on a trading date and its 1D, 1W, WTD, 1M, 3M, YTD and SI returns | `strategy_canonical_daily_ledger_c` CERTIFIED rows |
| Client AUM truth | Current LIVE client assets: marked securities plus client cash sleeves less consumed fees | shared `loadCanonicalRetailAum()` calculation |

The strategy ledger cannot be summed to produce client AUM. The model represents one basket lot; AUM represents real owners, quantities and cash sleeves.

## 3. Architecture

```text
Yahoo official JSE closes
        |
        v
stock_returns_c ---- jse_trading_calendar
        |                     |
        +----------+----------+
                   v
strategies_c + strategy_valuation_rules_c
                   |
rebalance_batch + rebalance_event + cash/reserve evidence
                   |
                   v
strategy_canonical_daily_ledger_c
        DRAFT -> validation -> CERTIFIED
                   |
                   v
strategy_returns_effective_c / latest read contract
                   |
     +-------------+-------------+
     v             v             v
MINT cards      charts       factsheets/OEM

LIVE holdings + latest prices + unused reserve + residual - consumed fees
                   |
                   v
loadCanonicalRetailAum()
                   |
     +-------------+-------------+----------------+
     v             v             v                v
Cockpit         Finance       Investors       Wealth Manager
Strategies      Research Lab  Equities        client-book API
```

## 4. Lonwabo workbook fidelity

The implementation follows the workbook's control model rather than copying only its final percentage.

| Workbook sheet | System equivalent | Purpose |
|---|---|---|
| Start Here | this handbook and runbook | Operating rules and safe sequence |
| Master Data | `strategies_c`, `securities_c`, `stock_returns_c`, `jse_trading_calendar`, valuation rules | Stable identifiers, inception dates, units and verified closes |
| Rebalance Events | `rebalance_batch`, `rebalance_event`, reconciliation, cash and reserve event tables | Exact boundary evidence for composition and cash |
| Strategy Ledger | `strategy_canonical_daily_ledger_c` | Date-by-date securities, cash and complete value |
| Public Strategy View | CERTIFIED read contract | Public period returns and current value |
| Chart Data | certified date and complete-value series | One ordered chart series using the same numerator as the headline |

The workbook identity `Complete value = Securities + Cash` is enforced by a database check. Period returns store their reference date, numerator, denominator and result inside `period_metrics`; this makes a value auditable without reverse-engineering frontend code.

## 5. Canonical strategy ledger schema

Primary key: `(strategy_id, as_of_date)`.

| Column | Meaning | Operational rule |
|---|---|---|
| `strategy_id` | FK to the strategy | Never infer by display name |
| `as_of_date` | JSE trading close represented | Must be a valid close date |
| `ledger_version` | calculation contract version | Increment only for a real methodology change |
| `certification_status` | DRAFT, CERTIFIED or REJECTED | Public reads use CERTIFIED only |
| `securities_value_cents` | total marked model securities | Integer cents |
| `continuity_cash_cents` | strategy cash carried across boundaries | Never confuse with the client's 8% reserve |
| `complete_value_cents` | securities plus continuity cash | Database-enforced equality |
| `leg_snapshot` | units, ticker, close and value for every leg | Audit evidence for valuation |
| `period_metrics` | 1D, 1W, WTD, 1M, 3M, YTD and SI references/results | Dates and math travel together |
| `source_evidence` | price and boundary evidence | Must identify sources, never invented values |
| `source_evidence_sha256` | integrity fingerprint | Detects silent evidence mutation |
| `calculation_notes` | exceptions and reasoning | Human-readable audit trail |
| `certified_at`, `certified_by` | approval evidence | Required for controlled publication |

## 6. Supporting tables and keys

### Market and calendar evidence

| Table | Important key | Role |
|---|---|---|
| `stock_returns_c` | security/symbol plus `as_of_date` | Official daily close input and price history |
| `jse_trading_calendar` | calendar date | Trading-day and holiday decision |
| `securities_c` | `id`, stable symbol | Security identity and last-resort metadata |

Yahoo supplies prices and actual trading dates. The local calendar supplies the explicit operational expectation. Missing a required exact close causes a DRAFT, not a fabricated carry-forward.

### Strategy and rebalance evidence

| Table | Important key | Role |
|---|---|---|
| `strategies_c` | `id` | Strategy definition, inception and current holdings model |
| `strategy_valuation_rules_c` | strategy plus effective range | Controlled anchor/continuity rule |
| `rebalance_batch` | `id`, `strategy_id`, predecessor | Lifecycle and before/planned/after snapshots |
| `rebalance_event` | `batch_id`, owner, security | Executed BUY/SELL evidence |
| `strategy_rebalance_ca_reconciliation_c` | unique `batch_id` | Proves model capital equals securities plus strategy CA |
| `strategy_rebalance_cash_events_c` | batch/strategy/owner/type | Append-only residual and liquidation cash movements |
| `strategy_rebalance_reserve_events_c` | batch/strategy/owner | Requested, consumed and remaining execution reserve |
| `strategy_rebalance_residuals` | owner/strategy/family scope | Current client rebalance residual balance |

Rebalance tables are evidence, not duplicates of the canonical ledger. They explain why the composition or continuity cash changed. They must not be deleted during return-table cleanup.

### Client AUM and fee evidence

| Table | Important key | Role |
|---|---|---|
| `stock_holdings_c` | owner/family/strategy/security | Active owned quantities |
| `transactions` | `id` | Funding transaction and unused 8% reserve |
| `strategy_aum_fee_state` | owner/family/strategy | Consumed AUM fee deducted from value |
| `aum_fee_accrual_segments` | owner/family/strategy/date segment | Static-cost-basis fee accrual evidence |
| `aum_fee_transactions` | fee event ID | Settled fee transactions where applicable |

LIVE AUM formula:

`AUM = marked active securities + unused transaction reserve + rebalance residual - consumed AUM fees`

The 8% reserve is client cash reserved for execution/fees. It is counted once. Strategy continuity cash is a model asset and is not the same balance.

Management fee contract:

`Monthly fee = static cost basis x 0.99% / 12`

It is recognised at month end. Finance reads the persisted accrual ledger; it must never recompute this fee from current market value.

## 7. Daily close and certification lifecycle

1. The market worker stores official closes in `stock_returns_c`.
2. The scheduled canonical job runs after the expected JSE close window.
3. The job identifies each LIVE strategy and the required as-of trading date.
4. Every current leg is matched to an exact official close.
5. The active composition and any rebalance boundary are reconstructed from evidence.
6. Securities value and continuity cash are calculated in cents.
7. Reference dates for all periods are resolved using prior-close rules.
8. A DRAFT row with complete evidence is written.
9. Certification checks validate value identity, close coverage, previous certified continuity and sealed rebalance boundaries.
10. Passing rows become CERTIFIED; failing rows remain DRAFT with reasons.
11. Public reads expose the newest certified row and never a partial newer row.

The schedule is weekdays at 17:30 UTC / 19:30 SAST. Market holidays should produce no false missing-close incident because the calendar resolves the expected trading date.

## 8. Rebalance boundary rules

A rebalance must not create a return spike. The value immediately before and after the boundary must reconcile:

```text
value before = sold assets + retained assets + opening strategy cash
value after  = bought assets + retained assets + closing strategy cash
economic difference = explicit costs or real market movement only
```

A composition change is published only when the settlement boundary is sealed and the evidence writes succeed. A failed or partial settlement stays resumable. Never overwrite the old composition merely because an order was created or approved.

## 9. API and page call map

| Page/surface | API or server function | Canonical source |
|---|---|---|
| OEM Cockpit Platform AUM | `GET /api/client-book` | `loadCanonicalRetailAum()` |
| OEM Strategies AUM | `GET /api/strategies` | `loadCanonicalRetailAum().byStrategy` |
| OEM Finance Platform AUM | `GET /api/admin/finance` | `loadCanonicalRetailAum()` |
| OEM Investors Total/client AUM | `GET /api/admin/investors/data` | canonical summary and positions |
| Wealth Manager client list | `GET /api/wm/clients` | canonical positions grouped by owner |
| Research Lab AUM/investors | server loader | canonical strategy aggregate |
| Equities Platform AUM | `GET /api/client-book` | same Cockpit total |
| Factsheets | `GET /api/admin/factsheets` | effective certified strategy returns |
| Source of Truth | `GET /api/admin/source-of-truth` | canonical ledger plus evidence |

Test profiles, test wallets and UAT strategies are excluded from all LIVE AUM and LIVE factsheet/audit lists. Dedicated UAT committee and rebalance surfaces remain separate by design.

## 10. Troubleshooting matrix

| Symptom | Meaning | First place to check | Safe action |
|---|---|---|---|
| YTD is stuck on an old date | No newer certified row is available | latest rows/status in `strategy_canonical_daily_ledger_c` | Read DRAFT notes; fix missing evidence, do not edit YTD manually |
| YTD is blank | certified range/reference missing or API did not receive a certified row | `period_metrics`, effective read view, API response | Repair certification input then rerun job |
| Chart rises while headline is negative | chart and headline use different bases/ranges | API chart payload and period selector | Make both use the same certified series/reference date |
| Sudden rebalance spike | composition changed without continuity cash/boundary reconciliation | batch snapshots, rebalance events, CA reconciliation | seal/repair boundary; never smooth the chart cosmetically |
| Minimum investment suddenly drops | model cash omitted or wrong active rule | latest certified complete value and active valuation rule | restore evidence-backed continuity cash/rule |
| One OEM page AUM differs | page is independently summing legacy NAV rows | network call and AUM methodology flag | point it to canonical helper/client-book |
| AUM is too high | tests/UAT included, reserve doubled, or stale inactive holdings counted | live-scope classifier, transaction IDs, holding status | correct classification; never subtract an unexplained plug |
| AUM is too low | residual/reserve omitted, quote absent, or consumed fee doubled | canonical breakdown by position | repair missing evidence and rerun |
| Fee differs by page | a page recomputed from current value/rate payload | `aum_fee_accrual_segments` and Finance API | use persisted 0.99% static-cost-basis ledger |
| Strategy stays DRAFT | missing close, previous certification, value mismatch or unsealed rebalance | `calculation_notes` and `source_evidence` | fix the named prerequisite only |
| Monday shows Friday close | normally correct before Monday JSE close | calendar and latest certified as-of | no action unless a later expected close exists |

## 11. Quick diagnostic queries

Latest certification status:

```sql
select strategy_id, as_of_date, certification_status,
       complete_value_cents, calculation_notes
from public.strategy_canonical_daily_ledger_c
order by as_of_date desc, strategy_id;
```

Public date alignment:

```sql
select as_of_date, certification_status, count(*)
from public.strategy_canonical_daily_ledger_c
group by as_of_date, certification_status
order by as_of_date desc;
```

Value identity:

```sql
select strategy_id, as_of_date,
       complete_value_cents - securities_value_cents - continuity_cash_cents as difference_cents
from public.strategy_canonical_daily_ledger_c
where complete_value_cents <> securities_value_cents + continuity_cash_cents;
```

LIVE/UAT classification:

```sql
select id, name, short_name, slug, status, investor_environment
from public.strategies_c
order by investor_environment, name;
```

## 12. Change-control safeguards

- Keep all monetary calculations in integer cents until presentation.
- Use immutable IDs, not names or tickers, as joins.
- Never certify a date using a convenient price from another date.
- Never use browser-side calculations as the authoritative return.
- Never convert a DRAFT to CERTIFIED merely to populate a blank UI.
- Never count strategy continuity cash and client reserve as the same thing.
- Never charge or display the 8% reserve twice.
- Never allow a UAT strategy or test account into LIVE AUM.
- Preserve rebalance idempotency: retries must not duplicate cash, reserve or holding writes.
- A new strategy needs an inception seed/certified starting row before automatic daily chaining can continue.
- A methodology change requires a version, evidence, parallel comparison and controlled cutover.

## 13. Legacy cleanup plan

Cleanup is intentionally deferred until migration proof is complete. Deleting tables now would break remaining effective-view fallbacks and remove audit evidence.

### Never delete as part of returns cleanup

`stock_returns_c`, `jse_trading_calendar`, `strategies_c`, `securities_c`, `strategy_valuation_rules_c`, every `rebalance_*` evidence table, strategy cash/reserve/residual tables, holdings, transactions and AUM fee ledgers.

### Candidates for later retirement after dependency audit

Legacy raw/effective return objects such as `strategies_returns_c`, `strategy_daily_ledger_c`, `strategy_ledger_return_audit_c`, `strategy_ledger_return_range_audit_c`, `strategy_ledger_flow_candidate_c` and old direct-read compatibility views may become removable. A view is removable only after `rg`, database dependency inspection and production telemetry prove zero consumers.

### Required exit criteria

1. At least 10 consecutive JSE trading closes are CERTIFIED for every LIVE strategy on the same expected date.
2. At least one complete settled rebalance has passed boundary, cash and chart checks.
3. No frontend/API directly reads a legacy strategy-return table except an explicitly documented compatibility view.
4. A rollback export and row counts are stored.
5. The removal is a separate, review-only migration with no simultaneous formula change.
6. Production build and targeted canonical/AUM tests pass.

The recommended cleanup date is after these criteria are met—not a calendar promise. Until then, mark legacy objects deprecated and read-only rather than dropping them.

## 14. Acceptance checklist

- All LIVE strategies share the expected latest certified close.
- Strategy cards, detail, factsheet and OEM show the same period return.
- Chart direction matches the selected period return.
- Complete value equals securities plus continuity cash to the cent.
- Cockpit, Finance, Investors, Wealth Manager, Research Lab and Equities show the same Platform AUM at the same evidence time.
- UAT/test contributions to LIVE AUM equal zero.
- Month-end AUM fee equals static cost basis x 0.99% / 12.
- A rebalance creates no unexplained return spike.
- Targeted tests, typecheck and production build pass.

## 15. Operator summary

When a visible number looks wrong, do not patch the UI number. Identify whether the question is strategy model performance or client AUM, inspect its canonical evidence, and repair the earliest missing or inconsistent input. The public layer is designed to fail closed and keep the previous certified value rather than publish something attractive but unprovable.
