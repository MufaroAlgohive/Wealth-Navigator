# Wealth Navigator — OEMS Trading Desk (the institutional trading surface)

**Audience:** developers, new joiners, stakeholders, ops.
**Last reviewed:** 2026-08-15.
**Source of truth:** `wealth-navigator/src/app/oems/`, `wealth-navigator/src/components/oems/`, `wealth-navigator/src/lib/oems/`, `wealth-navigator/src/lib/data-policy.ts`, `wealth-navigator/src/lib/data-source.ts`, `wealth-navigator/src/lib/iress/`, `wealth-navigator/docs/DATA_PROVENANCE.md`, `wealth-navigator/PLANNING.md`.

> **Correction vs older handoffs:** Many of the surfaces listed under "OEMS nav items" in earlier briefs are actually **panels inside the single Cockpit `/oems` page**, not discrete routes. The actual route map is much smaller than the IA implies. This doc reflects the real route table (verified against `src/app/oems/`).

---

## 1. The OEMS shell

### Top-level shell
- **Cockpit** is the desk home. The `/` route redirects to `/oems` (`wealth-navigator/src/app/page.tsx:9-11`).
- The `cockpit-client.tsx` is ~2,200 lines and renders the KPI strip, sector heatmap, ZAR yield curve, ALSI intraday, SENS feed, open-orders tape, macro pulse, news, JIBAR/USDZAR KPIs.
- Server entry: `wealth-navigator/src/app/oems/page.tsx`.
- Glass primitives from `wealth-navigator/src/components/oems/primitives/glass.tsx`.

### Navigation
The OEMS nav is defined in `wealth-navigator/src/lib/platform/nav.ts`. The OEMS sections are:

- **MAIN** — Cockpit (`/oems`), Blotter (`/oems/blotter`), Strategies (`/oems/strategies`).
- **EQUITIES** — Equities (`/oems/equities`), Security (`/oems/security`), Analysis (`/oems/analysis`).
- **FIXED INCOME** — Fixed Income (`/oems/fixed-income`), Money Market (`/oems/money-market`), Curves (`/oems/curves`).
- **MACRO** — Macro (`/oems/macro`), News (`/oems/news`).
- **OPS** — Integration (`/oems/integration`), IRESS Migration (`/oems/iress-migration`).
- **RESEARCH & IC** — Research Library (`/oems/research`), Rebalance Builder (`/oems/rebalance`), Investment Cmte. (`/oems/committee`), Desk Rhythm (`/oems/rhythm`), Canvas (`/canvas`).
- **STRATEGIES** — Models (`/oems/models`).

Items visible to roles `DESK` + `STRAT`. The ⌘K command palette (`wealth-navigator/src/components/oems/command-palette.tsx:33-67, 90-106`) lists the same items.

### Persona context
- The OEMS persona is `oems` (`wealth-navigator/src/lib/store/session-provider.tsx:6-30`).
- Persona routing is client-only (Zustand store with `mint-session` localStorage persist). Server RBAC is unaware of the persona cookie.
- `PersonaRealDataGate` (`wealth-navigator/src/components/oems/persona-real-data-gate.tsx:22-49`) only enforces an honest empty state; it does NOT route the persona to other views.
- `resolveResearchSession()` (`wealth-navigator/src/components/research-ic/server.ts`) resolves session-side perms for `/oems/research`, `/oems/committee`, `/oems/rebalance`.

### Data-source badge taxonomy
Every `GlassSection` surfaces the data source via `wealth-navigator/src/components/oems/primitives/data-source-badge.tsx`. The full taxonomy (16 kinds, defined at `badge.tsx:16-32`):

`live | iress | yahoo | external | mock | seed | hybrid | supabase | stream | worker | uat | unconfigured | unavailable | blocked-external | blocked-vendor | code-gap`

`mapSource()` (`wealth-navigator/src/lib/data-source.ts:27-55`) normalises free-form BFF `source` strings into the badge kind. Default fallback is `"supabase"`.

### Data policy
- `isRealDataOnlyClient()` (`wealth-navigator/src/lib/data-policy.ts:21-45`) — default-on real-data mode. Mock/seed only when `?mock=1` URL param OR `NEXT_PUBLIC_USE_SUPABASE_QUOTES=false`.
- Yellow `DEV · MOCK` banner only fires in non-prod builds (`data-policy.ts:54-58`).
- Persona pages (`/strategist`, `/wm`, `/admin`, `/business`, `/fc`) — all seed placeholders behind `PersonaRealDataGate`.

