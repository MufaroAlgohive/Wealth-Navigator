# Wealth Navigator — Risk, Compliance, Audit, Operational Posture

**Audience:** compliance, audit, CEO, on-call, new joiners.
**Last reviewed:** 2026-08-15.
**Source of truth:** `wealth-navigator/docs/MINT_PRODUCTION_READINESS_AUDIT.md`, `wealth-navigator/docs/IRESS_INTEGRATION_AND_SCALE_SAFETY.md`, `wealth-navigator/docs/ISSUES_LOG.md`, `wealth-navigator/docs/BROKER_INTEGRATION.md`, `wealth-navigator/docs/OZONE_INTEGRATION.md`, `wealth-navigator/docs/VENDOR_ENTITLEMENT_STATUS.md`, `wealth-navigator/src/lib/admin/rbac.ts`, `wealth-navigator/src/components/admin/cyber-compliance/`, `wealth-navigator/src/lib/bff-reasons.ts`.

> **Correction vs older handoffs:** `/oems/compliance` does **not** exist as a route — the real surface is `/compliance` (placeholder) + `/admin/cyber-compliance` (audit viewer). `/oems/admin/*` does **not** exist as a route group — the real admin paths are top-level `/admin/*`. 5 active P0/P1 risks including a leaked service-role JWT.

---

## 1. Active risk register (P0/P1)

Per `wealth-navigator/docs/MINT_PRODUCTION_READINESS_AUDIT.md`:

### P0.1 — RLS disabled on 28 retail tables
- The anon key can read/write `wallets`, `truid_bank_snapshots`, `credit_transactions_history`, KYC tables.
- 28 RLS-disabled tables on the retail DB.
- Public anon key ships to client.
- **Action:** Enable RLS on every table; verify with `SELECT * FROM pg_tables WHERE rowsecurity = false AND schemaname = 'public';`.

### P0.2 — Live retail `service_role` JWT in `docs/TWO_DATABASE_STRATEGY.md:278`
- A live retail `service_role` JWT is committed in the docs.
- **Action:** Rotate the key in Supabase → Project Settings → API → `service_role` secret; purge from `docs/TWO_DATABASE_STRATEGY.md`; replace with `<REDACTED>` placeholder.

### P0.3 — MINT crons unauthenticated + service-role + open CORS
- `api/prices/eod-save`, `api/gift/expire`, `api/aum-fee/run` — all use service-role and have open CORS.
- **Action:** Add `Authorization: Bearer ${CRON_SECRET}` to every cron route; add CORS allowlist.

### P1.15 — OEMS order stack not ready for real money
- No production order path (rebalance push is 501 `deferred`).
- Per-client guard dormant (`IRESS_PER_CLIENT_GUARD=0` default).
- MKT-only (no price/limit).
- No client attribution to broker.
- `SEND_TO_MARKET` kill-switch incomplete (two routes bypass it).
- Worker `OrderCreate3` ignores `IRESS_WORKER_DRY_RUN` / `SUPABASE_ALLOW_WRITES` — assumed dry-run does not stop live orders.
- `56378` (UAT) referenced in prod paths.
- **Action:** Add `IRESS_ORDER_EXECUTION_ENABLED` flag; force `IRESS_PRODUCTION_ORDERS=1` + `IRESS_PER_CLIENT_GUARD=1` + `IRESS_ACCOUNT_CODE=43448` for production; verify readiness gate.

### P1.4 — External Qentari pusher unversioned / off-repo / on separate Windows host
- Located at `E:\Autonama\Active Projects\Algos\Autonama_Algo\Qentari Models\Qentari_Bravo_JSE\docker-compose-pusher.yml`.
- Not under version control.
- **Action:** Move into `wealth-navigator/workers/qentari-bravo/` or similar; deploy as a sibling Railway worker.

### P1.4.b — `WORKER_HTTP_TOKEN` literal in `ISSUES_LOG.md:0.5.4.a`
- The literal token value is checked into the doc.
- **Action:** Rotate the token in both Railway and Vercel env vars; purge from the doc.

### P1.4.c — 9 unpushed commits on `main`
- `ISSUES_LOG.md:2.1`.
- **Action:** Push to remote before next redeploy.

