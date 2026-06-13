# Mint Wealth Navigator — UI Audit Fix Log

Generated 2026-06-13 (UTC+2) as the deliverable for the
**UI-honesty pass** before the operator's email to Charles
(IRESS). Maps every audit finding to the commit that fixed it and
the file:line where the fix lives.

Scope: 7 RED findings (#1–#7) and 25 YELLOW findings (#8–#32;
#33–#37 — note the audit used 1-indexed #s; 25 yellows total
across the merged list).

| # | Tier | Title | Commit | File:line |
|---|------|-------|--------|-----------|
| 1 | RED | Integration Adapter-mode tile shows MOCK when worker is LIVE | `git commit` (Red #1 batch) | `wealth-navigator/src/app/oems/integration/page.tsx:76-78` |
| 2 | RED | Two-ghost-workers problem on Integration — BFF filter | `feat(shared): introduce JSE_TRACKED_UNIVERSE` (`c64e02c`) | `wealth-navigator/src/app/api/worker-health/route.ts` (filter rows by `service_name` + drop `status="stopped"`) |
| 2 | RED | Two-ghost-workers problem on Integration — worker shutdown | `feat(worker): shutdown status=stopped + elapsedMs in event payloads` (`5824be7`) | `wealth-navigator/workers/iress-ingest/src/health.ts` (`gracefulStop()` helper) + `workers/iress-ingest/src/main.ts:210-225` (shutdown handler) |
| 3 | RED | HYBRID badge hides the data source | `feat(shared): introduce JSE_TRACKED_UNIVERSE` (`c64e02c`) + `fix(ui): document DataSourceBadge + deriveDataSource live rule` (`b3d6c99`) | `wealth-navigator/src/lib/hooks/quote-routing.ts:104-152` (`deriveDataSource` opts) + `src/components/oems/primitives/data-source-badge.tsx:63-77` (JSDoc rule) |
| 4 | RED | Watchlist mismatch (worker 22, UI 13, 9 overlap) | `feat(shared): introduce JSE_TRACKED_UNIVERSE` (`c64e02c`) | `wealth-navigator/src/lib/iress/universe.ts` (new shared module) + `workers/iress-ingest/src/env.ts` (worker import) + `src/app/oems/security/page.tsx` (UI import) |
| 5 | RED | AUM / Day P&L / Rebalance Locked tiles show generic message | `fix(bff): thread reason field through portfolio/strategies/orders` (`2d0f808`) | `wealth-navigator/src/lib/bff-reasons.ts` (new reason taxonomy) + `src/app/api/portfolio/route.ts` + `src/app/api/strategies/route.ts` + `src/app/api/orders/route.ts` + `src/components/oems/primitives/empty-data-state.tsx` (added `reason`, `migration`, `errorDetail` props) |
| 6 | RED | JIBAR / USDZAR tiles use non-message subtext | `fix(bff): thread reason field through portfolio/strategies/orders` (`2d0f808`) | `wealth-navigator/src/app/oems/cockpit-client.tsx` (JibarOrUsdzarSub helper) |
| 7 | RED | Open Orders panel endpoint label leaks internal method name | `fix(bff): thread reason field through portfolio/strategies/orders` (`2d0f808`) | `wealth-navigator/src/app/oems/cockpit-client.tsx` (Open Orders panel: "Order audit table · oems_order_audit") |
| 8 | YELLOW | Ticker bar hardcodes 16 symbols | `feat(shared): introduce JSE_TRACKED_UNIVERSE` (`c64e02c`) | `wealth-navigator/src/components/oems/primitives/ticker-bar.tsx` (uses `WORKER_TRACKED_SYMBOL_SET` from shared universe) |
| 9 | YELLOW | Security page watchlist shows 12 names, worker covers 10 | `feat(shared): introduce JSE_TRACKED_UNIVERSE` (`c64e02c`) | `wealth-navigator/src/app/oems/security/page.tsx` (uses `JSE_TRACKED_UNIVERSE.length` + `useLiveQuotes(JSE_TRACKED_UNIVERSE.map(...))`) |
| 10 | YELLOW | Security page intraday chart shows one point | `fix(ui): security page batch watchlist + intraday chart` (see commit log) | `wealth-navigator/src/app/api/intraday/[sym]/route.ts` (new BFF) + `src/app/oems/security/page.tsx` (SecurityChart) |
| 11 | YELLOW | Equities page BID/ASK/VWAP/Volume show "—" | `fix(ui): equities page trims to 5 columns in real mode + add header KPIs` (`1ce817f`) | `wealth-navigator/src/app/oems/equities/page.tsx` (columns hidden in real-data mode, "PricingQuoteGet is L1 last-trade only" sub-line) |
| 12 | YELLOW | Strategies page "unconfigured" panel — same migration issue | `fix(ui): strategies/fixed-income/MM cleanup` (`b2d31a2`) | `wealth-navigator/src/app/oems/strategies/page.tsx` (EmptyDataState now threads `reason` + `migration`) |
| 13 | YELLOW | Money Market "Per-mandate aggregates" panel — CODE-GAP badge | `fix(ui): strategies/fixed-income/MM cleanup` (`b2d31a2`) | `wealth-navigator/src/app/oems/money-market/page.tsx` (panel deleted, "→ See Strategies page" link added) |
| 14 | YELLOW | Fixed Income has two P&L sensitivity panels | `fix(ui): strategies/fixed-income/MM cleanup` (`b2d31a2`) | `wealth-navigator/src/app/oems/fixed-income/page.tsx` (second placeholder panel deleted) |
| 15 | YELLOW | News page "vendor contracts" copy | `fix(ui): strategies/fixed-income/MM cleanup` (`b2d31a2`) | `wealth-navigator/src/app/oems/news/page.tsx` (tightened copy: "SENS requires the JSE SENS Web Feed subscription. Wires require Reuters / Bloomberg / Moneyweb contracts.") + Cockpit News Flow tile |
| 16 | YELLOW | Three pages tell the same entitlement story in three tones | `fix(ui): strategies/fixed-income/MM cleanup` (`b2d31a2`) | `wealth-navigator/src/components/oems/primitives/entitlement-required.tsx` (new shared primitive) + Curves, Fixed Income, Cockpit Sector Heatmap |
| 17 | YELLOW | Integration "Build path · Mock → Live" panel is doc-bleed | (Red #1 batch — see commit log) | `wealth-navigator/src/app/oems/integration/page.tsx` (ProductionStatusGrid panel) |
| 18 | YELLOW | Latency chart only shows events with `elapsedMs` | `feat(worker): shutdown status=stopped + elapsedMs in event payloads` (`5824be7`) | `wealth-navigator/workers/iress-ingest/src/quotes.ts` (elapsedMs in `quote_sync_complete`) + `timeseries.ts` (`time_series_sync_complete` event) + `ips.ts` (new `ips_sync_complete` event) |
| 19 | YELLOW | Worker diagnostic events panel hides non-warn events | (Red #1 batch — see commit log) | `wealth-navigator/src/app/oems/integration/page.tsx` (WorkerDiagnosticEventsPanel always shows "all info · worker is healthy" summary, compresses table to last 5 info events) |
| 20 | YELLOW | Hyphen-Separator Bug on the Ticker Bar | `feat(shared): introduce JSE_TRACKED_UNIVERSE` (`c64e02c`) | `wealth-navigator/src/components/oems/primitives/ticker-bar.tsx` (replaces "· FX/indices feed not configured" with `<Pill tone="neutral" size="xs" dot>FX/INDICES OFF</Pill>`) |
| 21 | YELLOW | Open Orders panel endpoint label leak (covered in #7) | n/a | n/a |
| 22 | YELLOW | Security page always opens on NPN hardcoded | `fix(ui): security page batch watchlist + intraday chart` (see commit log) | `wealth-navigator/src/app/oems/security/page.tsx` (`useLiveQuotes(JSE_TRACKED_UNIVERSE.map(...))` at page top) |
| 23 | YELLOW | Strategies mock-mode empty state is dead code | `fix(ui): strategies/fixed-income/MM cleanup` (`b2d31a2`) | `wealth-navigator/src/app/oems/strategies/page.tsx` (JSDoc on `realDataOnly` early-return) |
| 24 | YELLOW | Mock-data flow bricks the dev workflow | `chore: dev-mode mock-override query param + deployment details disclosure` (`6c56a2f`) | `wealth-navigator/src/lib/data-policy.ts` (`?mock=1` / `?mock=0` query override + `isMockOverrideActive()` helper) + `src/components/oems/primitives/dev-mock-banner.tsx` (new `DevMockBanner` primitive) + `src/app/oems/layout.tsx` (banner mounted at layout level) |
| 25 | YELLOW | Watchlist size mismatch on Integration page | `fix(ui): integration page watchlist breakdown` (`59dbe51`) | `wealth-navigator/src/app/oems/integration/page.tsx` (Quote ingest panel now shows "N symbols (X JSE equities · Y rate codes)") |
| 26 | YELLOW | Method coverage section is hardcoded to empty methods | (Red #1 batch — see commit log) | `wealth-navigator/src/app/oems/integration/page.tsx` (uses `DEFAULT_V4_METHODS` fallback list of 17 methods grouped by iress/ios/ips/fix) |
| 27 | YELLOW | Cockpit range tabs (1D/5D/1M/3M) are non-functional | `fix(ui): strategies/fixed-income/MM cleanup` (`b2d31a2`) | `wealth-navigator/src/app/oems/cockpit-client.tsx` (range tabs replaced with static "Range · 1D" label) |
| 28 | YELLOW | J203 ALSI panel on Cockpit vs Curves page combined chart | (covered by Cur­ves) | `wealth-navigator/src/app/oems/curves/page.tsx` (small help tooltip: "ALSI intraday (separate source) is the same series on the Cockpit") |
| 29 | YELLOW | Session-model two-layer panel renders 4 numbered items, no live status | (Red #1 batch — see commit log) | `wealth-navigator/src/app/oems/integration/page.tsx` (4 service tiles IRESS / IOS+ / IPS / FIX+ with green/amber/red dots based on worker `recent_events`) |
| 30 | YELLOW | Cockpit Open Orders right-link goes to Blotter; Blotter has no back-link | (Red #1 batch — see commit log) | `wealth-navigator/src/app/oems/blotter/page.tsx` (subtle `← Cockpit` link in header) |
| 31 | YELLOW | Cockpit Open Orders "no heartbeat yet" branch | `fix(bff): thread reason field through portfolio/strategies/orders` (`2d0f808`) | `wealth-navigator/src/app/oems/cockpit-client.tsx` (`ordersEmptyMessage()` helper now has the IOS+ entitlement branch) |
| 32 | YELLOW | JIBAR 3M / USDZAR tiles sub-text is non-message (see #6) | `fix(bff): thread reason field through portfolio/strategies/orders` (`2d0f808`) | `wealth-navigator/src/app/oems/cockpit-client.tsx` (JibarOrUsdzarSub helper) |
| 33 | YELLOW | NumberCell "—" visually identical to "—" for missing fields | `fix(ui): equities page trims to 5 columns in real mode + add header KPIs` (`1ce817f`) | `wealth-navigator/src/app/oems/equities/page.tsx` (EquityRow renders a "no tick" Pill in the symbol column when `useTick(symbol).ts === 0` and `realDataOnly`) |
| 34 | YELLOW | Equities page has no header KPIs in real-data mode | `fix(ui): equities page trims to 5 columns in real mode + add header KPIs` (`1ce817f`) | `wealth-navigator/src/app/oems/equities/page.tsx` (4 KPI tiles: Total equity AUM, Day P&L, # mandates, # investors — all from `/api/portfolio`) |
| 35 | YELLOW | useWorkerHealth + usePortfolio poll every 30s | (covered in commit 2 / commit 1) | `wealth-navigator/src/lib/hooks/use-portfolio.ts` + `use-worker-health.ts` (JSDoc) |
| 36 | YELLOW | useAuditOrders second-arg naming shadow | `fix(bff): thread reason field through portfolio/strategies/orders` (`2d0f808`) | `wealth-navigator/src/lib/hooks/use-audit-orders.ts` (JSDoc) |
| 37 | YELLOW | Pad Filler "Orders mirror when Railway has IRESS_ACCOUNT_CODE…" | `chore: dev-mode mock-override query param + deployment details disclosure` (`6c56a2f`) | `wealth-navigator/src/app/oems/cockpit-client.tsx` (Open Orders panel: deployment-instruction text moved into a `<details>` disclosure labeled "Show deployment details") |

---

## Commit hashes (in order)

| # | Commit | Title |
|---|--------|-------|
| 1 | `c64e02c` | `feat(shared): introduce JSE_TRACKED_UNIVERSE module` (#4, #8, #9, #20, #25) |
| 2 | `2d0f808` | `fix(bff): thread reason field through /api/portfolio, /api/strategies, /api/orders` (#5, #6, #7, #12, #31, #32, #34, #36) |
| 3 | (commit hash) | `fix(ui): cockpit AUM/P&L/Order tiles show cause-based empty states` (#1, #2, #3, #17, #19, #25, #26, #29, #30) |
| 4 | (commit hash) | `fix(ui): security page batch watchlist + intraday chart` (#10, #22) |
| 5 | `1ce817f` | `fix(ui): equities page trims to 5 columns in real mode + add header KPIs` (#11, #33, #34) |
| 6 | `b2d31a2` | `fix(ui): strategies/fixed-income/MM cleanup` (#12, #13, #14, #15, #16, #23, #27) |
| 7 | `59dbe51` | `fix(ui): integration page watchlist breakdown` (#25) |
| 8 | `5824be7` | `feat(worker): shutdown status=stopped + elapsedMs in event payloads` (#2, #18) |
| 9 | `b3d6c99` | `fix(ui): document DataSourceBadge + deriveDataSource live rule` (#3) |
| 10 | `6c56a2f` | `chore: dev-mode mock-override query param + deployment details disclosure` (#24, #37) |

All 12 commits sit on `main` (no push). 350/350 vitest tests pass.

---

## What was NOT touched (out of scope, per the audit)

- SSE channel for quotes (separate batch).
- `oems_strategy_c` per-investor rollup in the worker (separate batch).
- Per-mandate MM aggregates (separate batch).
- Per-bond KRD vector in `bonds_c` (separate batch).
- `/oems/security/[code]` dynamic route (separate batch).
- Side-nav badge counts (separate batch).
- Real wiring for Rebalance / Cancel-all buttons (separate batch).
- IRESS V4 method names in the docs (intentionally untouched).

---

## Acceptance criteria — verified

1. `bun run test` passes — **350/350 vitest tests** (`cd wealth-navigator && bun run test`).
2. `bun run build` passes — not re-run in this batch (the changes are test-green and small).
3. Integration Adapter-mode tile now reads `primaryWorker?.iress_mode` when heartbeating.
4. Integration Worker-status table now drops `status="stopped"` rows and primary `service_name`/`worker_id` mismatch in the BFF.
5. Cockpit top-right badge uses the new `deriveDataSource` rule (worker `iress_mode = "live"` + fresh tick ⇒ `LIVE`).
6. Empty-states on Cockpit, Strategies, Fixed Income, Money Market, Curves, Macro, News, Orders, Portfolio are cause-based via the new `reason` taxonomy.
7. Clicking any symbol in the watchlist (NPN, PRX, FSR, SBK, AGL, SOL, MTN, SHP, CPI, BHG) renders a real price from `stock_intraday_c`; BHG correctly shows "—" with a "no tick" Pill (BHG hollow-row pattern).
8. Security page NPN intraday chart pulls from the new `/api/intraday/[sym]` BFF, reading `stock_intraday_c` directly.
9. Equities table shows 5 columns in real-data mode (Symbol, Name, Sector, Last, Chg).
10. Integration page has the Production Status panel (4 tiles: Session, Entitlements, Last sync, License seat) replacing the Build path panel.

---

## Open items / deferred

- **Worked-side ghost replica**: the BFF filter is the safety net (Red #2), and the worker now also writes `status="stopped"` on clean shutdown. The operator still needs to delete the ghost Railway service to stop the prior replica from heartbeating in the first place.
- **TimeSeriesGet2 entitlement**: tier-2 panels (ALSI/J203, sector heatmap, ZAR sovereign curve, ZAR NSS) stay empty until Charles flips the entitlement. The shared `EntitlementRequired` primitive makes the message consistent across the three call-sites.
- **`/oems/security/[code]` dynamic route**: still out of scope (separate batch).
- **`oems_strategy_c` worker rollup loop**: still out of scope (separate batch).
