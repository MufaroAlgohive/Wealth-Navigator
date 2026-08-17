# Wealth Navigator — CEO Executive Summary & Product Vision

**Audience:** CEO + new joiners + stakeholders. Technical appendix at the end for the engineering team.
**Last reviewed:** 2026-08-15.
**Source of truth:** `Wealth Navigator/PLANNING.md`, `Wealth Navigator/AGENTS.md`, `Wealth Navigator/TABLES.md`, `wealth-navigator/docs/STACK_ARCHITECTURE.md`, `wealth-navigator/docs/DB_TOPOLOGY_DECISION.md`, `wealth-navigator/docs/DATA_PROVENANCE.md`, `wealth-navigator/docs/REMAINING_GAPS.md`, `wealth-navigator/docs/GO_LIVE_RUNBOOK.md`.

---

## 1. What is Wealth Navigator?

Wealth Navigator is **MINT's institutional trading desk** — the **OEM (Office of the Executor / Investment Manager)** product. It is a single multi-persona Next.js web app whose centerpiece is the **OEMS (Order & Execution Management System) trading desk**, wired directly to the **IRESS V4 Web Services** stack (the JSE member-firm trading network). It was rebuilt from a Lovable prototype in 2025-2026 into a production-grade Next.js 16 + React 19 + Bun + TypeScript strict + Tailwind + shadcn/ui application (`PLANNING.md:3`, `wealth-navigator/package.json`).

The **product is the desk. The desk is the product.** Surrounding surfaces — Research, Rebalance, Investment Committee, Canvas, Models, Admin, Finance — exist to support desk operators and the institutional wealth managers who use the platform to execute, allocate, govern, and report on discretionary client mandates.

Production URL: **`https://wealth-navigator-one.vercel.app`** (`AGENTS.md:7`, `wealth-navigator/docs/VERCEL_DEPLOY_SETUP.md:318`).
Worker domain: **`https://iress-worker-production.up.railway.app`** on port `8765` (`AGENTS.md:19`).

---

## 2. Personas & audience

The platform is built for an institutional trading floor. Six personas live in the routing layer (`wealth-navigator/src/lib/store/session-provider.tsx:6-30`, `PLANNING.md:13-24`):

| Persona | Default home | Status today |
|---|---|---|
| `oems` (Senior Trader) | `/oems` (Cockpit) | **Built** — centerpiece |
| `admin` (Compliance / Operations) | `/admin` | **Built** — order book, finance, clients, audit |
| `wealth_manager` (Senior WM) | `/wm/dashboard` | Live `/wm` is the retail client book; dashboard deferred |
| `strategist` (Quant Lead) | `/strategist` | Placeholder (persona persisted for future wiring) |
| `business` (Head of Business) | `/business` | Placeholder |
| `funeral_cover` (Ops Manager) | `/fc/overview` | Placeholder |

The **`oems` persona is the front door**. The home route `/` redirects to `/oems` in one line (`wealth-navigator/src/app/page.tsx:9-11`). Auth is Supabase-backed (email/password for staff; magic-link invite for new joiners via `/signup` + `/reset-password`). Real role derivation is server-side via `admin_team` (RETAIL DB), never user-selected (`wealth-navigator/src/lib/admin/rbac.ts`).

**KYC gate** is in the consumer retail app (`MintApp`), not in Wealth Navigator. The desk surfaces KYC status when it reads the client book (RETAIL `profiles` + `user_onboarding` + `required_actions`, per `TABLES.md:7-83`).

---

## 3. Product surface (the user-visible map)

### OEMS trading desk — `/oems/*`
The institutional desk. Real data lives in the **Cockpit** at `/oems` (KPIs, sector heatmap, ZAR yield curve, ALSI intraday, SENS feed, open-orders tape, macro pulse, news, JIBAR/USDZAR). Other top-level surfaces:

| Surface | Page | Purpose |
|---|---|---|
| Cockpit | `/oems` | KPI strip + heatmap + curve + news + orders |
| Blotter | `/oems/blotter` | Order tape + new-order dialog with preflight gate |
| Strategies | `/oems/strategies` | Mandate cards + drift vs target |
| Equities | `/oems/equities` | JSE Top-10 + sector breakdown |
| Fixed income | `/oems/fixed-income` | Bond screener + single-bond detail (DV01/convexity/KRD) |
| Money market | `/oems/money-market` | JIBAR fixings, NCD/T-Bill universe |
| Curves | `/oems/curves` | Govi/swap/real/breakeven overlay + PCA |
| Macro | `/oems/macro` | SARB + StatsSA tiles + surprise chart |
| News | `/oems/news` | News + SENS tape with priority badges |
| Security | `/oems/security` | Watchlist + L2 depth + fundamentals + time-and-sales |
| Analysis | `/oems/analysis/[sym]` | Per-symbol analysis tab |
| Integration | `/oems/integration` | IRESS v4 → OEMS surface map + WSDL/version |
| IRESS migration | `/oems/iress-migration` | Yahoo → IRESS(PROD) cutover console |
| Research | `/oems/research` | Research Library — multi-step New Note wizard |
| Committee | `/oems/committee` | Investment Committee voting surface |
| Rebalance | `/oems/rebalance` | Rebalance builder + IC votes + push-to-market |
| Rhythm | `/oems/rhythm` | Daily operating cadence narrative |
| Models | `/oems/models`, `/oems/models/[id]` | Quant-model registry + Paper account demo |
| Banking (EFT, wallet top-up, reconciliation) | `/oems/(banking)/...` | Ozone wallet top-up surface |

The IRESS-migration console (`/oems/iress-migration`) is the operator-facing accuracy scoreboard for the Yahoo → IRESS(PROD) cutover; per-symbol scores roll into `/api/iress/validation` and `/api/iress/validation/approve`.

### Research Library + Investment Committee
- **Research Library** at `/oems/research` (the new home; legacy `/oems/research-lab` redirects here). Multi-step New Note wizard lives in `wealth-navigator/src/components/research-ic/note-editor.tsx`. Step 1 Target Price field shows a pulsing live-IRESS mark badge with signed upside % vs target via `/api/company-analysis/[sym]` (60s poll, 30s staleTime, IRESS overlay or stored). Review tab (Step 6) renders `Target R{price} · now R{price} · upside {±n%}`.
- **Committee voting** at `/oems/committee` is gated by a fixed **3-member, 2/3 majority** rule:
  - **Lonwabo** (chair), **Juan** (voting), **Lethabo** (voting).
  - Roster + threshold live in `wealth-navigator/src/lib/research-ic/committee.ts:42-57`. Server-side whitelist gate in `wealth-navigator/src/lib/research-ic/committee-gate.ts` reads `committee_member_c` on the **institutional DB** with a soft fallback to the static roster if the table isn't migrated yet.
  - Votes on research notes: `/api/research/notes/[id]/vote`. Votes on rebalance requests: `/api/rebalance/requests/[id]/vote`. Auto-promotes rebalance `pending → ic_approved` when YES ≥ 2.

### Canvas (beta) — `/canvas`
Fynca-inspired multi-persona visual workspace: pan/zoom board with engines, Chatsight Ask/Build, and live presence (`wealth-navigator/src/app/canvas/page.tsx:30-53`). **Real data only** — MiniMax (the M3 model), IRESS, Yahoo; no fake nodes (`AGENTS.md:14`). Reachable directly at `/canvas` or via the Research & IC nav.

### Models — `/oems/models`
Quant-model registry. Models run in local Docker (Lumibot / DuckDB / Yahoo-fed simulators) and push their registry, metrics, equity curve, predictions, positions, and trades into the **institutional `model_*_c` tables**. The flagship is **JSE Alpha / Qentari Bravo JSE**: long-only JSE equity, ~7 concentrated names, weekly rebalance, benchmark `STX40.JO`, ZAR, R500k budget (`AGENTS.md:29`). The external pusher lives outside the repo at `E:\Autonama\Active Projects\Algos\Autonama_Algo\Qentari Models\Qentari_Bravo_JSE\docker-compose-pusher.yml` — flagged as a P1.4 operational risk in `wealth-navigator/docs/MINT_PRODUCTION_READINESS_AUDIT.md:40`.