### UAT scope helpers (`wealth-navigator/src/lib/oems/uat-scope.ts`)
- `uatModeEnabled()` (lines 32-34) — accepts `"1"` or `"true"`. Note the **history of a strict `=== "true"` bug** that produced a silent audit-only fallback (comment at `uat-scope.ts:23-30`).
- `isUatEnv()` (lines 36-44) — also flips UAT on if `IRESS_BASE_URL` matches `webservices-ct.*`.
- Rebalance scope: `wealth-navigator/src/lib/oems/rebalance-scope.ts`.

### BFF unavailable reasons
- Typed BFF error reasons in `wealth-navigator/src/lib/bff-reasons.ts` (`BffUnavailableReason`). Used by `EmptyDataState` to render the right migration / entitlement copy.

---

## 2. The actual route map

### Real OEMS routes (verified against `wealth-navigator/src/app/oems/`)

| Route | File | Behaviour |
|---|---|---|
| `/oems` (Cockpit) | `src/app/oems/page.tsx` + `cockpit-client.tsx` (2,200 lines) | KPI strip + heatmap + curve + news + orders |
| `/oems/blotter` | `src/app/oems/blotter/page.tsx` | Order tape + new-order dialog |
| `/oems/strategies` | `src/app/oems/strategies/page.tsx` | Mandate cards + drift vs target |
| `/oems/equities` | `src/app/oems/equities/page.tsx` | JSE Top-10 + sector breakdown |
| `/oems/fixed-income` | `src/app/oems/fixed-income/page.tsx` | Bond screener + single-bond detail |
| `/oems/money-market` | `src/app/oems/money-market/page.tsx` | JIBAR fixings, NCD/T-Bill universe |
| `/oems/curves` | `src/app/oems/curves/page.tsx` | Govi/swap/real/breakeven + PCA |
| `/oems/macro` | `src/app/oems/macro/page.tsx` | SARB + StatsSA tiles |
| `/oems/news` | `src/app/oems/news/page.tsx` | News + SENS tape |
| `/oems/security` | `src/app/oems/security/page.tsx` | Watchlist + L2 depth + fundamentals + time-and-sales |
| `/oems/analysis` + `/oems/analysis/[sym]` | `src/app/oems/analysis/page.tsx` + `[sym]/page.tsx` | Per-symbol analysis tab |
| `/oems/integration` | `src/app/oems/integration/page.tsx` | Endpoint health, IRESS v4 → OEMS surface map |
| `/oems/iress-migration` | `src/app/oems/iress-migration/page.tsx` | Yahoo → IRESS(PROD) cutover console |
| `/oems/research` | `src/app/oems/research/page.tsx` | Research Library (multi-step New Note wizard) |
| `/oems/committee` | `src/app/oems/committee/page.tsx` | Investment Committee voting surface |
| `/oems/rebalance` | `src/app/oems/rebalance/page.tsx` | Rebalance builder + IC votes |
| `/oems/rebalance/approved` | `src/app/oems/rebalance/approved/page.tsx` | Approved rebalance orders |
| `/oems/rhythm` | `src/app/oems/rhythm/page.tsx` | Daily operating cadence narrative |
| `/oems/models` + `/oems/models/[id]` | `src/app/oems/models/page.tsx` + `[id]/page.tsx` | Quant-model registry + Paper account demo |
| `/oems/research-lab` | `src/app/oems/research-lab/page.tsx` | **Redirect to `/oems/research`** (legacy alias) |
| `/oems/research-lab-legacy` | `src/app/oems/research-lab-legacy/page.tsx` | Legacy v1 editor (session-only) |
| `/oems/(banking)/eft` | `src/app/oems/(banking)/eft/page.tsx` | EFT top-ups |
| `/oems/(banking)/wallet-topup` | `src/app/oems/(banking)/wallet-topup/page.tsx` | Ozone wallet top-up |
| `/oems/(banking)/reconciliation` | `src/app/oems/(banking)/reconciliation/page.tsx` | Reconciliation |
| `/oems/(marketing)/page.tsx` | `src/app/oems/(marketing)/page.tsx` | Marketing surfaces (route groups, no URL impact) |
| `/oems/(marketing)/mint-mornings`, `/emailers`, `/triggers` | — | Marketing surfaces (route groups) |

