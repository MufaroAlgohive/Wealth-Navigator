# OEMS Analysis tab · `/oems/analysis/[sym]`

A per-symbol Analysis view that mirrors the structure and feel of Fiscal.ai's
`/company/{ticker}/analysis` page (Overview · Financials · Estimates · Dividends
· Ownership · News · Filings · Research · Modeling), wired to the OEMS data
tiering. No fabricated values — every empty field is a typed reason that maps to
the existing `EmptyDataState` primitive.

## Sub-tab structure

| Sub-tab | Sources wired today | Sources still needed |
|---|---|---|
| **Overview** | IRESS L1 (header), `stock_intraday_c` (1D chart), `quote_snapshot_c` (52w + avg vol), `securities_c` (Yahoo fundamentals) | ALSI beta proxy for the OEMS-only analytics block |
| **Financials** | `securities_c` snapshot only (current-period EPS, P/E, market cap) | A fundamentals vendor (Refinitiv / FactSet) for full income / balance / cash-flow statements; multi-period statements stay entitlement-blocked until `TimeSeriesGet2` is enabled |
| **Estimates** | `securities_c` snapshot only (P/E TTM, EPS TTM) | A consensus vendor (Refinitiv I/B/E/S, FactSet, S&P Capital IQ) |
| **Dividends** | `securities_c` (yield) | A dividends vendor for DPS history, payout, ex-div / payment dates, growth 3/5/10Y |
| **Ownership** | — | Institutional (Refinitiv ownership, Bloomberg HOLD) + insider feed |
| **News** | `/api/news` (Moneyweb + BusinessTech RSS, Alliance wire when wired) | — |
| **Filings** | `/api/sens` (JSE SENS) | The JSE SENS Web Feed subscription; IR calendar vendor for the upcoming-events list |
| **Research** | `strategies_c` filtered by `?sym=` | Analyst price target / recommendation (no consensus vendor) |
| **Modeling** | Client-side DCF / DDM sandbox (2-stage Gordon + exit multiple) | — (intentionally indicative-only) |

## BFF contracts

- `GET /api/analysis/[sym]?range=1Y` — master payload; composes four sub-fetches
  in parallel (`quote_snapshot_c`, `stock_intraday_c`, `securities_c`,
  worker → IRESS `TimeSeriesGet2`). Each sub-fetch is best-effort: any
  failure sets the relevant field to `null` and exposes a typed
  `BffUnavailableReason` (`supabase_not_configured`, `supabase_query_failed`,
  `empty`, `entitlement_blocked`, `worker_not_running`).
- `GET /api/research-lab?sym=NPN` — extended to filter `strategies_c` rows that
  hold the symbol. Falls back to the same response shape with `source:
  "retail-supabase"` and `reason: "no_match"` when no published basket holds
  the symbol. The no-param call still returns the full strategy list (backward
  compatible).
- `GET /api/sens?sym=NPN` — stub. Returns `{ items: [], count: 0, source:
  "unavailable", reason: "vendor_not_contracted" }` until the JSE SENS Web
  Feed subscription is wired. `/api/news` already exists; no changes needed.

## Data sources

- **T0 (reference / master):** `securities_c` — name, sector, industry, ISIN,
  P/E, EPS, dividend yield, beta, market cap, YTD, last price (INTEGER CENTS).
- **T1 (authoritative snapshots):** `stock_intraday_c` (worker-upserted ticks,
  INTEGER CENTS) + `quote_snapshot_c` (IRESS L1, INTEGER CENTS).
- **T2 (display-only ticks):** `useTick()` from the tick stream — drives the
  header last-price + Live tick overlay panel.
- **T4 (books / P&L):** Not used in this view.
- **T5 (vendor content):** News (RSS) + SENS (vendor-not-contracted) + Research
  Lab strategies (securities_c).
- **T6 (synthetic / demo):** Modeling tab is a deterministic client-side DCF
  (Gordon + exit multiple) — explicit `code-gap` badge; not a recommendation.

## IRESS entitlement gap

`TimeSeriesGet2` is empirically entitlement-blocked on `DFM@Mint` as of
2026-06-13. Every `Frequency` Long + `Interval` string the worker tries is
rejected by IRESS. This blocks:

- The Overview chart's `5D … MAX` ranges (they fall back to the
  `EntitlementRequired` block in the chart panel).
- The tier-2 panel data (ALSI / J203 sector heatmap, ZAR sovereign curve,
  equity ZAR rate panel) — all already have their own
  `EntitlementRequired` blocks; the Analysis tab's `history.entitlementBlocked`
  flag is the canonical signal across the app.

