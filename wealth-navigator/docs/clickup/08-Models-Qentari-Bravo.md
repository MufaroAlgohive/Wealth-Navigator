# Wealth Navigator — Models — JSE Alpha (Qentari Bravo), paper trading, benchmarks

**Audience:** developers, quants, IC members, stakeholders.
**Last reviewed:** 2026-08-15.
**Source of truth:** `wealth-navigator/src/app/oems/models/`, `wealth-navigator/src/components/oems/primitives/live-model-dashboard.tsx`, `wealth-navigator/src/lib/data-source.ts`, `wealth-navigator/src/lib/hooks/use-audit-orders.ts`, `wealth-navigator/supabase/migrations/20260712000001_model_tracking_c.sql`, root `AGENTS.md:29`, `wealth-navigator/docs/MINT_PRODUCTION_READINESS_AUDIT.md`.

> **Correction vs older handoffs:** Charts use **Recharts v2.15.0**. Dual-writer risk on price tables. **Equity curve wins over stored metric** — server overrides `budget/final_equity/total_return/max_drawdown` from the equity curve.

---

## 1. What is Models?

Models is the **quant-model registry** — a surface where quants publish quant models, run paper-trading simulations, and benchmark against JSE indices. It is the desk's R&D layer.

### Flagship model — JSE Alpha (Qentari Bravo JSE)
- Long-only JSE equity.
- ~7 concentrated names.
- Weekly rebalance.
- Benchmark: `STX40.JO`.
- Currency: ZAR.
- Budget: R500k.
- **Paper account** runs locally in Docker (Lumibot / DuckDB / Yahoo-fed simulator).

### External pusher
- The Qentari Bravo model lives outside the repo at `E:\Autonama\Active Projects\Algos\Autonama_Algo\Qentari Models\Qentari_Bravo_JSE\docker-compose-pusher.yml`.
- Pusher pushes registry, metrics, equity curve, predictions, positions, trades into institutional `model_*_c` tables.
- **P1.4 risk** — external pusher is unversioned / off-repo / on a separate Windows host. Bring under ops control before cutover.

### Routes
- `/oems/models` — model list.
- `/oems/models/[id]` — per-model detail with Backtest + Paper account tabs.

---

## 2. Model list (`/oems/models`)

### Server entry
- `wealth-navigator/src/app/oems/models/page.tsx:1-15` — renders `<ModelsList />`.
- `export const dynamic = "force-dynamic"` — server-rendered fresh on every request.

### List rendering
- Per-model card:
  - Name, slug, description.
  - Strategy (long-only, long-short, market-neutral, …).
  - Universe (JSE Top-40, ALSI, sector, …).
  - Benchmark (`STX40.JO`, `J203`, …).
  - Last backtest return %.
  - Last paper account return %.
  - Last update ts.
  - Status pill (`paper | live | archived`).
- Filter chips: by status, by universe, by benchmark.
- Sort: by return, by recency, by name.

### Data
- Reads `model_registry_c`, `model_metric_c` on institutional DB.
- Backed by `/api/models` (server route).
- Reads via `createInstitutionalServiceRoleClient()`.

---

## 3. Per-model detail (`/oems/models/[id]`)

### Server entry
- `wealth-navigator/src/app/oems/models/[id]/page.tsx:1-9` — renders `<ModelDetail slug={id} />`.
- `export const dynamic = "force-dynamic"` — 60s client-side polling always sees fresh data.

### Tabs
- **Backtest** — historical equity curve + metrics + benchmark comparison.
- **Paper account** — live paper trading dashboard.

### Backtest tab
Components from `wealth-navigator/src/components/oems/primitives/live-model-dashboard.tsx` (769 lines):
- Equity curve (model vs STX40.JO benchmark, rebased to 100).
- Metrics grid (alpha, beta, tracking error, info ratio, up/down capture, max drawdown).
- Holdings table (per-name weight, contribution to return).
- Trades table (rebalance history).
- Server-computed via `/api/models/[id]` and `/api/models/[id]/benchmark`.

### Paper account tab
- Real-time equity curve (paper account).
- Current positions.
- Trade blotter.
- P&L breakdown.
- Server-computed via `/api/models/[id]/paper` and `/api/models/[id]/paper/positions`.

---

## 4. Charts (recharts v2.15.0)

Per `wealth-navigator/package.json:68`: `recharts` is at `v2.15.0`.

### Account-vs-benchmark visual separation (3 ways enforced)
1. **Solid vs dashed** — paper = solid primary color, STX40 = dashed muted color.
2. **Color palette** — distinct hues from `wealth-navigator/src/components/research-lab/chart-theme.ts` (`CHART_COLORS`).
3. **Rebase to 100 + reference line** — both lines start at 100; `<ReferenceLine y={100} />` anchors the chart.