### Admin / Compliance / Finance / Client book (`/admin/*`)
- `/admin/order-book` — Order book with Active / Closed / Rebalances / STRATE BIR / Cancelled / Manual tabs; `UatBanner` + `UatOrderTicket` for UAT exercise; SSE-fed fill indicators.
- `/admin/clients`, `/admin/investors` — Per-client KYC docs (Sumsub, Experian, signed), holdings, transactions, P&L.
- `/admin/finance` — **Phase C7 finance aggregator**: AUM fees (RETAIL `client_strategy_returns_c` × `strategies_c.payload.fee_pct`) + Day-1 P&L / slip (INSTITUTIONAL `oems_order_audit.result_payload->dayOnePnlCents`). Charts visually separate the two series; explicit "What this view does NOT do" disclaimer (no GL postings, no invoices, no fee waivers, no bank reconciliation).
- `/admin/cyber-compliance` — User activity audit (`cc_audit_log`) + API health + incidents + policy checks.
- `/admin/factsheets`, `/admin/strategies`, `/admin/studio` (magic-link issuance), `/admin/eft` (Ozone EFT), `/admin/mint-mornings`, `/admin/emailers`, `/admin/app-settings`, `/admin/settings`, `/admin/dashboard`, `/admin/team`.

### Wealth Manager / Client book — `/wm`
Reads RETAIL Supabase (profiles, wallets, holdings, KYC, suitability, performance, rebalance proposals).

### Compliance — `/compliance`
Persona-gated placeholder showing pending approvals + audit trail (seed-only today, real data when v1 endpoints ship). The real audit viewer is `/admin/cyber-compliance`.

---

## 4. Business model & fees

Wealth Navigator does not yet surface a customer-facing pricing page. The **money model is institutional AUM fees + Day-1 trading P&L**, aggregated in `/admin/finance` (Phase C7).

- **AUM fees** — RETAIL DB: `strategies_c.payload.fee_pct` × latest `client_strategy_returns_c.basket_value` per (user, strategy). Default fee 1.0%. Implemented in `wealth-navigator/src/app/api/admin/finance/route.ts:99-153`. Read-only aggregator; not the source of truth.
- **Day-1 P&L / slip** — INSTITUTIONAL DB: `oems_order_audit.status IN ('filled','partial')` × `result_payload->dayOnePnlCents`. Implemented in `wealth-navigator/src/app/api/admin/finance/route.ts:187-212`.
- **Broker fees** — IRESS `BookingGetByOrganisation2` is **not yet wired** (`wealth-navigator/docs/IRESS_INTEGRATION_AND_SCALE_SAFETY.md:60`): "P&L is gross — omits transaction costs; no contract notes, no true cost basis."
- **Rebalance residuals** — RETAIL `strategy_rebalance_residuals` per investor per strategy (`TABLES.md:248-257`).
- **Subscriptions** — RETAIL `subscriptions` for recurring fee-based services; surfaced in the consumer retail app, not OEMS (`TABLES.md:260-271`).

**Caveat — broker fill path & settlement remain mock-only.** Per `AGENTS.md:28`: broker fills (`workers/broker-ingest/`, Phase C4) and Ozone wallet top-ups (`/oems/(banking)/wallet-topup`, Phase C6) are blocked on Lonwabo / Tsie confirming the respective vendor contracts. Until those contracts land, no real money moves through the system outside IRESS-side order placement.

---

## 5. Live status & cutover posture

| Item | Status | Source |
|---|---|---|
| Production IRESS account | `43448` | `AGENTS.md:12, 18` |
| UAT / CT IRESS account | `56378` (strictly isolated, no real client money) | `AGENTS.md:10, 12` |
| Production IRESS endpoint | `https://webservices.iress.co.za/v4` | `AGENTS.md:24`; `lib/iress/index.ts:74` defaults |
| UAT / CT endpoint | `https://webservices-ct.iress.co.za/v4` | `AGENTS.md:7` |
| IOS+ server | `MINT` (prod) / `MINT_CT` (UAT) | `lib/iress/index.ts:230` |
| News vendor on prod | `SENSD` (SENS NEWS DELAYED — the only vendor the prod seat is entitled to; real-time `SENS` is NOT entitled) | `AGENTS.md:12, 25` |
| Cutover date | 2026-07-23 | `AGENTS.md:12` |
| Production worker | `Iress-Worker-PROD` on Railway, single replica, public domain `https://iress-worker-production.up.railway.app` | `AGENTS.md:7, 19` |
| Two-server split | Vercel `IRESS_MODE=mock` + `USE_SUPABASE_QUOTES=true` (Path A); Railway worker `IRESS_MODE=live` against prod endpoint (only live seat) | `AGENTS.md:7, 24` |