### Non-existent routes (do not look for these)
Earlier IA drafts referenced paths like `/oems/orders`, `/oems/portfolio`, `/oems/sens`, `/oems/fx`, `/oems/sa-rates`, `/oems/sectors`, `/oems/indices`, `/oems/alerts`, `/oems/wm`, `/oems/fc`, `/oems/compliance`, `/oems/admin/*`. **These do not exist as discrete pages** — they live as panels inside the Cockpit `/oems`. The IA hints at where they *could* be reached, but they have not been split out yet.

### Banking surfaces (under `/oems/(banking)/`)
- EFT top-ups.
- Wallet top-ups (`/oems/(banking)/wallet-topup`) — `OzoneMode=mock` today. Calls `POST /api/admin/eft/ozone-topup`. Mock provider fires a callback ~5s later so dev can exercise the full redirect flow on localhost.
- Reconciliation.

### Marketing surfaces (route groups, no URL impact)
- `/oems/(marketing)/page.tsx`, `/mint-mornings`, `/emailers`, `/triggers` — operator-facing.

---

## 3. The Cockpit in detail

`wealth-navigator/src/app/oems/cockpit-client.tsx` (~2,200 lines) is the center of the desk. It aggregates KPIs and panels from many BFF endpoints:

### KPI strip
- **AUM** — RETAIL `client_strategy_returns_c` sum.
- **Day P&L** — RETAIL latest `client_strategy_returns_c` change vs prior day.
- **Rebalance-Locked** — count from `strategy_rebalance_residuals`.
- **Cash** — `wallets` balance for active strategies.
- **Open orders count** — INSTITUTIONAL `oems_order_audit` where `status in (PENDING_ACK, ACKNOWLEDGED, WORKING, PARTIAL, AMEND_PENDING, CANCEL_PENDING)`.

### Panels
- **Sector heatmap** (`SectorHeatmap`, `SectorTreemap`) — RETAIL `securities_c` × `securities_c.sector`. `PricingQuoteGet` (seed until entitlement).
- **Top movers / tickers** — RETAIL `stock_intraday_c` + `securities_c`, Realtime push. **LIVE via worker.**
- **ALSI / J203 intraday** — INSTITUTIONAL `index_intraday_c` via `TimeSeriesGet2` (DataSource=zax, Exchange=jse — now WORKING).
- **Open orders tape** — INSTITUTIONAL `oems_order_audit` (Path A) + Path B `/api/orders/live` for fresh fills. SSE `/api/orders/stream`.
- **SENS feed** — INSTITUTIONAL `news_item_c` post opt-in (currently SEED).
- **News flow** — RETAIL `News_articles` + RSS (Moneyweb + BusinessTech).
- **Macro pulse** — INSTITUTIONAL `macro_indicator_c` (Phase C2 cron; SEED today).
- **JIBAR / USDZAR** — RETAIL `securities_c` + `stock_intraday_c`. HYBRID via worker.
- **ZAR govi curve** — INSTITUTIONAL `yield_curve_history_c`, `oems_curve_metric_c`. `TimeSeriesGet2` (blocked on entitlement today).

### API endpoints the Cockpit calls
- `/api/equities`, `/api/portfolio`, `/api/client-book`, `/api/quotes`, `/api/orders`, `/api/news`, `/api/worker-health`.
- `/api/sectors` (gated on `TimeSeriesGet2`), `/api/indices/J203` (gated), `/api/curves/[code]` (gated), `/api/curves/ZAR_NSS/metrics`.

### Data-source badges (Cockpit)
Every panel renders the data-source badge. Real panels show `IRESS·PROD` or `SUPABASE`. Seed panels show `SEED`. Gated panels show `CODE-GAP` or `BLOCKED-EXTERNAL`.

---

## 4. Blotter (`/oems/blotter`)

### Page entry
- `wealth-navigator/src/app/oems/blotter/page.tsx` — server entry that resolves session + persona, then renders `<OemsBlotter />`.

### KPI tile strip
Six counters (lines 134-141): Total, Working, Partial, Filled, Cancelled, Rejected.

### Order tape
- Pulls from `/api/orders` (Path A: `oems_order_audit`) and `/api/orders/live` (Path B: worker passthrough).
- SSE `/api/orders/stream` for live fill deltas.
- `OrderStatePill` (4-tone) at lines 277-285 — `FILLED`, `PARTIAL`, `WORKING`, `REJECTED` only (compact).