### Chart theme
- `wealth-navigator/src/components/research-lab/chart-theme.ts` exports:
  - `CHART_COLORS` — palette.
  - `CASH_COLOR` — cash allocation color.
  - `tooltipStyle` — tooltip styling.
- JetBrains Mono font for chart tooltips; card background.
- Light / dark theme variants.

### Chart types
- `<AreaChart>` — equity curve area.
- `<LineChart>` — equity curve line.
- `<BarChart>` — sector allocation.
- `<PieChart>` — current portfolio weights.
- Sparklines — per-position mini charts.

---

## 5. Equity curve vs stored metric (the override)

Per `wealth-navigator/src/app/api/models/[id]/route.ts:73-122`:
- Server **always overrides** stored `budget`, `final_equity`, `total_return`, `max_drawdown` from the equity curve.
- Rationale: stored metrics can drift from the curve (data entry error, partial update). The equity curve is the source of truth.
- `computeSummary()` at `route.ts:233-341` recomputes `alpha`, `beta`, `tracking_error`, `info_ratio`, `up_capture`, `down_capture`, `max_drawdown` from the curve.

### Dual-writer risk on price tables
- Models consume price data from `securities_c` + `stock_intraday_c` on retail.
- Two writers exist:
  1. Worker (`stock_intraday_c` upsert via Path A).
  2. Cron (`/api/cron/yahoo-fundamentals` — shadow default; live writes opt-in via `YAHOO_FUNDAMENTALS_WRITE=1`).
- Risk: model backtests could see stale or mixed-source prices during writer overlap.
- Mitigation: identify existing writers before flipping worker opt-ins (`docs/ISSUES_LOG.md:0.5.4.e`).

### Equity payload truncation (P1.4 risk)
- Equity curve payload is large (90+ days × multiple series).
- Truncation risk on slow networks → ensure full payload is sent (`route.ts:73-122` validates payload size).

---

## 6. Benchmarks

### `STX40.JO` — primary benchmark
- JSE Top 40 index.
- Yahoo symbol `^STX40.JO` (or `STX40.JO`).
- ZAR-denominated.
- Default benchmark for all JSE equity models.

### `J203` — secondary benchmark
- JSE All Share Index.
- IRESS `TimeSeriesGet2` (DataSource=zax, Exchange=jse).
- Working in `TimeSeriesGet2` now (post-2026-07-09 Andre probe).

### Custom benchmarks
- A model can override the default benchmark.
- `/api/models/[id]/benchmark` accepts `{ benchmark: "STX40.JO" | "J203" | custom_symbol }`.
- Custom symbols require `/api/securities/search` lookup.

### Benchmark fallback
- If benchmark unavailable, fall back to STX40.JO via Yahoo Finance (`/api/cron/yahoo-fundamentals` shadow).
- `/api/models/[id]/benchmark/route.ts:233-341` — `computeSummary()` handles fallback.

---

## 7. Paper trading

### Local Docker
- JSE Alpha (Qentari Bravo) runs locally in Docker.
- Lumibot / DuckDB / Yahoo-fed simulator.
- `docker-compose-pusher.yml` runs:
  - Simulator container (Lumibot).
  - DuckDB container (storage).
  - Pusher container (writes to Supabase).

### Pusher output → Supabase
- `model_registry_c` — model metadata.
- `model_metric_c` — periodic metrics (alpha, beta, etc.).
- `model_equity_curve_c` — full equity curve.
- `model_prediction_c` — daily predictions.
- `model_position_c` — current positions.
- `model_trade_c` — trade blotter.

### Pusher cadence
- Default: every 60s.
- Configurable via pusher env vars.

### P1.4 risk — external pusher off-repo
- Located at `E:\Autonama\Active Projects\Algos\Autonama_Algo\Qentari Models\Qentari_Bravo_JSE\docker-compose-pusher.yml`.
- Unversioned (not in git).
- On a separate Windows host.
- Bring under ops control (move into `wealth-navigator/workers/qentari-bravo/` or similar) before cutover.

---

## 8. Server-side API surface

### `/api/models/route.ts`
- `GET` — list models with metrics.
- `POST` — register a new model (admin-only).

### `/api/models/[id]/route.ts`
- `GET` — single model with equity curve + summary metrics.
- Server overrides `budget/final_equity/total_return/max_drawdown` from equity curve (lines 73-122).
- `PATCH` — update model metadata (model author only).
- `DELETE` — archive model (model author or admin).

### `/api/models/[id]/benchmark/route.ts`
- `GET` — benchmark comparison (model vs benchmark).
- Returns alpha, beta, tracking error, info ratio, up/down capture, max drawdown (lines 233-341).