### P1.4.d — Stale HTML runbook
- `MINT_GO_LIVE_RUNBOOK.html` is stale; `GO_LIVE_RUNBOOK.md` is authoritative.
- **Action:** Remove the HTML; link to the markdown.

---

## 2. RBAC matrix

### Server-side roles
| Role | Source | Scope |
|---|---|---|
| Anonymous | `auth.role = "anon"` | Public auth routes, cron routes (with CRON_SECRET) |
| Authenticated user | `auth.role = "authenticated"` | `/api/wm/*`, `/api/canvas/layout`, `/api/portfolio/[own]`, `/api/orders/[own]` |
| OEMS operator | `admin_team.role = "oems"` | `/api/orders/*`, `/api/portfolio/*`, `/api/strategies/*`, `/api/rebalance/*`, `/api/research/*`, `/api/models/*`, `/api/integration/*` |
| IC member | `committee_member_c` on institutional | `/api/research/notes/[id]/vote`, `/api/rebalance/requests/[id]/vote` |
| Admin | `admin_team.role = "admin"` | `/api/admin/*`, `/api/auth/admin/*`, `/api/admin/orderbook/send-to-market` |
| Worker | Path B bearer (`WORKER_HTTP_TOKEN`) | All Path B worker endpoints |

### `requireRole(role)` (`wealth-navigator/src/lib/admin/rbac.ts`)
- Server-side role check.
- Reads `admin_team` on retail DB (single source of truth).
- Returns 403 if role mismatch.

### `requireAdmin()`
- Admin-only check.
- Same pattern.

### Per-user `page_access` RBAC
- Per-user page-level access (still in flight).
- Stop-gap `visibleFor()` in `wealth-navigator/src/lib/platform/nav.ts:160-165`.
- Full RBAC pending.

---

## 3. Audit log (`cc_audit_log`)

### Table
- Institutional DB.
- Schema: `id, user_id, action, target, payload, ts`.
- Inserted by every admin action, IC vote, rebalance, order.

### Viewer
- `/admin/cyber-compliance` — user activity audit + API health + incidents + policy checks.
- `/api/admin/audit` — server-side list.

### Retention
- Default: indefinite.
- TODO: add retention policy + export for FSCA.

---

## 4. Compliance surface

### `/compliance`
- Persona-gated placeholder.
- Shows pending approvals + audit trail (seed-only today).
- Real audit viewer is `/admin/cyber-compliance`.

### `/admin/cyber-compliance`
- Real audit surface.
- User activity audit (`cc_audit_log`).
- API health (calls `/api/integration/health` + `/api/worker-health`).
- Incidents (manual entries + auto-derived from health).
- Policy checks (RBA + RLS + cron auth + secrets rotation).

### NCR compliance (consumer app, out of scope here)
- LendingEngine math and loan application wizard are NCR-compliant.
- "4-Day Salary Rule" enforced.
- Out of scope for Wealth Navigator; documented in `MINT-DEVELOPMENT`.

---

## 5. Persona-gated surfaces

### Real persona routes
- `/oems` (OEMS operator).
- `/admin/*` (admin).
- `/wm/*` (wealth manager).
- `/compliance` (placeholder).
- `/strategist` (placeholder).
- `/business` (placeholder).
- `/fc/*` (placeholder).
- `/canvas` (multi-persona).

### Persona real-data gate
- `wealth-navigator/src/components/oems/persona-real-data-gate.tsx:22-49`.
- Renders `<EmptyDataState>` when real-data-only mode is on.
- Does NOT route the persona to other views.

---

## 6. Investment Committee governance

### Membership
- 3 fixed members: Lonwabo (chair), Juan (voting), Lethabo (voting).
- Roster + threshold in `wealth-navigator/src/lib/research-ic/committee.ts`.
- Server-side gate in `wealth-navigator/src/lib/research-ic/committee-gate.ts`.
- Soft fallback to static roster if `committee_member_c` not migrated.

### Threshold
- 2/3 majority (≥ 2 yes of 3).