### New-order dialog
- `wealth-navigator/src/app/oems/blotter/new-order-dialog.tsx`.
- Calls `POST /api/orders/preflight` (local BFF preflight) and `POST /api/orders/submit` (worker `/uat/send-to-market` or `/orders/send-to-market` depending on UAT mode).
- Shows "Pre-trade check failed" tooltip when `preflight` returns unavailable (lines 142-148).
- Pre-trade compliance (Phase C1/C2) — runs against `oems_account_c` (cash + position snapshot) + in-flight orders from `oems_order_audit`.

### Cancel / amend
- Currently **MOCK client** → `/api/orders/cancel`.

---

## 5. Strategies (`/oems/strategies`)

- Mandate cards + drift vs target.
- (Seed-only today; RETAIL `strategies_c` reads via `/api/strategies`.)
- Underlying lib: `src/lib/research-lab/server.ts::listResearchStrategies`.

---

## 6. Equities (`/oems/equities`)

- JSE Top-10 + sector breakdown.
- Calls `/api/equities`.
- HYBRID via worker.

---

## 7. Security (`/oems/security`)

- Watchlist + L2 depth + time-and-sales + fundamentals.
- `/api/quotes` for quotes (HYBRID via worker).
- `/api/intraday/[sym]` for intraday chart.
- L2 depth / time-and-sales — **SEED today** (`docs/DATA_PROVENANCE.md` — no V4 method wired for `OrderBookGet`).
- Fundamentals — hardcoded + Yahoo via `/api/company-analysis/[sym]`.

---

## 8. Analysis (`/oems/analysis`, `/oems/analysis/[sym]`)

- Per-symbol analysis tab.
- `/api/analysis/[sym]` + `/api/company-analysis/[sym]/chart`.
- HYBRID (Yahoo fundamentals + IRESS price overlay).

---

## 9. Fixed Income (`/oems/fixed-income`)

- Bond screener + single-bond detail.
- Single-bond detail computes clean/dirty price, DV01, convexity, KRD.
- Reads INSTITUTIONAL `bonds_c` via `/api/bonds`.
- SEED today (IRESS + index vendor feeds pending).

---

## 10. Money Market (`/oems/money-market`)

- JIBAR fixings, NCD / T-Bill universe, ZAR govi.
- Reads INSTITUTIONAL via `/api/money-market`.
- SEED today.

---

## 11. Curves (`/oems/curves`)

- Govi / swap / real (ILB) / breakeven overlay.
- Change table + PCA decomposition.
- Reads INSTITUTIONAL `yield_curve_history_c`, `oems_curve_metric_c` via `/api/curves`.
- SEED today (TimeSeriesGet2 entitlement pending for NSS curves).

---

## 12. Macro (`/oems/macro`)

- SARB + StatsSA + G10 tile strip + calendar + surprise chart.
- Reads INSTITUTIONAL `macro_indicator_c` via `/api/macro`.
- SEED today (vendor pending).

---

## 13. News (`/oems/news`)

- News + SENS tape with priority badges + ticker chips.
- Calls `/api/news` (RSS + `News_articles`) + `/api/iress/news` (probe).
- RETAIL `News_articles` + INSTITUTIONAL `news_item_c` (post opt-in).
- EXTERNAL (RSS) / SEED / T5_PASSTHROUGH.

---

## 14. Integration (`/oems/integration`)

- Endpoint health.
- IRESS v4 → OEMS surface map.
- Integration map.
- WSDL/version display.
- Gap call-outs.
- Calls `/api/integration/health`, `/api/iress/health`, `/api/worker-health`, `/api/iress/provenance`.
- Reads INSTITUTIONAL `integration_worker_health`.
- LIVE.

---

## 15. IRESS Migration (`/oems/iress-migration`)

- Yahoo → IRESS(PROD) cutover console.
- Per-symbol accuracy scoreboard.
- Calls `/api/iress/validation`, `/api/iress/validation/approve`.
- Reads INSTITUTIONAL `iress_price_validation_c`.
- LIVE.

---

## 16. Research (`/oems/research`)

Documented in detail in Doc 6. Briefly:
- Server entry `wealth-navigator/src/app/oems/research/page.tsx:1-14` calls `resolveResearchSession()` then renders `<ResearchLibraryPage perms={s.perms} …>`.
- Components in `wealth-navigator/src/components/research-ic/` — `research-library-page.tsx`, `note-editor.tsx` (6-step wizard), `note-detail.tsx`, `investment-committee-page.tsx`, `rebalance-builder-page.tsx`, `desk-rhythm-page.tsx`, `ic-agenda.ts`, `server.ts`, `types.ts`, `ui.tsx`.

---

## 17. Committee (`/oems/committee`)