Action: ask Charles to enable `TimeSeriesGet2` on the production IRESS V4
profile. The worker's `/debug/timeseries-probe` can validate any future
`Frequency` / `Interval` enum after the flip.

## "—" with reason

The following fields always show "—" with an explicit `reason` until the
matching vendor / entitlement lands. This list is exhaustive for the
Analysis tab:

- **Estimates** (all 5 fields): `no consensus vendor`
- **Dividends** (DPS history, payout, ex-div, payment, growth 3/5/10/Fwd 2Y):
  `no vendor`
- **Ownership** (top 5 institutional, top 5 insider, % institutional,
  % insider): `no vendor`
- **Research → Analyst price target / recommendation**: `no consensus vendor`
- **Filings → Upcoming IR calendar**: `vendor_required`
- **Filings → JSE SENS feed**: `vendor_required` (JSE SENS Web Feed
  subscription)
- **Profile block** (description, CEO, year founded, HQ, website, employees):
  the corresponding fields are not on `securities_c`
- **Company statistics** (EV/EBITDA, P/B, P/FCF, ROE, ROIC, Net Debt, D/E,
  1Y Target Est): `no vendor`
- **Price & volume analytics → Beta-adj return**: footnoted `beta × period
  return; ALSI proxy unavailable`

## Chart component

`src/components/analysis/analysis-chart.tsx` wraps `lightweight-charts@^4.2.x`
(the de-facto TradingView OSS lib; already a dep at `4.2.3`). The component:

- Reads theme tokens (`--up`, `--down`, `--foreground`, `--muted-foreground`,
  `--border`, `--glass-bg-strong`, `--primary`, `--chart-2..5`) from
  `getComputedStyle(document.documentElement)` on mount + on `ResizeObserver`
  — no hard-coded hex anywhere.
- Supports line / candlestick modes. For candlesticks we synthesise OHLC from
  the daily close (the IRESS `TimeSeriesGet2` payload only carries a single
  daily close) — the body is a visualisation approximation, footnoted in the
  chart's empty state.
- Overlays SMA 20/50/200, EMA 20, RSI(14), and MACD(12,26,9) as togglable
  indicator series. RSI + MACD render in a separate oscillator pane synced to
  the main chart's time axis via `subscribeVisibleLogicalRangeChange`.
- SSR-safe: the chart is created inside a `useEffect` keyed on the container
  ref + data identity; the component renders a stable-height shell on first
  paint.

## Navigation

- The per-symbol Security page header has an `Open in Analysis` button that
  navigates to `/oems/analysis/{sym}`.
- The Equities page (both real and mock tables) has a small `↗` link in the
  rightmost "Action" column on every row, pointing at
  `/oems/analysis/{sym}`.
- The ⌘K command palette has a new "Analysis" group with one item per tracked
  symbol, labelled `Open analysis · {sym}`. Typing the symbol fuzzy-matches.

## Hard requirements coverage

- [x] Reuses `GlassSection`, `GlassKpi`, `GlassBadge`, `Panel`, `Pill`,
  `NumberCell`, `DataSourceBadge`, `ConnectionPill`, `EmptyDataState`,
  `PanelSkeleton`, `KpiTileSkeleton`, `EntitlementRequired` (no new tokens).
- [x] No new top-level nav items. Analysis is reachable from Security,
  Equities, ⌘K.
- [x] Light + dark themes both work (all colours are HSL tokens via
  `getComputedStyle`).
- [x] All sub-tabs are keyboard-navigable (arrow keys + Enter); the tablist
  has `role="tablist"`, each tab has `role="tab"` + `aria-selected`.
- [x] Loading states for every async section (`PanelSkeleton`,
  `KpiTileSkeleton`, `EmptyDataState`).
- [x] TypeScript strict — no `any`, no `@ts-ignore`. The chart series types
  use the lightweight-charts public types (`ISeriesApi<"Line">`,
  `ISeriesApi<"Candlestick">`).
- [x] LIVE / MOCK / SEED / SUPABASE / STREAM / UNCONFIGURED / WORKER /
  BLOCKED-EXTERNAL / BLOCKED-VENDOR / CODE-GAP labels are all wired through
  `DataSourceBadge`.
- [x] No IRESS_PASSWORD or other secrets in client bundles or
  `NEXT_PUBLIC_*` vars (the BFF is server-side, supabase is service-role via
  `createInstitutionalServiceRoleClient` / `createRetailServiceRoleClient`).