### Audit trail
- Every vote → `research_vote_c` or `rebalance_vote_c` row.
- `cc_audit_log` row for the vote action.
- No replacement vote overwrites silently.

---

## 7. Operational posture

### Single license seat
- Only the Railway `Iress-Worker-PROD` holds the prod license.
- Vercel (`IRESS_MODE=mock`) never opens a live IRESS session.
- Local dev: `IRESS_MODE=mock` (no live).
- 25008 fault: auto-kick + retry, `IRESS_FORCE_KICK_ALL`, `IRESS_FORCE_ORPHAN_CLEAR`.

### Single replica
- Multi-replica drains = 25008 collision.
- License pooling or Redis Stream handoff needed for zero-downtime redeploys.

### Three-layer safety gates
1. **Worker-wide**: `IRESS_WORKER_DRY_RUN` + `SUPABASE_ALLOW_WRITES`.
2. **Per-loop**: news (`IRESS_NEWS_*`), retail (`IRESS_RETAIL_DRY_RUN`).
3. **Explicit opt-ins for client money**: `IRESS_PRODUCTION_ORDERS=1`, `RETAIL_SETTLEMENT_ENABLED=1`, `IRESS_PER_CLIENT_GUARD=1`.

### Operational dashboards
- `/oems/integration` — endpoint health + IRESS v4 → OEMS surface map.
- `/oems/iress-migration` — Yahoo → IRESS(PROD) cutover console.
- `/admin/finance` — AUM fees + Day-1 P&L.
- `/admin/cyber-compliance` — audit + API health.

### Honest empty states
- Every BFF returns a `source` field (data tier).
- `EmptyDataState` renders the right migration / entitlement copy.
- Data-source badge surfaces the tier at a glance.

---

## 8. Data tier classification (T0-T6)

Per root `AGENTS.md:22`:
- **T0** — reference/master (`securities_c`).
- **T1** — authoritative snapshots (`stock_intraday_c` worker upsert + Realtime push).
- **T2** — display-only ticks (ephemeral SSE; do not persist).
- **T3** — orders/audit (`oems_order_audit`).
- **T4** — books/P&L.
- **T5** — vendor content (SENS/news/macro — seed until contracted).
- **T6** — synthetic/demo (PCA, fake depth).

### Data-source badge taxonomy (16 kinds)
`live | iress | yahoo | external | mock | seed | hybrid | supabase | stream | worker | uat | unconfigured | unavailable | blocked-external | blocked-vendor | code-gap`

`mapSource()` normalises free-form BFF `source` strings.

---

## 9. Operational issues log (`docs/ISSUES_LOG.md`)

### Post-cutover operating reality
- `0.5.4.a` — `WORKER_HTTP_TOKEN` literal checked into the doc; needs rotation.
- `0.5.4.b` — Railway GitHub app integration missing initially.
- `0.5.4.c` — 9 unpushed commits on `main`.
- `0.5.4.d` — Stale HTML runbook.
- `0.5.4.e` — Identified existing `mfxng…stock_intraday_c` writer before flipping worker.
- `0.5.4.f` — Worker default cadence 15s; drop to 5s on production only after verifying Vercel cost.

### Onboarding gaps
- No GitHub Actions workflows exist (CI gap).
- No pre-commit hooks.
- No structured onboarding doc — `GO_LIVE_RUNBOOK.md` is the closest.

---

## 10. Secret hygiene

### What must NOT be in the repo
- IRESS `IRESS_PASSWORD` / `IRESS_USERNAME`.
- Supabase `service_role` JWT.
- Railway `rlwy_oaci_*` / `rlwy_oacs_*` (OAuth client IDs/secrets).
- ClickUp `pk_*` tokens.
- Stripe / OAuth / broker / payment-provider secrets.
- `NEXT_PUBLIC_*` secrets.

### What must NOT be in chat (per root `AGENTS.md`)
- Any plaintext API tokens.
- The user-provided `pk_228227801_*` ClickUp token from 13 Aug 2026 — must be rotated.

### Storage
- OS keychain or password manager.
- Vercel env vars (server-side only, never `NEXT_PUBLIC_*`).
- Railway env vars.

