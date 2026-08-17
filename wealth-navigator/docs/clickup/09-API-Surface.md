# Wealth Navigator — API Surface (every `/api` route, contract, auth)

**Audience:** developers, on-call, integrators.
**Last reviewed:** 2026-08-15.
**Source of truth:** `wealth-navigator/src/app/api/`, `wealth-navigator/src/lib/auth/`, `wealth-navigator/src/lib/admin/rbac.ts`, `wealth-navigator/src/lib/orders/preflight.ts`, `wealth-navigator/src/lib/rebalance/`, `wealth-navigator/src/lib/research-ic/`, `wealth-navigator/src/lib/supabase/server.ts`, `wealth-navigator/src/lib/data-policy.ts`, `wealth-navigator/src/lib/bff-reasons.ts`.

> **Correction vs older handoffs:** Rebalance `push` returns **HTTP 501 `deferred`**. The real basket path is `POST /api/admin/orderbook/send-to-market`. `/api/orders/stream` is SSE.

---

## 1. API conventions

### Path A vs Path B (Path A is the default)
- **Path A** — Worker writes IRESS-derived data to Supabase (every ~15s for quotes, ~60s for orders). BFF reads through Supabase service-role clients.
- **Path B** — BFF reverse-proxies the worker's HTTP API (port 8765). Gated by `IRESS_WORKER_URL` (or `RAILWAY_SERVICE_URL`) and the shared `WORKER_HTTP_TOKEN` (Bearer).
- Default-on `USE_SUPABASE_QUOTES=true` on Vercel. Path B is opt-in via the URL convention `live` (`/api/orders/live`) or by endpoint type (SSE).

### Authentication
- **Supabase Auth** — email/password for staff; magic-link invite for new joiners via `/signup` + `/reset-password`.
- **Server-side session** — `wealth-navigator/src/lib/supabase/server.ts` resolves the session for each route.
- **Service-role clients** — server-side only, bypass RLS.
- **`createAuthAdminClient()`** — matches the project ref of `NEXT_PUBLIC_SUPABASE_URL` to pick the right service-role key for `auth.admin.*` calls.
- **Cron auth** — `Authorization: Bearer ${CRON_SECRET}` required for `/api/cron/*`.
- **Worker passthrough auth** — `Authorization: Bearer ${WORKER_HTTP_TOKEN}` required for Path B worker endpoints.

### Error shape
- JSON error envelope: `{ error: string, reason?: string, details?: any }`.
- `reason` is a typed `BffUnavailableReason` (`wealth-navigator/src/lib/bff-reasons.ts`).
- 4xx for client errors, 5xx for server errors.
- 501 `deferred` for disabled endpoints (e.g., `POST /api/rebalance/requests/[id]/push`).

### Data-source field
- Most BFF responses include `source: string` indicating the data tier.
- `mapSource()` (`wealth-navigator/src/lib/data-source.ts:27-55`) normalises free-form BFF `source` strings into the badge kind.

### Caching
- `?mock=1` URL param flips to mock data (client mirror).
- 60s client-side polling for most surfaces; 30s staleTime for `/api/company-analysis/[sym]`.

---

## 2. Auth routes (`/api/auth/*`)

### `POST /api/auth/login`
- Body: `{ email, password }`.
- Response: `{ user, session, redirect_url }`.
- Calls Supabase Auth `signInWithPassword()`.

### `POST /api/auth/signup`
- Body: `{ email, password, full_name, role_request? }`.
- Response: `{ user, message }`.
- Sends magic-link invite for new joiners.

### `POST /api/auth/logout`
- Calls Supabase Auth `signOut()`.
- Response: `{ success: true }`.

### `POST /api/auth/reset-password`
- Body: `{ email }`.
- Sends password reset email via Supabase Auth.

### `POST /api/auth/callback`
- Supabase email-link handler.
- Body: `{ code }`.
- Exchanges code for session.

---

## 3. Order routes (`/api/orders/*`)