### What's live vs mock vs pending (per `DATA_PROVENANCE.md` and `REMAINING_GAPS.md`)

- **LIVE today (real IRESS SOAP):** `/api/orders/preflight`, `/api/orders/submit` → worker `/uat/preflight` and `/uat/send-to-market` (UAT path, 2026-07-20). Worker `/orders`, `/orders/stream`, `/health` (Path B BFF passthrough). Worker `/debug/news-vendor-probe` (T5 passthrough on prod worker). Worker `/uat/status`, `/uat/execution-stream` (UAT). Legacy `/api/iress/{health,quotes,session}` from Vercel BFF.
- **WORKING endpoints confirmed live (2026-07-09 Andre probe):** `TimeSeriesGet2` with `DataSource=zax` + `Exchange=jse` (unblocks ALSI/J203, sector heatmap, ZAR curve); `OrderCreate3` (Andre created a test SOL pending order on MINT_CT).
- **HYBRID (live where possible; seed fallback):** 8 surfaces — watchlist / movers prices, security-page intraday chart, ticker bar, equities grid, integration page.
- **SEED today (synthetic UI, blocked on entitlement/vendor):** 28 surfaces — KPIs, ZAR govi curve, ALSI intraday (now WORKING but pending entitlement), SENS feed, news flow, macro pulse, JIBAR/USDZAR KPIs, fixed-income / money-market / curves / macro / strategies pages, depth L2, time-and-sales, fundamentals, persona pages.
- **MOCK (in-process):** Blotter cancel/amend, broker fill pipeline (C4), Ozone wallet top-ups (C6).

### Order lifecycle states
`oems_order_audit.status` now surfaces every IRESS state — not just working/complete. Eleven states: `pending_ack`, `acknowledged`, `working`, `partial`, `filled`, `cancelled`, `cancel_pending`, `expired`, `rejected`, `amend_pending`, `failed` (per `supabase/migrations/20260713000001_oems_order_audit_lifecycle_states.sql`, `…20260714000001_…`, `…20260722000001_…`). Two pseudo-states (`NOT_SENT`, `MIXED`) are added client-side for aggregation.

---

## 6. Three-database Supabase topology

Authoritative source: `wealth-navigator/docs/DB_TOPOLOGY_DECISION.md` (decided 2026-06-13; supersedes `TWO_DB_STRATEGY.md` and `TWO_DATABASE_STRATEGY.md`).

### The three databases
| Role | Project ref | Holds | Writer |
|---|---|---|---|
| **Retail prod** | `mfxnghmuccevsxwcetej` | Customer books (profiles, wallets, holdings, KYC, strategies_c, gifts, loans, funeral) **+ shared price tables** `securities_c` / `stock_intraday_c` | Consumer app + IRESS worker (prices) |
| **Institutional prod** | `nnwzhxfjpjbzujevwzlh` (promoted from the IRESS-test DB) | Desk trading book (`oems_order_audit`, `oems_position_c`, `oems_transaction_c`, `oems_account_c`, bookings, FIX+) **+ desk-only analytics** (curves, indices, sectors, macro, news, bonds, money-market, quant-model tables) | IRESS worker |
| **Staging** | Fresh project (to create) | Schema-mirror of both prods — validate IRESS calls + migrations before they touch prod | IRESS worker (staging mode) |

### Why three, not two
- **Compliance** requires institutional ≠ retail in separate DBs.
- **"Rest of the data from `mfxng…`"** keeps customer data + shared price tables together (compliance cares about *books* — positions, orders, cash, customer PII — not the price feed).
- **IRESS = source of truth**: the worker writes prices into retail prod, and trading book + desk analytics into institutional prod (two service-role clients).
- **Test DB retired** — `nnwz…` promoted from throwaway IRESS-test to institutional prod; fresh staging project takes over validation.
- **No cross-DB mirror** — shared price tables live where the retail app already reads them.

### Env var split
Per `DB_TOPOLOGY_DECISION.md:135-144`:
- `RETAIL_SUPABASE_URL` / `RETAIL_SUPABASE_SERVICE_ROLE_KEY` → `mfxng…`
- `INSTITUTIONAL_SUPABASE_URL` / `INSTITUTIONAL_SUPABASE_SERVICE_ROLE_KEY` → `nnwz…`
- `STAGING_SUPABASE_*` → fresh staging project
- All server-side only — never `NEXT_PUBLIC_*`, never committed.