### `/api/models/[id]/paper/route.ts`
- `GET` — paper account current state.
- Returns equity curve, positions, P&L.

### `/api/models/[id]/paper/positions/route.ts`
- `GET` — paper account positions only.
- `POST` — manual paper trade (admin-only).

### `/api/models/[id]/trades/route.ts`
- `GET` — paper account trade blotter.

### `/api/models/[id]/predictions/route.ts`
- `GET` — daily predictions.
- `POST` — manual prediction (model author only).

---

## 9. `useAuditOrders` — real-data-only gate

Per `wealth-navigator/src/lib/hooks/use-audit-orders.ts:36-44`:
- Disables the query entirely when `realDataOnly` is on AND the user hasn't opted in via `?mock=1`.
- Used by paper trading to gate mock vs real data.
- Default: real-data-only (no mock).

---

## 10. Supabase tables (institutional DB)

### `model_registry_c`
- `id` UUID PK.
- `slug` text unique.
- `name` text.
- `description` text.
- `strategy` text (`long_only`, `long_short`, `market_neutral`).
- `universe` text (`jse_top40`, `alsi`, `sector`).
- `benchmark` text (`STX40.JO`, `J203`).
- `currency` text (`ZAR`).
- `budget_cents` bigint.
- `rebalance_freq` text (`weekly`, `monthly`).
- `status` text (`paper`, `live`, `archived`).
- `author` text.
- `created_at`, `updated_at`.

### `model_metric_c`
- `id` UUID PK.
- `model_id` UUID FK.
- `ts` timestamptz.
- `alpha` numeric.
- `beta` numeric.
- `tracking_error` numeric.
- `info_ratio` numeric.
- `up_capture` numeric.
- `down_capture` numeric.
- `max_drawdown` numeric.
- `total_return` numeric.

### `model_equity_curve_c`
- `id` UUID PK.
- `model_id` UUID FK.
- `ts` timestamptz.
- `equity` numeric.
- `benchmark_equity` numeric.
- `drawdown` numeric.

### `model_prediction_c`
- `id` UUID PK.
- `model_id` UUID FK.
- `ts` timestamptz.
- `symbol` text.
- `score` numeric (-1 to 1).

### `model_position_c`
- `id` UUID PK.
- `model_id` UUID FK.
- `symbol` text.
- `weight` numeric.
- `qty` numeric.
- `entry_price_cents` bigint.
- `current_price_cents` bigint.
- `pnl_cents` bigint.
- `updated_at`.

### `model_trade_c`
- `id` UUID PK.
- `model_id` UUID FK.
- `ts` timestamptz.
- `symbol` text.
- `side` text (`buy`, `sell`).
- `qty` numeric.
- `price_cents` bigint.
- `rationale` text.

### Migration
- `wealth-navigator/supabase/migrations/20260712000001_model_tracking_c.sql` — model tracking tables.

---

## 11. Data sources

| Source | Used by | Auth |
|---|---|---|
| `model_*_c` tables (institutional) | Backtest + Paper tabs | Service-role client |
| `securities_c` + `stock_intraday_c` (retail) | Price lookups in holdings | Service-role client |
| `stock_intraday_c` (retail, Realtime) | Live price updates | Supabase Realtime |
| Yahoo Finance (`/api/cron/yahoo-fundamentals`) | Benchmark fallback | Server-side |

---

## 12. Server-side enforcement

### `/api/models/[id]/route.ts:73-122` — equity curve override
- Server always overrides stored metrics from the equity curve.
- No way to bypass from the client.

### `useAuditOrders` real-data-only gate
- Disables query when `realDataOnly` AND no `?mock=1`.

### Per-model author check
- `PATCH` / `DELETE` / `POST /api/models/[id]/paper/positions` — only model author or admin.

---

## 13. Open gaps

- **External pusher off-repo (P1.4)** — move under ops control.
- **Equity payload truncation risk** — validate payload size on slow networks.
- **Dual-writer risk on price tables** — identify existing writers before worker opt-ins.
- **Benchmark fallback to Yahoo** — only works if `YAHOO_FUNDAMENTALS_WRITE=1` (default shadow).
- **No live models yet** — all models are paper; live trading blocked on IRESS production-order readiness.
- **No model marketplace** — only the registered models are visible.
- **No model alerts** — when a model drops below threshold, no notification.
- **No model rollback** — once a model is archived, it can't be recovered.
- **No multi-account paper** — each model runs one paper account; multi-account for portfolio construction TBD.

---

*This doc is the Models deep-dive. Pair with Doc 7 (Canvas) for the visual engines and Doc 9 (API surface) for the BFF contracts.*