### `POST /api/orders/preflight`
- **Path A** (local). No worker passthrough.
- Body: `{ symbol, side, quantity, source }`.
- Validates symbol entitlement, side, quantity, source.
- Reads `oems_account_c` (cash + position snapshot) + in-flight orders from `oems_order_audit`.
- Response: `{ ok, blockers[], warnings[] }`.
- Implementation: `wealth-navigator/src/lib/orders/preflight.ts`.

### `POST /api/orders/submit`
- **Path B** — worker `/orders/send-to-market` (when UAT mode) or `/uat/send-to-market`.
- Body: `{ symbol, side, quantity, price?, tif?, destination? }`.
- Generates `OrderTag` UUID server-side.
- Returns 503 when `IRESS_ACCOUNT_CODE` not configured.
- Returns 5xx when worker unreachable.
- Response: `{ order_id, order_tag, status }`.

### `POST /api/orders/cancel`
- Body: `{ order_id, account_code? }`.
- **MOCK client** → `/api/orders/cancel` (server-side mock).
- Worker passthrough planned (`workers/iress-ingest/src/http-api.ts::/orders/cancel`).

### `POST /api/orders/amend`
- Body: `{ order_id, qty?, price?, tif? }`.
- **MOCK client** → `/api/orders/amend`.
- Worker passthrough planned.

### `GET /api/orders`
- **Path A** — reads `oems_order_audit`.
- Query params: `status?`, `account_code?`, `limit?`, `offset?`.
- Response: `{ orders[], source: "supabase" }`.

### `GET /api/orders/live`
- **Path B** — worker `/orders` (`OrderPadGetByAccount`).
- Response: `{ orders[], source: "worker" }`.
- Gated by `IRESS_WORKER_URL` and `WORKER_HTTP_TOKEN`.

### `GET /api/orders/stream`
- **SSE** — worker `/orders/stream`.
- Response: SSE event stream of order state updates.
- Returns `null` when unconfigured.

### `POST /api/orders/recover-by-ordertag`
- Worker passthrough — `OrderNoGetByOrderTag(orderTag)`.
- Body: `{ order_tag }`.
- Response: `{ order_id }`.

---

## 4. Portfolio routes (`/api/portfolio/*`)

### `GET /api/portfolio/[accountCode]`
- Reads `oems_position_c` + `oems_transaction_c` on institutional.
- Response: `{ positions[], transactions[], summary }`.

### `GET /api/portfolio/[accountCode]/pnl`
- Day-1 P&L from `oems_order_audit.result_payload->dayOnePnlCents`.
- Response: `{ day1_pnl_cents, total_pnl_cents }`.

### `GET /api/portfolio/[accountCode]/positions`
- Positions only.
- Response: `{ positions[] }`.

### `GET /api/portfolio/[accountCode]/transactions`
- Transactions only.
- Response: `{ transactions[] }`.

---

## 5. Strategies routes (`/api/strategies/*`)

### `GET /api/strategies`
- **Path A** — reads RETAIL `strategies_c`.
- Response: `{ strategies[] }` (with `aum`, `dayPnl`, `ytd`, `nav`, `investorCount`, `holdingsCount`, `cashWeight`, `holdingsPreview`, `minValue` per strategy — lines 464-534).
- Implementation: `wealth-navigator/src/app/api/strategies/route.ts:464-534`.

### `GET /api/strategies/[id]`
- Single strategy.

### `GET /api/strategies/[id]/composition`
- Strategy baseline composition (holdings + weights).
- Response: `{ composition[] }`.

### `POST /api/strategies`
- Create a strategy (admin-only).
- Body: `{ name, slug, description, fee_pct, … }`.

### `PATCH /api/strategies/[id]`
- Update strategy (admin-only).

### `GET /api/strategies/returns`
- Strategy returns with `J203` benchmark.
- Response: `{ returns[] }`.

---

## 6. Rebalance routes (`/api/rebalance/*`)

### `POST /api/rebalance/impact`
- Hard rule at lines 16-25: "HARD CLIENT-DATA BOUNDARY — This reads the RETAIL/LIVE database, so it is scoped to TEST CLIENTS ONLY… A real client (is_test=false) is never read."
- Body: `{ strategy_id, changes[] }`.
- Computes per-change impact: weight delta, cash delta, drift vs target.
- Response: `{ impact }`.
- Implementation: `wealth-navigator/src/app/api/rebalance/impact/route.ts:44-288`.