### Server-side helpers (`wealth-navigator/src/lib/supabase/server.ts`)
- `createRetailServiceRoleClient()` (line 72) — retail prod only.
- `createInstitutionalServiceRoleClient()` (line 82) — institutional prod only.
- `createAuthAdminClient()` (line 130) — matches the project ref of `NEXT_PUBLIC_SUPABASE_URL` to pick the right service-role key for `auth.admin.*` calls. Fixes the 2026-08-04 incident where staff invites were created in the wrong project.
- `createServiceRoleClient()` (line 91) — **deprecated alias → INSTITUTIONAL**.

### Join keys (deferred past OEMS v1)
- Market data ↔ by `symbol`.
- Client ↔ desk by `mint_number` ↔ IRESS `AccountCode` (`DB_TOPOLOGY_DECISION.md:81, 150`).

---

## 7. Key risks & open items

### Active P0 / P1 risks (from `wealth-navigator/docs/MINT_PRODUCTION_READINESS_AUDIT.md`)
- **P0.1** — Anon key can read/write `wallets`, `truid_bank_snapshots`, `credit_transactions_history`, KYC tables (28 RLS-disabled tables on retail). Public key ships to client.
- **P0.2** — A live retail `service_role` JWT is committed in `docs/TWO_DATABASE_STRATEGY.md:278`. **Must be rotated + scrubbed** from `MINT-DEVELOPMENT`.
- **P0.3** — MINT crons unauthenticated + service-role + open CORS (`api/prices/eod-save`, `api/gift/expire`, `api/aum-fee/run`). Add `Authorization: Bearer ${CRON_SECRET}`.
- **P1.15** — OEMS order stack not ready for real money: no production order path (rebalance push is 501 `deferred`), per-client guard dormant, MKT-only, no client attribution to broker, `SEND_TO_MARKET` kill-switch incomplete (two routes bypass it), worker `OrderCreate3` ignores dry-run gates, `56378` referenced in prod paths.
- **P1.4** — External Qentari pusher is unversioned / off-repo / on a separate Windows host. Bring under ops control before cutover.

### Functional gaps called out in the runbooks
- **No fills → `stock_holdings_c` bridge** — broker fill price/qty never corrects the client's held quantity or cost basis. "Biggest functional gap for a retail OEMS" (`wealth-navigator/docs/IRESS_INTEGRATION_AND_SCALE_SAFETY.md:97`).
- **`avgPx` unit ambiguity** — UAT poller stores `avgPx` in Rands but `derivePositions` treats it as cents and divides by 100. If a Rands value reaches `derivePositions`, `open_average_price` is ~100× off. **Pin the SOAP unit of `Order.avgPx` before trusting positions** (`wealth-navigator/docs/IRESS_INTEGRATION_AND_SCALE_SAFETY.md:98`).
- **Client attribution gap** — every order hard-forced to MKT with no price/limit; no per-client reference reaches the broker; `SEND_TO_MARKET` kill-switch incomplete (two routes bypass it); blotter submit lacks admin RBAC; worker `OrderCreate3` ignores `IRESS_WORKER_DRY_RUN` / `SUPABASE_ALLOW_WRITES` — the assumed dry-run does not stop live orders. Add an explicit `IRESS_ORDER_EXECUTION_ENABLED` gate.
- **Quote row-shape variance** — NPN sends bare `<Last>`; AGL/FSR/MTN/SBK/BHG send `LastPrice`/`PreviousClosePrice` integer cents; worker `mapQuote` / `resolveQuoteLast` validates `Last` against `Close` anchor and **skips writes** when only stale `LastPrice` is present (BHG pattern).
- **Single license seat** — only the Railway worker may hold the IRESS license; never open competing live IRESS sessions from Vercel, local, or retail app (`AGENTS.md:13`).
- **Graceful deploys** — single replica + 3s license release window; 2-replica drain is **NOT safe** today (25008 collision); if zero-downtime needed, design needs license pooling or Redis Stream handoff (`wealth-navigator/docs/GO_LIVE_RUNBOOK.md:386-389`).
- **Rebalance push returns HTTP 501** — `POST /api/rebalance/requests/[id]/push` is disabled since 2026-07-27. Comment at lines 97-123 explains: would emit unattributable orders (strategy name in place of client, no user_id, no dispatcher). The real basket path is `POST /api/admin/orderbook/send-to-market`.

