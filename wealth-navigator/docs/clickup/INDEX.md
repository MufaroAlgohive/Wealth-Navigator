# Wealth Navigator — Documentation Set (INDEX)

**Audience:** CEO, new joiners, developers, stakeholders.
**Last reviewed:** 2026-08-15.
**ClickUp document:** [Wealth Navigator Docs](https://app.clickup.com/90152666892/v/dc/2kyr91rc-1935)
**Workspace:** `90152666892` · Space: `901511714420` "MINT DEVELOPEMENT" · List: `901524962273` "MINT APP"

This is the **parent page** for the 11-document Wealth Navigator documentation set. Each document below is a child page in the same ClickUp document.

---

## Document index

| # | Title | Audience | Source |
|---|---|---|---|
| 1 | [CEO Executive Summary + Product Vision](./01-CEO-Executive-Summary.md) | CEO, new joiners, stakeholders | `Wealth Navigator/PLANNING.md`, `AGENTS.md`, `TABLES.md`, `wealth-navigator/docs/STACK_ARCHITECTURE.md`, `DB_TOPOLOGY_DECISION.md`, `DATA_PROVENANCE.md`, `REMAINING_GAPS.md`, `GO_LIVE_RUNBOOK.md` |
| 2 | [Architecture, Stack & 3-DB Supabase Topology](./02-Architecture-Stack-DB-Topology.md) | developers, infra | `wealth-navigator/docs/STACK_ARCHITECTURE.md`, `DB_TOPOLOGY_DECISION.md`, `DATA_PROVENANCE.md`, `CLOUD_DEPLOYMENT.md`, `ENV_MIGRATION.md`, `package.json`, `src/lib/supabase/server.ts`, `src/lib/iress/index.ts` |
| 3 | [OEMS Trading Desk — pages, components, data flows](./03-OEMS-Trading-Desk.md) | developers, new joiners, ops | `src/app/oems/`, `src/components/oems/`, `src/lib/oems/`, `src/lib/data-policy.ts`, `src/lib/data-source.ts`, `docs/DATA_PROVENANCE.md`, `PLANNING.md` |
| 4 | [IRESS V4 Integration & Order Lifecycle](./04-IRESS-V4-Integration.md) | developers, ops, on-call | `src/lib/iress/`, `docs/IRESS_INTEGRATION_AND_SCALE_SAFETY.md`, `docs/IRESS_PRICE_SCALE_INCIDENT_HANDOFF.md`, `docs/SENS_NEWSHEADLINE_WIRE.md`, `docs/UAT_ORDER_PIPELINE.md`, `docs/VENDOR_ENTITLEMENT_STATUS.md` |
| 5 | [Railway IRESS Worker (workers/iress-ingest)](./05-Railway-IRESS-Worker.md) | devs, on-call, ops | `wealth-navigator/workers/iress-ingest/`, `docs/GO_LIVE_RUNBOOK.md`, `docs/UAT_ORDER_PIPELINE.md`, `docs/SENS_NEWSHEADLINE_WIRE.md`, `docs/IRESS_INTEGRATION_AND_SCALE_SAFETY.md`, `docs/ISSUES_LOG.md` |
| 6 | [Research Lab + Research Library + Investment Committee](./06-Research-Lab-IC.md) | developers, new joiners, IC members, ops | `src/app/oems/research/`, `src/components/research-ic/`, `src/lib/research-ic/`, `src/lib/research-lab/`, `src/app/api/research/`, `src/app/api/rebalance/`, `docs/README_ic_committee.md`, `supabase/seeds/ic_committee_*.sql` |
| 7 | [Canvas (beta) — Fynca-style multi-persona workspace](./07-Canvas-Beta.md) | developers, new joiners, designers, stakeholders | `src/app/canvas/`, `src/components/canvas/`, `src/lib/canvas/`, `src/components/chatsight/` |
| 8 | [Models — JSE Alpha (Qentari Bravo), paper trading, benchmarks](./08-Models-Qentari-Bravo.md) | developers, quants, IC members, stakeholders | `src/app/oems/models/`, `src/components/oems/primitives/live-model-dashboard.tsx`, `src/lib/data-source.ts`, `src/lib/hooks/use-audit-orders.ts`, `supabase/migrations/20260712000001_model_tracking_c.sql` |
| 9 | [API Surface — every /api route, contract, auth](./09-API-Surface.md) | developers, on-call, integrators | `src/app/api/`, `src/lib/auth/`, `src/lib/admin/rbac.ts`, `src/lib/orders/preflight.ts`, `src/lib/rebalance/`, `src/lib/research-ic/`, `src/lib/supabase/server.ts`, `src/lib/data-policy.ts`, `src/lib/bff-reasons.ts` |
| 10 | [Risk, Compliance, Audit, Operational Posture](./10-Risk-Compliance-Audit.md) | compliance, audit, CEO, on-call, new joiners | `docs/MINT_PRODUCTION_READINESS_AUDIT.md`, `docs/IRESS_INTEGRATION_AND_SCALE_SAFETY.md`, `docs/ISSUES_LOG.md`, `docs/BROKER_INTEGRATION.md`, `docs/OZONE_INTEGRATION.md`, `docs/VENDOR_ENTITLEMENT_STATUS.md` |
| 11 | [Deployment, Cutover Runbook, Env Vars, CI/CD](./11-Deployment-Cutover-Runbook.md) | devs, on-call, ops, new joiners, CEO | `docs/GO_LIVE_RUNBOOK.md` (authoritative), `docs/VERCEL_DEPLOY_SETUP.md`, `docs/CLOUD_DEPLOYMENT.md`, `docs/ENV_MIGRATION.md`, `docs/PHASE1_IRESS_RETAIL_CUTOVER.md`, `docs/ISSUES_LOG.md`, `vercel.json`, `.vercel/project.json`, `workers/iress-ingest/Dockerfile` |

---

## How to read this set

| If you are… | Start with… | Then read… |
|---|---|---|
| **CEO / executive** | Doc 1 (Executive Summary) | Doc 10 (Risk/Compliance), Doc 11 (Deployment) |
| **New joiner (engineer)** | Doc 1 → Doc 2 | Doc 3 (OEMS), Doc 9 (API), Doc 11 (Deployment) |
| **New joiner (non-engineer)** | Doc 1 | Doc 3 (OEMS), Doc 6 (Research/IC) |
| **OEMS operator** | Doc 1 → Doc 3 | Doc 6 (Research/IC), Doc 9 (API), Doc 4 (IRESS) |
| **Quant** | Doc 1 → Doc 8 (Models) | Doc 3 (OEMS), Doc 9 (API), Doc 7 (Canvas) |
| **Compliance / audit** | Doc 1 → Doc 10 | Doc 9 (API), Doc 6 (Research/IC), Doc 11 (Deployment) |
| **On-call engineer** | Doc 1 → Doc 9 (API) | Doc 4 (IRESS), Doc 5 (Worker), Doc 11 (Deployment) |
| **Ops** | Doc 1 → Doc 5 (Worker) | Doc 4 (IRESS), Doc 11 (Deployment), Doc 10 (Risk) |

---

## Corrections vs older handoffs

The following corrections were applied to the docs based on actual codebase inspection:

- **Doc 1, 4** — `IressClient` surface has **23 methods** (not 17). Fault code `25008` is primarily a **license-seat dispute**.
- **Doc 1, 6** — `/oems/research-lab` redirects to `/oems/research`; the v1 session-only editor is at `/oems/research-lab-legacy`.
- **Doc 1, 6** — Rebalance `push` returns **HTTP 501 `deferred`** since 2026-07-27; use `POST /api/admin/orderbook/send-to-market` instead.
- **Doc 1, 6** — Investment Committee has **3 fixed members** (Lonwabo chair, Juan voting, Lethabo voting), 2/3 majority threshold.
- **Doc 1, 7** — Canvas is at `/canvas` (not `/oems/canvas`).
- **Doc 1, 10** — `/oems/compliance` does **not** exist as a route; the real surface is `/compliance` (placeholder) + `/admin/cyber-compliance` (audit viewer).
- **Doc 1, 10** — `/oems/admin/*` does **not** exist as a route group; the real admin paths are top-level `/admin/*`.
- **Doc 2, 11** — The HTML runbook (`docs/MINT_GO_LIVE_RUNBOOK.html`) is **stale**; `docs/GO_LIVE_RUNBOOK.md` is the authoritative phased plan.
- **Doc 3** — Many `/oems/*` paths referenced in older IA drafts are actually **panels inside the single Cockpit `/oems` page**, not discrete routes.
- **Doc 4** — Single-seat model: only the Railway worker holds the prod license; multi-replica drains = 25008 collision.
- **Doc 5** — Dual Dockerfile / entry-point model: `main.ts` for **UAT**, `main-prod.ts` for **PROD**. Single replica per worker.
- **Doc 8** — Charts use **Recharts v2.15.0**. Equity curve wins over stored metric — server overrides `budget/final_equity/total_return/max_drawdown` from the equity curve.
- **Doc 9** — `/api/orders/stream` is SSE.
- **Doc 10, 11** — **5 active P0/P1 risks** including a leaked retail `service_role` JWT in `docs/TWO_DATABASE_STRATEGY.md:278` (rotate + purge).
- **Doc 11** — **No GitHub Actions workflows exist** in this repo or the parent monorepo.
- **Doc 11** — Worker `WORKER_HTTP_TOKEN` literal is checked into `ISSUES_LOG.md:0.5.4.a` and needs rotation.

---

## Source files (local copies)

All 11 documents plus this INDEX are also saved locally at:

```
Wealth Navigator/wealth-navigator/docs/clickup/
├── INDEX.md
├── 01-CEO-Executive-Summary.md
├── 02-Architecture-Stack-DB-Topology.md
├── 03-OEMS-Trading-Desk.md
├── 04-IRESS-V4-Integration.md
├── 05-Railway-IRESS-Worker.md
├── 06-Research-Lab-IC.md
├── 07-Canvas-Beta.md
├── 08-Models-Qentari-Bravo.md
├── 09-API-Surface.md
├── 10-Risk-Compliance-Audit.md
└── 11-Deployment-Cutover-Runbook.md
```

---

## Status

- ✅ Doc 1 — CEO Executive Summary
- ✅ Doc 2 — Architecture, Stack & 3-DB Supabase Topology
- ✅ Doc 3 — OEMS Trading Desk
- ✅ Doc 4 — IRESS V4 Integration & Order Lifecycle
- ✅ Doc 5 — Railway IRESS Worker (workers/iress-ingest)
- ✅ Doc 6 — Research Lab + Research Library + Investment Committee
- ✅ Doc 7 — Canvas (beta)
- ✅ Doc 8 — Models — JSE Alpha (Qentari Bravo)
- ✅ Doc 9 — API Surface
- ✅ Doc 10 — Risk, Compliance, Audit, Operational Posture
- ✅ Doc 11 — Deployment, Cutover Runbook, Env Vars, CI/CD

**Total:** 11 docs + 1 INDEX. All pushed to ClickUp via `user-clickup` MCP as parent doc + 11 sub-pages under `https://app.clickup.com/90152666892/v/dc/2kyr91rc-1935`.

---

## Reference: workspace coordinates

- **ClickUp workspace**: `90152666892`
- **Space**: `901511714420` "MINT DEVELOPEMENT"
- **List**: `901524962273` "MINT APP"
- **List URL**: `https://app.clickup.com/90152666892/v/li/901524962273`
- **Wealth Navigator doc URL**: `https://app.clickup.com/90152666892/v/dc/2kyr91rc-1935`

---

## Workspace rules (from root `AGENTS.md`)

- All code changes go on `MINT-DEVELOPMENT` only — never edit `MINT-LIVE` directly.
- App-specific durable preferences are tracked in per-package `AGENTS.md` files (e.g., `Wealth Navigator/AGENTS.md`).
- No OAuth client secrets, Railway `rlwy_oaci_*` / `rlwy_oacs_*`, Supabase service-role, IRESS, Stripe, broker, payment-provider, or `NEXT_PUBLIC_*` secrets ever go into source control, docs, AGENTS.md, or client bundles.
- ClickUp workspace member user IDs (durable, use directly in `clickup_create_task` / `clickup_update_task` assignee arrays): Mufaro Ncube `112539554`, Mpumelelo Maswanganye `112539553`, Sean Luvuno `112539555`, Tsie Masilo `112539552`, Juan van Wyk `228227801`, Lonwabo Damane `112539556`. Team email domain is `mymint.co.za`.

---

*This documentation set is the canonical reference for Wealth Navigator. Read end-to-end on first onboarding; reference specific docs thereafter.*