### `POST /api/rebalance/requests`
- Create rebalance request.
- Body: `{ strategy_id, proposed_changes, rationale }`.
- Response: `{ request_id, status: "pending" }`.

### `GET /api/rebalance/requests`
- List rebalance requests.

### `GET /api/rebalance/requests/[id]`
- Single rebalance request.

### `POST /api/rebalance/requests/[id]/vote`
- Body: `{ vote: "yes" | "no" | "abstain" }`.
- Server-side committee gate.
- Auto-promotes `pending → ic_approved` if YES ≥ 2.

### `POST /api/rebalance/requests/[id]/push`
- **HTTP 501 `deferred`** since 2026-07-27.
- Comment at `src/app/api/rebalance/requests/[id]/push/route.ts:97-123`: would emit unattributable orders.
- **Real basket path** — `POST /api/admin/orderbook/send-to-market`.

---

## 7. Research routes (`/api/research/*`)

### `POST /api/research/notes`
- Create research note.
- Body: `{ symbol, target_price, recommendation, time_horizon, thesis, bull_case, bear_case, key_risks, tags, references }`.
- Response: `{ note_id, status: "ic_pending" }`.

### `GET /api/research/notes`
- List research notes.
- Query params: `status?`, `symbol?`, `author?`, `limit?`, `offset?`.

### `GET /api/research/notes/[id]`
- Single research note.

### `PATCH /api/research/notes/[id]`
- Update research note (author only).

### `POST /api/research/notes/[id]/vote`
- Body: `{ vote: "yes" | "no" | "abstain" }`.
- Server-side committee gate.
- Auto-promotes `ic_pending → ic_approved` if YES ≥ 2.

### `POST /api/research/notes/[id]/archive`
- Archive research note (author or admin).

---

## 8. Models routes (`/api/models/*`)

### `GET /api/models`
- List models with metrics.
- Response: `{ models[] }`.

### `POST /api/models`
- Register new model (admin-only).
- Body: `{ slug, name, description, strategy, universe, benchmark, currency, budget_cents, rebalance_freq }`.

### `GET /api/models/[id]`
- Single model with equity curve + summary metrics.
- Server overrides `budget/final_equity/total_return/max_drawdown` from equity curve (lines 73-122).

### `PATCH /api/models/[id]`
- Update model metadata (model author only).

### `DELETE /api/models/[id]`
- Archive model (model author or admin).

### `GET /api/models/[id]/benchmark`
- Benchmark comparison (model vs benchmark).
- Returns alpha, beta, tracking error, info ratio, up/down capture, max drawdown (lines 233-341).

### `GET /api/models/[id]/paper`
- Paper account current state.
- Response: `{ equity_curve[], positions[], pnl }`.

### `GET /api/models/[id]/paper/positions`
- Paper account positions only.

### `POST /api/models/[id]/paper/positions`
- Manual paper trade (admin-only).

### `GET /api/models/[id]/trades`
- Paper account trade blotter.

### `GET /api/models/[id]/predictions`
- Daily predictions.

### `POST /api/models/[id]/predictions`
- Manual prediction (model author only).

---

## 9. Quotes & market data routes (`/api/quotes/*`, `/api/intraday/*`, `/api/equities/*`, `/api/indices/*`, `/api/news/*`)

### `GET /api/quotes`
- Body: `{ symbols? }` (single or array).
- Reads RETAIL `securities_c` + `stock_intraday_c` + `quote_snapshot_c` overlay.
- HYBRID via worker.

### `GET /api/intraday/[sym]`
- Reads `stock_intraday_c` (retail) or `index_intraday_c` (institutional).
- HYBRID via worker.

### `GET /api/equities`
- Body: `{ sector?, limit?, offset? }`.
- Reads RETAIL `securities_c`.
- HYBRID via worker.

### `GET /api/indices/J203`
- ALSI/J203 intraday.
- `TimeSeriesGet2(zax, jse)` — WORKING post-2026-07-09.
- Falls back to `^J203.JO` Yahoo.