### 100% real target
From `REMAINING_GAPS.md:53-64`:
- **Now** — Quotes for 10-symbol watchlist (Done — Railway worker LIVE + Supabase).
- **Week 1** — Orders in audit, worker health visible (Done UI; worker writes need `SUPABASE_ALLOW_WRITES=1` + account code from Charles).
- **Week 2** — Index + FX + JIBAR on worker watchlist (2-3 days eng, IRESS symbol entitlement).
- **Week 3** — Sector indices + ALSI intraday (3-5 days eng, `TimeSeriesGet2` entitlement — now WORKING).
- **Week 4+** — SENS (now wired on prod worker 2026-07-22, vendor catalog + universe tagging in place, per-loop pilot-write gate ready), news, macro (vendor selection + contract).
- **Week 6+** — AUM/P&L, personas, fundamentals (portfolio system integration).

**100% real across every panel** is unlikely before **8-12 weeks** without parallel vendor onboarding. **Quotes + orders + worker health** can be production-honest within **1-2 weeks** once the Railway worker runs LIVE writes and Charles confirms the BHG / sector entitlements.

---

## 8. Glossary

### MINT-specific
- **OEM** — Office of the Executor / Investment Manager. The institutional trading-desk business line. **OEM calculation convention** (`AGENTS.md`): strategy value, basket construction, P&L, AUM fee, rebalance calculations must be **server-side only** — front-end calculation is explicitly banned and treated as a bug. Lonwabo Damane owns the OEM basket/strategy/rebalance data flows.
- **OEMS** — Order & Execution Management System. The institutional trading-desk product surface (`/oems`).
- **Mint OEM Finalisation Plan** — phased workplan with stages C1-C7:
  - **C1 / C2** — vendor feeds (IRESS + macro), pre-trade compliance.
  - **C4** — broker fill feed (`workers/broker-ingest/`, currently MOCK ONLY).
  - **C5** — order book surfaces (`/admin/order-book`).
  - **C6** — Ozone wallet top-ups (`/oems/(banking)/wallet-topup`).
  - **C7** — Finance tab (`/admin/finance`).

### IRESS / market infrastructure
- **IRESS** — JSE member-firm trading network; vendor for the South African trading stack. Integration is the technical centerpiece of Wealth Navigator.
- **IRESS V4 Web Services** — SOAP API surface at `https://webservices.iress.co.za/v4` (prod) / `https://webservices-ct.iress.co.za/v4` (UAT/CT). Reference docs at `Documentation & Vision/iress-v4-docs/` and the programmers guide PDF.
- **IOS+ / IOSPlus** — IRESS Order Service Plus. Handles Orders / Users / Accounts / Limits. Server name `MINT` on prod.
- **IPS** — IRESS Portfolio Service. Handles accounts, positions, transactions. Methods: `IPSAccountGetAll1`, `IPSPositionGetAll1`, `IPSTransactionGetByAccount5`.
- **FIX+** — IRESS FIX+ drop-copy TCP connection. Methods: `TargetIDGet`, `TargetIDStatusGet`. Modeled but not connected in v2.
- **ApplicationID** — IRESS session-recovery key. Same `(UserName + CompanyName + ApplicationID)` triple recovers the session. Pattern: `Mint-OEMS-<Env>-<Node>-<GUID>`. Persisted in `worker_session_metadata` on the institutional DB.
- **OrderTag** — UUID the OEMS mints per `OrderCreate3` — **idempotency**. Worker always sends one; transport-level failures recover via `OrderNoGetByOrderTag`.
- **25008** — IRESS SOAP fault code for "no licenses" (single-seat contention). Worker auto-kicks first-boot 25008 when `worker_session_metadata` has no `iress_session_key`. Manual recovery via `bun run iress:logout` or `IRESS_FORCE_KICK_ALL=1`.
- **LICENSE_RELEASE_DELAY_MS = 3000** — wait between `IRESSSessionEnd` and the seat being released.