- Renders `<InvestmentCommitteePage/>`.
- IC agenda: pending notes, pending rebalance requests, approved items, recent decisions.
- Pills per member (LN/JN/LT). Tally bar + threshold.
- Components: `wealth-navigator/src/components/research-ic/investment-committee-page.tsx` (lines 800-870 per-member pills, 920-941 vote row, 943-973 tally bar).
- Reads server-computed `req.tally.passed`.

---

## 18. Rebalance (`/oems/rebalance`)

- Rebalance builder.
- Server entry `wealth-navigator/src/app/oems/rebalance/page.tsx:1-21` resolves strategy + renders `<RebalanceBuilderPage perms={s.perms} … initialStrategyId={sp.strategy} initialStrategyName={sp.name} />`.
- Loads strategy catalogue from `/api/strategies` and baseline composition from `/api/strategies/[id]/composition`.
- User can add / trim / grow / hold holdings with required `rationale` per change.
- `submitToIc()` (`rebalance-builder-page.tsx:324-375`) → POST `/api/rebalance/requests`.
- `impactQ` pre-flight per proposed change (`POST /api/rebalance/impact`).
- Documented in detail in Doc 6.

---

## 19. Rebalance Approved (`/oems/rebalance/approved`)

- Displays latest approved request by `request_id` deep-link.
- Documents the post-IC-approved state. Read-only.

---

## 20. Rhythm (`/oems/rhythm`)

- Static narrative of the daily operating rhythm tying Research → IC → Rebalance.
- `wealth-navigator/src/components/research-ic/desk-rhythm-page.tsx`.

---

## 21. Models (`/oems/models`, `/oems/models/[id]`)

Documented in detail in Doc 8. Briefly:
- Server entry `wealth-navigator/src/app/oems/models/page.tsx:1-15` renders `<ModelsList />`.
- Per-model detail at `wealth-navigator/src/app/oems/models/[id]/page.tsx:1-9` renders `<ModelDetail slug={id} />`.
- Tab segment toggles **Backtest** vs **Paper account**.
- Both pages are server-rendered with `export const dynamic = "force-dynamic"` so the 60s client-side polling always sees fresh data.

---

## 22. Banking surfaces (`/oems/(banking)/`)

### EFT (`/oems/(banking)/eft`)
- EFT top-ups. Mock-only until Ozone vendor contract.

### Wallet Top-up (`/oems/(banking)/wallet-topup`)
- Calls `POST /api/admin/eft/ozone-topup`. `OZONE_MODE=mock` today.
- Mock provider fires a callback ~5s later so dev can exercise the full redirect flow on localhost.

### Reconciliation
- Reconciliation surface.

---

## 23. Marketing surfaces (`/oems/(marketing)/`)

- `/oems/(marketing)/page.tsx`, `/mint-mornings`, `/emailers`, `/triggers` — operator-facing. Route groups, no URL impact.

---

## 24. OEMS primitives

### `wealth-navigator/src/components/oems/primitives/`
- **`glass.tsx`** — `GlassSection`, `GlassKpi`, `GlassSegment`, `PageCanvas` (exported as `PageCanvas = ResearchLabCanvas`), `glass-inset` utility class.
- **`data-source-badge.tsx`** — full 16-kind taxonomy. `iress` renders as `IRESS·PROD` (line 57). `uat` renders as `IRESS·UAT` (line 67).
- **`empty-data-state.tsx`** — shared honest empty-state card with reason taxonomy (supabase_not_configured / supabase_query_failed / empty / entitlement_blocked / worker_not_running).
- **`persona-real-data-gate.tsx`** — gates seed vs real-data on persona pages. Renders `<EmptyDataState>` when real-data-only mode is on.
- **`live-model-dashboard.tsx`** — JSE Alpha Paper account dashboard (769 lines). Documented in Doc 8.
- **`sparkline.tsx`**, **`ticker-bar.tsx`** — small chart primitives.
- **`iress-status-pill.tsx`** — 14-state pill for order lifecycle.
- **`command-palette.tsx`** — ⌘K palette (`NAV` array lists the entire OEMS nav).

### `wealth-navigator/src/lib/oems/`
- **`uat-scope.ts`** — `uatModeEnabled()`, `isUatEnv()`. Comment notes a historical `=== "true"` bug that produced silent audit-only fallback (`uat-scope.ts:23-30`).
- **`rebalance-scope.ts`** — rebalance-specific scope helpers.

---

## 25. Server-side-only calculations audit