### `GET /api/curves/[code]`
- Body: `{ from?, to? }`.
- Reads INSTITUTIONAL `yield_curve_history_c`.
- Gated on entitlement.

### `GET /api/curves/ZAR_NSS/metrics`
- Reads INSTITUTIONAL `oems_curve_metric_c`.

### `GET /api/news`
- Reads RETAIL `News_articles` + RSS (Moneyweb + BusinessTech) + IRESS `news_item_c`.
- EXTERNAL (RSS) / SEED / T5_PASSTHROUGH.

### `GET /api/iress/news`
- Worker passthrough — `/debug/news-vendor-probe` (T5 passthrough).
- Response: `{ vendor, items[] }`.

### `GET /api/company-analysis/[sym]`
- 60s poll, 30s staleTime.
- Returns `{ summary, fundamentals, ai_cache }`.

### `GET /api/company-analysis/[sym]/chart`
- Returns chart data for the symbol.

---

## 10. Integration routes (`/api/integration/*`)

### `GET /api/integration/health`
- Worker `/health`.
- Response: `{ worker, broker, iress, status }`.
- `broker: { status: "unconfigured" }` when `BROKER_WORKER_URL` is empty (`src/app/api/integration/health/route.ts:124-125`).

### `GET /api/integration/diagnostics`
- Worker `/debug/ips-session`.

### `GET /api/worker-health`
- Reads INSTITUTIONAL `integration_worker_health`.

### `GET /api/iress/health`
- Adapter liveness + entitlement check.
- Calls `NewsHeadlineGet` vendor probe.

### `GET /api/iress/provenance`
- Returns IRESS V4 → OEMS surface map.

### `GET /api/iress/validation`
- Per-symbol accuracy scoreboard (Yahoo → IRESS(PROD) cutover).
- Reads INSTITUTIONAL `iress_price_validation_c`.

### `POST /api/iress/validation/approve`
- Approve a symbol's IRESS validation (admin-only).

---

## 11. Cron routes (`/api/cron/*`)

### `GET /api/cron/yahoo-fundamentals`
- `*/5 * * * 1-5` (every 5 min on weekdays).
- Default **shadow** — runs but doesn't write.
- Set `YAHOO_FUNDAMENTALS_WRITE=1` to flip to **live writes**.
- Response: `{ processed_count, write_mode }`.

### `GET /api/cron/iress-validation`
- `0 13 * * 1-5` (13:00 UTC on weekdays).
- Per-symbol accuracy scoreboard refresh.

### `GET /api/cron/position-reconciliation`
- `30 15 * * 1-5` (15:30 UTC on weekdays).
- Compares `oems_position_c` vs `stock_holdings_c`.
- Surfaces discrepancies as alerts.

All cron routes require `Authorization: Bearer ${CRON_SECRET}`.

---

## 12. Admin routes (`/api/admin/*`)

### `POST /api/admin/orderbook/send-to-market`
- **Real basket path** for rebalance-approved orders.
- Body: `{ strategy_id, request_id, orders[] }`.
- Routes to worker `/uat/send-to-market` or `/orders/send-to-market` depending on UAT mode.
- Production-order readiness gate check.
- Response: `{ sent[], blockers[] }`.

### `GET /api/admin/orderbook`
- Reads INSTITUTIONAL `oems_order_audit`.

### `GET /api/admin/clients`
- Reads RETAIL profiles (test clients only — `is_test=true`).

### `GET /api/admin/investors`
- Same as `/api/admin/clients` with `investor` semantics.

### `GET /api/admin/finance`
- **Phase C7 finance aggregator**.
- AUM fees from RETAIL `client_strategy_returns_c` × `strategies_c.payload.fee_pct` (lines 99-153).
- Day-1 P&L from INSTITUTIONAL `oems_order_audit.result_payload->dayOnePnlCents` (lines 187-212).
- Response: `{ aum_fees, day1_pnl, breakdown }`.

### `GET /api/admin/cyber-compliance`
- Reads `cc_audit_log` + API health + incidents + policy checks.