### `supabase_creds/`
- Gitignored.
- Local service-role keys for dev only.

---

## 11. Production-order readiness gate

Per `wealth-navigator/docs/IRESS_INTEGRATION_AND_SCALE_SAFETY.md` and `wealth-navigator/workers/iress-ingest/src/production-readiness.ts`:

### Five blockers
1. `IRESS_PER_CLIENT_GUARD=0`
2. `IRESS_PRODUCTION_ORDERS=0`
3. `IRESS_ACCOUNT_CODE` resolves to UAT code
4. `IRESS_BASE_URL` points to UAT
5. `IRESS_WORKER_DRY_RUN=true`

### Sanity signal only
- The gate is a sanity signal; it does NOT hard-block live orders without `IRESS_ORDER_EXECUTION_ENABLED`.
- **Add explicit `IRESS_ORDER_EXECUTION_ENABLED` flag** (P1.15.5).

### Pre-prod checklist
- `IRESS_PRODUCTION_ORDERS=1`
- `IRESS_PER_CLIENT_GUARD=1`
- `IRESS_ACCOUNT_CODE=43448`
- `IRESS_BASE_URL=https://webservices.iress.co.za/v4`
- `IRESS_WORKER_DRY_RUN=false`
- `SUPABASE_ALLOW_WRITES=1`
- `RETAIL_SETTLEMENT_ENABLED=1` (only when ready to move client money)
- `IRESS_NEWS_ALLOW_WRITES=1` (only when ready to write news)
- `IRESS_RETAIL_INGEST=1` (only when ready to ingest retail prices)
- `IRESS_ORDER_EXECUTION_ENABLED=1` (once added)

---

## 12. Vendor entitlements

### Working
- `PricingQuoteGet` (12-symbol default).
- `TimeSeriesGet2(zax, jse)` for J203.
- `OrderPadGetByAccount`.
- `OrderCreate3`.
- `OrderCancel2`.
- `OrderAmend2`.
- `NewsHeadlineGet(SENSD)` (UAT only).

### Pending entitlement
- Sector codes (Tech, Financials, Industrials, Consumer).
- R-codes (R2030, R2035, R2040).
- Real-rate codes.
- NewsHeadlineGet (SENS prod).
- Macro indicators.
- Fundamentals.
- Money-market symbols.

### No V4 method identified
- L2 depth (`OrderBookGet`).
- Time-and-sales.
- Real-time SENS.

---

## 13. Open gaps summary

### Security
- **P0.1** — RLS disabled on 28 retail tables.
- **P0.2** — Live retail `service_role` JWT in docs.
- **P0.3** — MINT crons unauthenticated + service-role + open CORS.

### Operational
- **P1.4** — External Qentari pusher off-repo.
- **P1.4.b** — `WORKER_HTTP_TOKEN` literal in doc.
- **P1.4.c** — 9 unpushed commits on main.
- **P1.4.d** — Stale HTML runbook.

### Order stack
- **P1.15** — OEMS order stack not ready for real money.
- No `IRESS_ORDER_EXECUTION_ENABLED` flag.
- Per-client guard dormant.
- `SEND_TO_MARKET` kill-switch incomplete (two routes bypass).
- Worker `OrderCreate3` ignores dry-run gates.

### Functional
- No fills → `stock_holdings_c` bridge.
- Broker fees not wired.
- `avgPx` unit ambiguity.
- Client attribution gap.
- Rebalance push returns 501.

### Membership + governance
- Per-user `page_access` RBAC wiring still in flight.
- No audit log for IC vote changes (replace votes silently).
- No notification when a vote reaches threshold.
- No dead-man's switch for IC voting.

### Vendor entitlement
- Sector codes, R-codes, real-rate codes.
- NewsHeadlineGet (SENS prod).
- Macro indicators, fundamentals, money-market symbols.

### Method gaps
- L2 depth.
- Time-and-sales.
- Real-time SENS.

---

*This doc is the risk/compliance/audit posture. Pair with Doc 9 (API surface) for the BFF contracts, Doc 11 (deployment) for the cutover playbook, and root `AGENTS.md` for the workspace-wide secret hygiene rules.*