The **OEM calculation convention** (root `AGENTS.md`) requires: "strategy value, basket construction, P&L, AUM fee and rebalance calculations must be server-side only — front-end calculation of these is explicitly banned and treated as a bug. Lonwabo Damane owns the OEM basket/strategy/rebalance data flows."

Verified locations:
- **`/api/admin/finance/route.ts:99-153`** — AUM fees computed server-side from `strategies_c.payload.fee_pct` × `client_strategy_returns_c.basket_value`.
- **`/api/admin/finance/route.ts:187-212`** — Day-1 P&L read from `oems_order_audit.result_payload->dayOnePnlCents`.
- **`/api/rebalance/impact/route.ts:44-288`** — rebalance impact computed server-side. Hard rule at lines 16-25: "HARD CLIENT-DATA BOUNDARY — This reads the RETAIL/LIVE database, so it is scoped to TEST CLIENTS ONLY… A real client (is_test=false) is never read."
- **`/api/models/[id]/route.ts:73-122`** — equity curve wins over stored metric; server overrides `budget/final_equity/total_return/max_drawdown` from the equity curve.
- **`/api/models/[id]/benchmark/route.ts:233-341`** — `computeSummary()` computes alpha, beta, tracking error, info ratio, up/down capture, max drawdown.
- **`/api/strategies/route.ts:464-534`** — strategy catalogue with model view (`aum`, `dayPnl`, `ytd`, `nav`, `investorCount`, `holdingsCount`, `cashWeight`, `holdingsPreview`, `minValue`).
- **`/api/strategies/returns/route.ts`** — strategy returns with J203 benchmark.

**No front-end OEM math found.** UI components consume server-computed values verbatim.

---

## 26. Data tiering (T0-T6)

Per `AGENTS.md:22`:
- **T0** — reference/master (`securities_c`).
- **T1** — authoritative snapshots (`stock_intraday_c` worker upsert + Realtime push).
- **T2** — display-only ticks (ephemeral SSE; do not persist).
- **T3** — orders/audit (`oems_order_audit`).
- **T4** — books/P&L.
- **T5** — vendor content (SENS/news/macro — seed until contracted; T5_PASSTHROUGH = vendor probe with no persistence).
- **T6** — synthetic/demo (PCA, fake depth).

Each OEMS surface respects its tier. The badge taxonomy (`live | iress | yahoo | external | mock | seed | hybrid | supabase | stream | worker | uat | unconfigured | unavailable | blocked-external | blocked-vendor | code-gap`) maps cleanly to T0-T6.

---

## 27. Audit & feedback loop

- **Cockpit feedback** — every panel surfaces the data-source badge so a desk operator can see at a glance whether the data is real, hybrid, or seed.
- **Operator console at `/oems/integration`** — endpoint health + IRESS v4 → OEMS surface map + WSDL/version + gap call-outs.
- **IRESS Migration console at `/oems/iress-migration`** — per-symbol accuracy scoreboard for the Yahoo → IRESS(PROD) cutover.
- **Honest empty states** — `EmptyDataState` is used everywhere a BFF returns `source: "unavailable"` / `unconfigured`.

---

## 28. Open gaps in the OEMS surface

- **Rebalance push returns 501** — `POST /api/rebalance/requests/[id]/push` is disabled since 2026-07-27. Use `POST /api/admin/orderbook/send-to-market` instead.
- **Research Lab thesis add/remove is session-only** — `/oems/research-lab-legacy` (the v1 editor) doesn't persist proposals to the DB. Real workflow is on `/oems/research` + Research Library + IC voting.
- **IC voting UI not yet shipped to all personas** — only `/oems/committee` shows it; no top-level banner for the 3 committee members.
- **`oems_strategy_c` institutional rollup table is empty** — RETAIL `strategies_c` is still the source.
- **Per-user `page_access` RBAC wiring still in flight** — `nav.ts:160-165` uses a stop-gap `visibleFor()` until RBAC lands.
- **TimeSeriesGet2 entitlement pending for many tier-2 panels** — ALSI/J203 is WORKING; sector indices, R-codes, ZAR NSS curve still blocked.
- **C4 broker fill pipeline is mock-only** — no fills → `stock_holdings_c` bridge yet (`workers/broker-ingest/`).
- **C6 Ozone wallet top-up is mock-only** — `OZONE_MODE=mock` until Tsie contract.

---

*This doc is the desk tour. Pair with Doc 4 (IRESS adapter) for the data path, Doc 5 (Railway worker) for the ingest side, and Doc 9 (API surface) for the BFF contracts.*