### `GET /api/admin/studio`
- Magic-link issuance.

### `POST /api/admin/eft/ozone-topup`
- Mock-only (C6 blocked on Tsie).
- Body: `{ user_id, amount_cents }`.
- Response: `{ redirect_url, ozone_ref }`.

### `GET /api/admin/mint-mornings`
- Daily newsletter data.

### `GET /api/admin/emailers`
- Email campaign data.

### `GET /api/admin/app-settings`
- App-level settings.

### `GET /api/admin/team`
- Team members from `admin_team`.

---

## 13. WM (Wealth Manager) routes (`/api/wm/*`)

### `GET /api/wm/clients`
- Per-client book from RETAIL Supabase.

### `GET /api/wm/clients/[id]`
- Single client book.

### `GET /api/wm/holdings/[user_id]`
- Per-client holdings.

### `GET /api/wm/transactions/[user_id]`
- Per-client transactions.

### `GET /api/wm/performance/[user_id]`
- Per-client performance.

### `GET /api/wm/rebalance-proposals/[user_id]`
- Per-client rebalance proposals.

---

## 14. Canvas routes (`/api/canvas/*`)

### `GET /api/canvas/layout`
- Load user's default layout.

### `POST /api/canvas/layout`
- Save layout.

### `GET /api/canvas/engines`
- List registered engines.

### `POST /api/canvas/engines`
- Register a new engine (admin-only).

### `POST /api/canvas/presence`
- Heartbeat presence.

### `DELETE /api/canvas/presence`
- Untrack presence.

### `POST /api/chatsight/ask`
- Body: `{ question, context? }`.
- Response: `{ answer, engine_preview? }`.

### `POST /api/chatsight/build`
- Body: `{ prompt }`.
- Response: `{ engine }`.

---

## 15. Admin auth + RBAC (`/api/admin/auth/*`, `/api/admin/audit/*`)

### `POST /api/admin/auth/login`
- Server-side admin auth.

### `GET /api/admin/audit`
- Reads `cc_audit_log`.

### `GET /api/admin/audit/[id]`
- Single audit entry.

### `GET /api/admin/audit/user/[user_id]`
- Per-user audit trail.

---

## 16. KYC routes (`/api/kyc/*`)

### `GET /api/kyc/[user_id]`
- Per-user KYC status from RETAIL.

### `POST /api/kyc/[user_id]`
- Update KYC (admin-only).

### `GET /api/kyc/[user_id]/docs`
- KYC documents (Sumsub, Experian).

---

## 17. Gift routes (`/api/gift/*`)

### `GET /api/gift/[user_id]`
- Per-user gift registry.

### `POST /api/gift`
- Create a gift.

### `POST /api/gift/[id]/authorize`
- Authorize-then-fill model.

### `POST /api/gift/[id]/fill`
- Fill the gift.

---

## 18. Loan routes (`/api/loan/*`)

### `GET /api/loan/[user_id]`
- Per-user loan applications.

### `POST /api/loan`
- Create loan application.

### `POST /api/loan/[id]/approve`
- Approve loan application.

---

## 19. Funeral cover routes (`/api/fc/*`)

### `GET /api/fc/overview`
- Funeral cover overview.

### `GET /api/fc/[user_id]`
- Per-user funeral cover.

---

## 20. Settings + persona routes (`/api/settings/*`, `/api/persona/*`)

### `GET /api/settings`
- App-level settings.

### `POST /api/settings`
- Update settings (admin-only).

### `POST /api/persona/switch`
- Body: `{ persona }`.
- Server-side validation against `admin_team`.

### `GET /api/persona/list`
- List available personas.

---

## 21. Search routes (`/api/search/*`)

### `GET /api/securities/search`
- Body: `{ query }`.
- Symbol search.

### `GET /api/securities/[symbol]`
- Single security metadata.

### `GET /api/clients/search`
- Client search (admin-only).

---

## 22. Auth admin routes (`/api/auth/admin/*`)

### `POST /api/auth/admin/invite`
- Body: `{ email, role }`.
- Sends magic-link invite (admin-only).
- Uses `createAuthAdminClient()` to pick the right project.