### Market instruments / data
- **JSE** — Johannesburg Stock Exchange.
- **STX40** — JSE Top 40 index. The benchmark for the JSE Alpha paper model.
- **ALSI / J203** — JSE All Share Index; intraday series via `TimeSeriesGet2` with `DataSource=zax`, `Exchange=jse` (now WORKING).
- **NPN** — Naspers Ltd. Anchor watchlist symbol.
- **FSR / AGL / BHG / MTN / SBK / SOL / SHP / CPI / PRX** — Top-40 JSE symbols.
- **ZAR** — South African Rand. Base currency; `wallets.balance` in Rands, `securities_c.last_price` in cents.
- **JIBAR** — Johannesburg Interbank Average Rate; `JIBAR_3M` in the worker watchlist.
- **NSS curve** — Nelson-Siegel-Svensson fitted yield curve (govt bonds).
- **DV01 / convexity / KRD** — bond risk metrics.
- **NCD / T-Bill** — Negotiable Certificate of Deposit / Treasury Bill.
- **Govi** — South African government bond (R-series). Sovereign curve `R2030`, `R2035`, `R2040`, etc.
- **ILB** — Inflation-Linked Bond (real return bond).

### News / regulatory
- **SENS** — Stock Exchange News Service (real-time regulatory announcements).
- **SENSD** — SENS NEWS DELAYED. **The only vendor the prod market-data seat is entitled to** (`AGENTS.md:12`). Real-time `SENS` is NOT entitled.
- **Moneyweb / BusinessTech / Reuters / Bloomberg / Dow Jones / Business Day** — alternate RSS / vendor news sources.
- **SARB / StatsSA** — South African Reserve Bank / Statistics South Africa.

### Application architecture
- **BFF** — Backend-for-Frontend. Vercel-hosted Next.js API surface (`src/app/api/`).
- **BFF paths** — **Path A** (Worker → Supabase → BFF) for snapshots/audit (`/api/quotes`, `/api/orders`, `/api/worker-health`); **Path B** (Worker → Vercel passthrough) for live/ephemeral (`/api/orders/live`, `/api/orders/stream`, `/api/integration/health`) gated by `IRESS_WORKER_URL` + `WORKER_HTTP_TOKEN`.
- **Worker / Railway iress-ingest** — persistent process that owns the IRESS license seat, syncs quotes to Supabase, mirrors orders into `oems_order_audit`. Public domain `https://iress-worker-production.up.railway.app`.
- **Vercel** — frontend + BFF host. `IRESS_MODE=mock` + `USE_SUPABASE_QUOTES=true` production posture.
- **Supabase** — auth + DB + Realtime. Three-DB topology.
- **Realtime** — Supabase Realtime subscriptions on `stock_intraday_c` for sub-second tick fan-out.
- **Service-role client** — bypasses RLS; worker + cron use only.

### Money / accounting
- **P&L** — Profit and Loss. `client_strategy_returns_c` (RETAIL) and `oems_order_audit.result_payload->dayOnePnlCents` (INSTITUTIONAL).
- **AUM** — Assets Under Management. Used for retail AUM fees.
- **Fee / fee_pct / management_fee_pct** — strategy fee percent. Default 1.0.
- **MiscFees** — brokerage/STT/VAT/settlement fees (IRESS `BookingGetByOrganisation2` — not yet wired).
- **STRATE** — South African settlement / clearing house; not integrated yet.
- **Settlement** — T+3 trade settlement (STRATE). Out of scope for OEMS v1.
- **Rebalance** — rebalancing of strategy weights.
- **Mandate** — discretionary mandate (signed by client). PDFs via `/lib/pdf/mandate.ts`; `signed-agreements` bucket in Supabase Storage.
- **Paper model** — a quant model running in simulation (e.g. JSE Alpha / Qentari Bravo).
- **Committee gate** — server-side whitelist check on `committee_member_c`. 3 fixed members, 2/3 majority threshold.
- **UAT** — User Acceptance Testing. Runs against MINT_CT IOSPlus UAT account `56378` only.
- **STRATE BIR** — STRATE Beneficial Identification Reconciliation; tab in `/admin/order-book`.

### Data conventions
- **Prices in cents** — `securities_c.last_price`, `stock_holdings_c.avg_fill`, `transactions.amount`, `gift_claims.amount`, `family_members.available_balance` are all in **cents**.
- **Wallet balance in Rands** — `wallets.balance` stored in **Rands**.
- **`_c` suffix tables** — populated by external pipelines or by the worker, not by direct user actions.
- **Cents vs Rands** — money math must be done in **cents** server-side, divided to Rands at the rendering edge.