### `POST /api/auth/admin/delete`
- Body: `{ user_id }`.
- Deletes a user (admin-only).

### `POST /api/auth/admin/update-role`
- Body: `{ user_id, role }`.
- Updates user role.

---

## 23. Server-side helpers (lib)

### `wealth-navigator/src/lib/orders/preflight.ts`
- `preflight()` — local server-side pre-trade check.

### `wealth-navigator/src/lib/rebalance/`
- `computeImpact()` — server-side rebalance impact.
- `tallyVotes()` — vote tally.

### `wealth-navigator/src/lib/research-ic/`
- `committee.ts` — roster + threshold.
- `committee-gate.ts` — server-side gate.
- `tally.ts` — tally.
- `promotion.ts` — auto-promotion.

### `wealth-navigator/src/lib/admin/rbac.ts`
- `requireRole(role)` — server-side RBAC check.
- `requireAdmin()` — admin-only check.

### `wealth-navigator/src/lib/supabase/server.ts`
- `createRetailServiceRoleClient()` — RETAIL DB.
- `createInstitutionalServiceRoleClient()` — INSTITUTIONAL DB.
- `createAuthAdminClient()` — auth admin.
- `createServiceRoleClient()` — deprecated alias → INSTITUTIONAL.
- `resolveServiceTarget(target)` — central target resolver.

### `wealth-navigator/src/lib/data-policy.ts`
- `isUseSupabaseQuotesEnabled()` — Path A gate.
- `isRealDataOnlyClient()` — client mirror.
- `isProductionRealDataMode()` — alias.
- `isWorkerLiveMode()` — Path B gate.
- `getIressWorkerUrl()` — IRESS_WORKER_URL → RAILWAY_SERVICE_URL.
- `isIressWorkerConfigured()` — used by every Path B route.

### `wealth-navigator/src/lib/bff-reasons.ts`
- `BffUnavailableReason` — typed error reasons.

### `wealth-navigator/src/lib/iress/worker-api.ts`
- `callWorker(opts)` — Path B call with bearer.
- `streamWorkerSse(opts)` — SSE stream.
- `WorkerApiResult` — discriminated union.

---

## 24. RBAC matrix

| Role | Routes |
|---|---|
| Anonymous | `/api/auth/*`, `/api/cron/*` (with CRON_SECRET) |
| Authenticated user | `/api/wm/*`, `/api/canvas/layout`, `/api/portfolio/[own]`, `/api/orders/[own]` |
| OEMS operator | `/api/orders/*`, `/api/portfolio/*`, `/api/strategies/*`, `/api/rebalance/*`, `/api/research/*`, `/api/models/*`, `/api/integration/*` |
| IC member | `/api/research/notes/[id]/vote`, `/api/rebalance/requests/[id]/vote` |
| Admin | `/api/admin/*`, `/api/auth/admin/*`, `/api/admin/orderbook/send-to-market` |
| Worker | All Path B worker endpoints (with WORKER_HTTP_TOKEN) |

---

## 25. Open gaps

- **Rebalance push returns 501** — use `POST /api/admin/orderbook/send-to-market` instead.
- **Cancel/amend mock-only** — worker has routes; BFF doesn't pass through yet.
- **Broker pipeline mock-only** — no fills → `/api/portfolio/[accountCode]/pnl` is gross (no broker fees).
- **`avgPx` unit ambiguity** — pin the SOAP unit before trusting positions.
- **No fills → `stock_holdings_c` bridge** — broker fill price/qty never corrects the client's held quantity or cost basis.
- **News vendor write gate** — `/api/iress/news` is T5 passthrough only.
- **No IRESS_ORDER_EXECUTION_ENABLED flag** — production-order readiness gate is a sanity signal only.
- **Per-client attribution gap** — orders hard-forced to MKT with no client reference.

---

*This doc is the API surface reference. Pair with Doc 4 (IRESS adapter) for the SOAP side, Doc 5 (Railway worker) for the ingest side, and Doc 10 (risk/compliance) for the audit posture.*