### Data tiering T0-T6 (per `AGENTS.md:22`)
- **T0** — reference/master (`securities_c`).
- **T1** — authoritative snapshots (`stock_intraday_c` worker upsert + Realtime push).
- **T2** — display-only ticks (ephemeral SSE; do not persist).
- **T3** — orders/audit (`oems_order_audit`).
- **T4** — books/P&L.
- **T5** — vendor content (SENS/news/macro — seed until contracted).
- **T6** — synthetic/demo (PCA, fake depth).

### Source / data-mode badges
- **LIVE** — Data from IRESS CT/prod SOAP.
- **SUPABASE** — Worker snapshot in `stock_intraday_c`.
- **HYBRID** — Live where possible; seed/sim fallback.
- **SEED** — Static seed or synthetic generation.
- **MOCK** — In-process mock adapter.
- **T5_PASSTHROUGH** — T5 vendor content; worker reads on demand via Path B; nothing persisted until vendor contract.
- **PENDING** — No V4 method identified.

### Auth / persona-specific
- **Mint Mornings** — daily newsletter.
- **Resend** — transactional email provider for gift confirmations, fills, etc.
- **Sumsub / TruID** — KYC and bank-linking providers used by the retail consumer app (out of Wealth Navigator scope).
- **Ozone** — payment provider for EFT top-ups (`/oems/(banking)/wallet-topup` → `/api/admin/eft/ozone-topup`); **C6 MOCK ONLY** until Tsie confirms vendor.
- **Longmog / Longmark Care** — broker venues referenced in UAT test orders.

---

## 9. Technical appendix (for engineering)

### Stack
- **Next.js 16** + **React 19** + **Bun** runtime + **TypeScript strict** + **Tailwind** + **shadcn/ui**. `wealth-navigator/package.json`.
- **Vercel** hosts the BFF (`wealth-navigator-one.vercel.app`, project `autonama-group/wealth-navigator`, Root Directory `wealth-navigator`).
- **Railway** hosts `Iress-Worker-PROD` (`workers/iress-ingest/`), single replica, public domain `https://iress-worker-production.up.railway.app`.
- **Supabase** three-DB topology (retail `mfxng…`, institutional `nnwz…`, staging TBD).
- **IRESS V4 Web Services** is the upstream source of truth.

### Branch strategy
All code changes go on `MINT-DEVELOPMENT`; never edit `MINT-LIVE` directly (dev team syncs DEV → LIVE; live edits get reverted or conflict) — root `AGENTS.md:1-8`.

### Architectural decisions
- **Path A vs Path B** — DB-first via Supabase vs worker passthrough.
- **IRESS single-seat** — only the Railway worker holds the prod license.
- **Sticky ApplicationID** — persisted in `worker_session_metadata` keyed by `worker_id` to make restarts safe.
- **Investment Committee** — fixed 3 members, 2/3 majority, server-side gate cannot be bypassed.
- **OEM calculations** — server-side only. Front-end calculation is explicitly banned.

### Repo hygiene
- `.gitignore` excludes secrets; `supabase_creds` directory is gitignored.
- `vercel-project-patch.json` at repo root holds Vercel deploy patches.
- `TABLES.md` is the canonical RETAIL schema reference.
- `PLANNING.md` is the canonical OEMS surface map + persona plan.
- `commit_msg.txt` is the git history context.

### Open gaps summary
- Rebalance `push` returns 501 (use `POST /api/admin/orderbook/send-to-market` instead).
- Research Lab thesis add/remove is session-only (no DB persistence).
- Investment Committee voting UI not yet shipped to all personas.
- IC voting affordance — surface a "you have a pending vote" widget on `/oems` for the 3 committee members when a `research_note_c.status = 'ic_pending'` row exists.
- `oems_strategy_c` institutional rollup table is empty (still reading RETAIL `strategies_c`).
- Per-user `page_access` RBAC wiring still in flight.
- Materiality baseline in `src/lib/research-ai/cache.ts:23-32` is frozen at cache generation (by design).

---

*This summary is the entry point for any new joiner. Read it end-to-end, then drill into the doc that matches your role (architecture → Doc 2, OEMS desk → Doc 3, IRESS → Doc 4, worker → Doc 5, Research Lab → Doc 6, Canvas → Doc 7, Models → Doc 8, API surface → Doc 9, risk/compliance → Doc 10, deployment → Doc 11).*
