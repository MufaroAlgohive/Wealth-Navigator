# Wealth Navigator — Architecture, Stack & 3-DB Supabase Topology

**Audience:** developers, new joiners, technical CEO.
**Last reviewed:** 2026-08-15.
**Source of truth:** `wealth-navigator/docs/STACK_ARCHITECTURE.md`, `wealth-navigator/docs/DB_TOPOLOGY_DECISION.md`, `wealth-navigator/docs/DATA_PROVENANCE.md`, `wealth-navigator/docs/CLOUD_DEPLOYMENT.md`, `wealth-navigator/docs/ENV_MIGRATION.md`, `wealth-navigator/package.json`, `wealth-navigator/.vercel/project.json`, `wealth-navigator/vercel.json`, `wealth-navigator/src/lib/supabase/server.ts`, `wealth-navigator/src/lib/iress/index.ts`, `wealth-navigator/src/lib/data-policy.ts`.

---

## 1. The shape of the system

Wealth Navigator is a **two-server split** deployment:

```
┌─────────────────────────────────────────────────────────────────────────┐
│                  Wealth Navigator — high-level topology                │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│   Vercel (wealth-navigator-one.vercel.app)                              │
│   ┌────────────────────────────────────────────────────────────────┐    │
│   │  Next.js 16 BFF (wealth-navigator/)                            │    │
│   │  • App router pages (OEMS, /admin, /oems/research, /canvas, …) │    │
│   │  • 137+ API routes under src/app/api/                          │    │
│   │  • IRESS_MODE = mock (never opens a live session)              │    │
│   │  • USE_SUPABASE_QUOTES = true (Path A — DB-first reads)        │    │
│   │                                                                │    │
│   │  Two Supabase clients (server.ts):                             │    │
│   │   • createRetailServiceRoleClient()   → mfxng…  (books)        │    │
│   │   • createInstitutionalServiceRoleClient() → nnwz… (desk)     │    │
│   └────────────────────────────────────────────────────────────────┘    │
│           ▲               ▲                                              │
│           │ Path B        │ Path A (DB)                                  │
│           │ (SSE, live)   │                                              │
│   ┌───────┴───────────────┴──────────────────┐                          │
│   │  Railway worker (Iress-Worker-PROD)      │                          │
│   │  workers/iress-ingest/                   │                          │
│   │  • Single IRESS license seat (only live) │                          │
│   │  • IRESS_MODE = live on webservices…     │                          │
│   │  • 7 concurrent loops (quote, order,     │                          │
│   │    timeseries, news, retail, etc.)       │                          │
│   │  • Two Supabase clients:                 │                          │
│   │     - institutional (nnwz…) — orders     │                          │
│   │     - retail (mfxng…) — prices only      │                          │
│   │  • HTTP API on PORT 8765                 │                          │
│   │  • Sticky ApplicationID                  │                          │
│   └──────────────────────────────────────────┘                          │
│           │                                                              │
│           ▼                                                              │
│   IRESS V4 Web Services                                                  │
│   • Production: https://webservices.iress.co.za/v4                      │
│   • Account: 43448 (prod) | 56378 (UAT — isolated)                      │
│   • IOS+ server: MINT (prod) | MINT_CT (UAT)                            │
│   • News vendor: SENSD (delayed — only one entitled on prod)            │
└─────────────────────────────────────────────────────────────────────────┘
```

**No second API, no second auth** — Vercel and Railway both call Supabase + IRESS; the BFF is the only entry point for the UI.

---

## 2. Stack

| Layer | Choice | Source |
|---|---|---|
| Frontend framework | Next.js 16 App Router | `wealth-navigator/package.json` |
| React | React 19 | `wealth-navigator/package.json` |
| Runtime | Bun `>=1.1.0` (Bun image `oven/bun:1.1` on Railway worker) | `wealth-navigator/package.json`, `workers/iress-ingest/Dockerfile` |
| Node version | `>=20.0.0` | `wealth-navigator/package.json` `engines.node` |
| Language | TypeScript strict | `wealth-navigator/tsconfig.json` |
| Styling | Tailwind 4 + shadcn/ui | `wealth-navigator/tailwind.config.*`, `wealth-navigator/components.json` |
| Charts | recharts `v2.15.0` | `wealth-navigator/package.json:68` |
| Backend host | Vercel (`wealth-navigator-one.vercel.app`) | `wealth-navigator/.vercel/project.json` |
| Worker host | Railway (`Iress-Worker-PROD`, `iress-worker-production.up.railway.app`) | `AGENTS.md:7, 19` |
| Database | Supabase (3-DB topology) | `wealth-navigator/docs/DB_TOPOLOGY_DECISION.md` |
| Realtime | Supabase Realtime on `stock_intraday_c` | `wealth-navigator/src/app/oems/...` |
| Auth | Supabase Auth (email/password for staff; magic-link invite for new joiners) | `wealth-navigator/src/app/api/auth/login/route.ts` |
| Storage | Supabase Storage (KYC, signed agreements, mandate PDFs) | `wealth-navigator/src/lib/pdf/mandate.ts` |
| Payments | Ozone (mock-only until Tsie contract) | `wealth-navigator/src/lib/payments/ozone.ts` |
| Email | Resend (transactional) | `wealth-navigator/src/lib/admin/email.ts` |
| AI | M3 (MINT's own model, used in Canvas + research-ai cache) | `wealth-navigator/src/lib/research-ai/provider.ts` |
| Vendor price fallback | Yahoo Finance (cron + dashboard fallback when IRESS unavailable) | `wealth-navigator/src/app/api/cron/yahoo-fundamentals/route.ts` |
| Trading network | IRESS V4 Web Services (SOAP) | `wealth-navigator/src/lib/iress/` |

### Theming & UI primitives
- **Theme** — purple accent on white (light) and dark slate-purple (dark) (root `AGENTS.md:5`).
- **OEMS glassmorphism** — `globals.css` tokens + shared `wealth-navigator/src/components/oems/primitives/glass.tsx` exports:
  - `GlassSection`
  - `GlassKpi`
  - `GlassSegment`
  - `PageCanvas` (re-exported as `PageCanvas = ResearchLabCanvas`)
  - `glass-inset` utility class
- These primitives are shared across desk + persona pages.
- The data-source badge (`wealth-navigator/src/components/oems/primitives/data-source-badge.tsx:16-32`) renders the full taxonomy: `live | iress | yahoo | external | mock | seed | hybrid | supabase | stream | worker | uat | unconfigured | unavailable | blocked-external | blocked-vendor | code-gap`. `iress` renders as `IRESS·PROD` (line 57), `uat` as `IRESS·UAT` (line 67).

---

## 3. Repository layout

```
MINT/
├── AGENTS.md                              # Workspace-level rules (MINT-DEVELOPMENT, secrets, etc.)
├── Wealth Navigator/                      # ← this repo
│   ├── AGENTS.md                          # WN-specific rules (IRESS creds, prod URL, 3-DB split)
│   ├── PLANNING.md                        # OEMS surface map + persona plan + build phases
│   ├── TABLES.md                          # RETAIL schema reference
│   ├── Documentation & Vision/            # Pitch, brand, IRESS reference, email confirmations
│   │   ├── iress-v4-docs/                 # IRESS V4 WSDL + service guides
│   │   ├── Email/                         # Operator emails (Andre 2026-07-09, vendor onboarding)
│   │   └── Lovable Codebase/              # Yield Basket prototype
│   ├── Lovable Codebase/                  # Historical
│   ├── docs/                              # Misc docs (scratch, historical)
│   ├── scratch/                           # Dev scratch
│   ├── .claude/, .cursor/                 # Agent config
│   ├── supabase_creds/                    # gitignored; service-role keys
│   ├── vercel-project-patch.json          # Vercel deploy patches
│   ├── commit_msg.txt                     # Git history context
│   └── wealth-navigator/                  # The Next.js app
│       ├── package.json                   # Bun + Next 16 + React 19
│       ├── tsconfig.json                  # strict TS
│       ├── tailwind.config.*              # Tailwind 4
│       ├── components.json                # shadcn/ui registry
│       ├── next.config.*                  # Next.js config
│       ├── vercel.json                    # Cron definitions
│       ├── .vercel/project.json           # Vercel project ID + org ID
│       ├── .env.example                   # Canonical Vercel env contract
│       ├── docs/                          # Stack arch, DB topology, data provenance, etc.
│       │   ├── STACK_ARCHITECTURE.md
│       │   ├── DB_TOPOLOGY_DECISION.md
│       │   ├── DATA_PROVENANCE.md
│       │   ├── REMAINING_GAPS.md
│       │   ├── VERCEL_DEPLOY_SETUP.md
│       │   ├── GO_LIVE_RUNBOOK.md         # Authoritative phased plan (HTML version is stale)
│       │   ├── MINT_GO_LIVE_RUNBOOK.html  # Stale — HTML snapshot
│       │   ├── IRESS_INTEGRATION_AND_SCALE_SAFETY.md
│       │   ├── IRESS_PRICE_SCALE_INCIDENT_HANDOFF.md
│       │   ├── ISSUES_LOG.md              # Post-cutover operating reality
│       │   ├── MINT_PRODUCTION_READINESS_AUDIT.md
│       │   ├── MINT_X100_FIX_RUNBOOK.md
│       │   ├── UAT_ORDER_PIPELINE.md
│       │   ├── VENDOR_ENTITLEMENT_STATUS.md
│       │   ├── BROKER_INTEGRATION.md
│       │   ├── OZONE_INTEGRATION.md
│       │   ├── PHASE1_IRESS_RETAIL_CUTOVER.md
│       │   ├── SENS_NEWSHEADLINE_WIRE.md
│       │   ├── CLOUD_DEPLOYMENT.md
│       │   ├── ENV_MIGRATION.md
│       │   ├── TIMESERIES_UNBLOCK_PLAN.md
│       │   ├── README_ic_committee.md
│       │   └── clickup/                   # ← this documentation set
│       ├── public/                        # Static assets
│       ├── scripts/                       # iress-logout.ts, diag scripts
│       ├── supabase/
│       │   ├── migrations/                # Institutional OEMS DDL (project nnwz…)
│       │   ├── retail/                    # RETAIL DDL (project mfxng…)
│       │   └── seeds/                     # IC committee seed, etc.
│       └── src/
│           ├── middleware.ts              # Supabase session gate + redirects
│           ├── app/                       # App router pages + API routes
│           │   ├── page.tsx               # / → redirect to /oems
│           │   ├── layout.tsx             # Root layout (Inter + JetBrains Mono, dark default)
│           │   ├── login/                 # Public auth chrome
│           │   ├── signup/, reset-password/
│           │   ├── auth/                  # Supabase email-link handlers
│           │   ├── oems/                  # Trading desk (cockpit + blotter + …)
│           │   ├── strategies/            # Mandates + Builder
│           │   ├── wm/                    # Wealth Manager client book
│           │   ├── admin/                 # /admin/* tree
│           │   ├── compliance/            # Persona-gated placeholder
│           │   ├── business/, strategist/, fc/   # Persona placeholders
│           │   ├── canvas/                # Canvas (beta)
│           │   ├── settings/, analysis/
│           │   └── api/                   # 137+ route handlers
│           ├── components/
│           │   ├── admin/                 # Admin surfaces
│           │   ├── canvas/                # Canvas
│           │   ├── chatsight/
│           │   ├── company-analysis/
│           │   ├── hooks/                 # Shared React hooks
│           │   ├── oems/                  # OEMS primitives + pages
│           │   │   └── primitives/        # glass, glass-kpi, page-canvas, …
│           │   ├── pdf/                   # Mandate PDF renderer
│           │   ├── platform/              # Nav, command palette, top-bar
│           │   ├── research-ai/           # AI research consumer
│           │   ├── research-ic/           # Investment Committee UI
│           │   ├── research-lab/          # Legacy Research Lab (session-only)
│           │   ├── store/                 # Zustand session provider
│           │   └── ui/                    # shadcn primitives
│           ├── hooks/
│           ├── lib/
│           │   ├── admin/                 # RBAC, pages registry, context
│           │   ├── auth/                  # Auth store
│           │   ├── canvas/
│           │   ├── chatsight/
│           │   ├── company-analysis/
│           │   ├── data-policy.ts         # Path A/B feature flags
│           │   ├── data-source.ts         # Source string normalization
│           │   ├── hooks/                 # Custom hooks
│           │   ├── iress/                 # SOAP adapter (live + mock)
│           │   ├── oems/                  # uat-scope, rebalance-scope
│           │   ├── orders/                # preflight, submit, …
│           │   ├── payments/              # Ozone
│           │   ├── pdf/                   # Mandate renderer
│           │   ├── platform/              # Nav + access
│           │   ├── rebalance/             # IC vote tally
│           │   ├── research-ai/           # AI cache + provider
│           │   ├── research-ic/           # IC committee + gate
│           │   ├── research-lab/          # Legacy server
│           │   ├── store/                 # Session provider
│           │   ├── supabase/              # 3-DB clients + middleware
│           │   └── store/                 # Zustand
│           └── types/                     # Shared types
└── workers/                               # Sibling workers (top-level historically, now under wealth-navigator/workers/)
    ├── iress-ingest/                      # Production IRESS worker
    └── broker-ingest/                     # Phase C4 broker fill worker (mock-only)
```

Sibling workers:
- `workers/broker-ingest/` — Phase C4 broker fill pipeline. **Mock only** (blocked on Lonwabo vendor confirmation).

---

## 4. The three-database Supabase topology

Authoritative source: `wealth-navigator/docs/DB_TOPOLOGY_DECISION.md` (decided 2026-06-13; supersedes `TWO_DB_STRATEGY.md` and `TWO_DATABASE_STRATEGY.md`).

### The three databases

| Role | Project ref | Holds | Writer |
|---|---|---|---|
| **Retail prod** | `mfxnghmuccevsxwcetej` | Customer books (profiles, wallets, holdings, KYC, strategies_c, gifts, loans, funeral) **+ shared price tables** `securities_c` / `stock_intraday_c` | Consumer app + IRESS worker (prices) |
| **Institutional prod** | `nnwzhxfjpjbzujevwzlh` (promoted from the IRESS-test DB) | Desk trading book (`oems_order_audit`, `oems_position_c`, `oems_transaction_c`, `oems_account_c`, bookings, FIX+) **+ desk-only analytics** (curves, indices, sectors, macro, news, bonds, money-market, quant-model tables) | IRESS worker |
| **Staging** | Fresh project (to create) | Schema-mirror of both prods — validate IRESS calls + migrations before they touch prod | IRESS worker (staging mode) |

### Why three, not two
- **Compliance** — institutional ≠ retail in separate DBs (compliance cares about *books* — positions, orders, cash, customer PII — not the price feed).
- **"Rest of the data from `mfxng…`"** — all customer data + shared price tables stay together.
- **IRESS = source of truth** — the worker writes prices into retail prod, and trading book + desk analytics into institutional prod (two service-role clients).
- **Test DB retired** — `nnwz…` promoted from throwaway IRESS-test to institutional prod.
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
- `resolveServiceTarget(target: "RETAIL" | "INSTITUTIONAL")` (line 50) — central target resolver.

### Worker two-client split (`workers/iress-ingest/src/supabase.ts`)
- `createInstitutionalSupabase(env)` → `nnwz…` (desk trading book + worker ops).
- `createRetailSupabase(env)` → `mfxng…` (per-client ledger for `IRESS_PER_CLIENT_GUARD`).
- Dormant unless `IRESS_RETAIL_INGEST=1` AND `RETAIL_SUPABASE_URL` set.

### Staging
Staging is a third DB; no separate `supabase/staging/` directory exists locally — staging migrations are **co-located** in the same `supabase/migrations/` and `supabase/retail/` directories, applied to the staging project by ops.

### Join keys (deferred past OEMS v1)
- Market data ↔ by `symbol`.
- Client ↔ desk by `mint_number` ↔ IRESS `AccountCode` (`DB_TOPOLOGY_DECISION.md:81, 150`).

---

## 5. BFF architecture (Path A vs Path B)

### Path A — Worker → Supabase → BFF
For **snapshots and audit**. UI reads these through Supabase service-role clients. The worker has already written the IRESS-derived data into Supabase; the BFF just reads.

- `/api/quotes` — `securities_c` + `stock_intraday_c` + `quote_snapshot_c` overlay.
- `/api/orders` — `oems_order_audit`.
- `/api/worker-health` — `integration_worker_health`.
- `/api/intraday/[sym]` — `stock_intraday_c`.
- `/api/equities` — Yahoo fallback for retail board.
- `/api/indices/J203` — ALSI/J203 (also `^J203.JO` Yahoo).
- `/api/news` — RSS + Alliance + IRESS `news_item_c`.

### Path B — Worker → Vercel passthrough
For **live and ephemeral** data. The BFF reverse-proxies live SOAP results from the worker. Gated by `IRESS_WORKER_URL` (or `RAILWAY_SERVICE_URL`) and the shared `WORKER_HTTP_TOKEN` (Bearer).

- `/api/orders/live` — worker `/orders` (`OrderPadGetByAccount`).
- `/api/orders/stream` — SSE worker `/orders/stream`.
- `/api/integration/health` — worker `/health`.
- `/api/integration/diagnostics` — worker `/debug/ips-session`.
- `POST /api/orders/submit` — worker `/orders/send-to-market`.
- `POST /api/orders/cancel` — worker `/orders/cancel`.
- `POST /api/orders/amend` — worker `/orders/amend`.

### Preflight local path
`POST /api/orders/preflight` runs **without the worker** — direct server-side `preflight()` from `wealth-navigator/src/lib/orders/preflight.ts`. Validates `symbol`, `side`, `quantity`, `source`. Does not talk to the worker.

### Worker passthrough plumbing (`wealth-navigator/src/lib/iress/worker-api.ts`)
- `WORKER_API_TIMEOUT_MS = 10_000` (line 25).
- `resolvedBase()` (lines 77-85) — repairs malformed `IRESS_WORKER_URL` (strips stray ` Port 8765`, adds `https://`, removes trailing slash).
- `callWorker(opts)` (lines 162-233) — `Authorization: Bearer ${WORKER_HTTP_TOKEN}` attached when set (line 191-193). Surfaces upstream body verbatim up to 16 KB.
- `streamWorkerSse(opts)` (lines 246-257) — returns the URL + `Accept: text/event-stream` headers; returns `null` when unconfigured.
- `WorkerApiResult` discriminated union (lines 28-49) — `not_configured`, `unreachable`, `timeout`, `upstream_error`.

### Data policy (`wealth-navigator/src/lib/data-policy.ts`)
- `isUseSupabaseQuotesEnabled()` (lines 14-18) — default-on when `USE_SUPABASE_QUOTES` is unset/`true` (Path A).
- `isRealDataOnlyClient()` (lines 21-45) — client mirror via `NEXT_PUBLIC_USE_SUPABASE_QUOTES`; URL override `?mock=1` / `?mock=0` (server ignores).
- `isProductionRealDataMode()` (lines 86-89) — alias.
- `isWorkerLiveMode()` (lines 108-110) — Path B gate.
- `getIressWorkerUrl()` (lines 125-131) — `IRESS_WORKER_URL` → `RAILWAY_SERVICE_URL` → empty string.
- `isIressWorkerConfigured()` (lines 134-136) — used by every Path B route.

---

## 6. Env vars — exhaustive list

> Source files: `wealth-navigator/.env.example`, `wealth-navigator/src/lib/iress/index.ts`, `wealth-navigator/src/lib/iress/config.ts`, `wealth-navigator/src/lib/iress/data-policy.ts`, `wealth-navigator/src/lib/iress/worker-api.ts`, `wealth-navigator/workers/iress-ingest/.env.example`, `wealth-navigator/workers/iress-ingest/src/env.ts`, `wealth-navigator/workers/iress-ingest/src/session.ts`, `wealth-navigator/docs/VERCEL_DEPLOY_SETUP.md`, `wealth-navigator/docs/ENV_MIGRATION.md`.
> **Never** echo real secret values. Refer to file paths only.

### IRESS (server-only)
| Var | Where | Default | Required | Behaviour |
|---|---|---|---|---|
| `IRESS_MODE` | Vercel + worker | `mock` on Vercel; `live` on Railway worker | Yes (worker) | Drives IressClient selection in `src/lib/iress/index.ts`. |
| `IRESS_BASE_URL` | Both | Prod `https://webservices.iress.co.za/v4`; UAT `https://webservices-ct.iress.co.za/v4` | Yes (worker) | SOAP endpoint. `main-prod.ts` refuses `webservices-ct`. |
| `IRESS_PROD_URL` | Both | Prod URL | Optional | Used by single-seat prod market-data session (`market-data.ts:50`). |
| `IRESS_REGION` | Both | `ZA` | Optional | Display only. |
| `IRESS_USERNAME` | Worker | "" | Yes (worker live) | SOAP login; never `NEXT_PUBLIC_*`. |
| `IRESS_PASSWORD` | Worker | "" | Yes (worker live) | Same. |
| `IRESS_COMPANY_NAME` | Worker | `Mint` (when `@` in username) | Yes (worker live) | Parsed in `src/lib/iress/config.ts:21-39`. |
| `IRESS_PROD_USERNAME` / `IRESS_PROD_PASSWORD` / `IRESS_PROD_COMPANY_NAME` | Worker | "" | Optional (override) | Dedicated prod credentials override (`src/lib/iress/config.ts:66-77`). |
| `IRESS_ACCOUNT_CODE` | Adapter + worker | empty | **Yes at runtime** for production (`http-api.ts:161`); missing → `503 account_not_configured` on `/orders`, `/uat/send-to-market`. Production = `43448`. |
| `IRESS_UAT_ACCOUNT_CODE` | Worker | falls back to `IRESS_ACCOUNT_CODE` | Required when `IRESS_UAT_MODE=1` | MUST differ from `IRESS_ACCOUNT_CODE` for safety. |
| `IRESS_UAT_MODE` | Worker | `false` | Opt-in | Toggles UAT lane; enables `/uat/*` routes + UAT order poll loop. |
| `IRESS_UAT_ORDER_POLL_SEC` | Worker | `30` (floor 5) | Optional | UAT order poll cadence. |
| `IRESS_DEFAULT_EXCHANGE` | Worker | `JSE` | Optional | Default exchange for `PricingQuoteGet`. |
| `IRESS_FX_EXCHANGE` | Worker | `FX` | Optional | FX rate-code exchange. |
| `IRESS_MM_EXCHANGE` | Worker | `MM` | Optional | Money-market exchange. |
| `IRESS_IOS_SERVER` | Adapter + worker | `MINT` (prod) / `MINT_CT` (UAT) | Optional | `Server` arg for `ServiceSessionStart`. |
| `IRESS_IPS_SERVER` | Adapter + worker | `IPSAPI` | Optional | `Server` for `IPS` service. |
| `IRESS_FIX_SERVER` | Adapter + worker | `FIXPLUSAPI` | Optional | `Server` for `FIX+` service. |
| `IRESS_ENABLE_IPS` | Adapter + worker | `0` | Opt-in | Re-enable the parked IPS loop. |
| `IRESS_ENABLE_FIX` | Adapter + worker | `0` | Opt-in | Re-enable the parked FIX+ loop. |
| `IRESS_ORDER_FILTER` | Worker | `7` (per `env.ts:152-155`) | Optional | `OrderPadGetByAccount` filter (widened 1-7 after Andre probe 2026-07-27). |
| `IRESS_IRESS_METHODS` / `IRESS_IOS_METHODS` / `IRESS_IPS_METHODS` / `IRESS_FIX_METHODS` | Adapter | empty | Optional | Allow-list per namespace. |
| `IRESS_SVC_START_TIMEOUT_MS` | Adapter | `30_000` (live.ts:1011) | Optional | `ServiceSessionStart` timeout. |
| `IRESS_SVC_START_RETRIES` | Adapter | `1` | Optional | `ServiceSessionStart` retry attempts. |
| `IRESS_SVC_START_RETRY_DELAY_MS` | Adapter | `1000` | Optional | Backoff between retries. |
| `IRESS_QUOTE_RAW_LOG` | Adapter | unset | Optional | Dumps raw quote rows. |
| `IRESS_TS_DATASOURCE` | Adapter + worker | `zax` | Optional | `TimeSeriesGet2` `DataSource`. |
| `IRESS_SESSION_NUMBER_TO_KICK` | Adapter | unset | Recovery only | Numeric seat to evict on `25008`. |
| `IRESS_FORCE_KICK_ALL` | Adapter + worker | `0` | Recovery only | Set `=1` to auto-kick on first-boot `25008`; unset after recovery. |
| `IRESS_FORCE_ORPHAN_CLEAR` | Worker | `0` | Recovery only | One-shot orphan clearance: polls `IRESSSessionStart` every 3s for up to 60s. |
| `IRESS_SHUTDOWN_HOOKS` | Adapter | `0` | Optional | Disable SIGINT/SIGTERM release. |
| `IRESS_WATCHLIST_SYMBOLS` | Worker | empty → default 12-symbol list from `JSE_TRACKED_UNIVERSE + JSE_RATE_CODES` | Optional | Comma-separated override. |
| `IRESS_WATCHLIST_EXCHANGES` | Worker | `{}` | Optional | `SYM=EXCHANGE` per-symbol map. |
| `IRESS_WORKER_DRY_RUN` | Worker | `true` (safe default) | Optional | Worker-wide dry-run; default-on. |
| `SUPABASE_ALLOW_WRITES` | Worker | `false` (safe default) | Optional | Worker-wide DB writes; default-off. |
| `IRESS_WORKER_HEARTBEAT_SEC` | Worker | `30` (floor 5) | Optional | Heartbeat loop cadence. |
| `IRESS_WORKER_QUOTE_INTERVAL_SEC` | Worker | `15` (floor 5) | Optional | Quote sync cadence. |
| `IRESS_WORKER_ORDER_POLL_SEC` | Worker | `60` (disable when ≤0) | Optional | Order-pad poll cadence. |
| `IRESS_WORKER_TIMESERIES_INTERVAL_SEC` | Worker | `300` | Optional | TimeSeries loop. |
| `IRESS_WORKER_INDEX_INTRADAY_INTERVAL_SEC` | Worker | `120` | Optional | Index intraday loop. |
| `IRESS_WORKER_INSTRUMENT_SYNC` | Worker | `false` | Opt-in | Enables `securities_c` instrument sync loop. |
| `IRESS_ALERT_EVAL_SEC` | Worker | `60` (floor 15) | Optional | Trigger evaluator cadence. |
| `IRESS_PRODUCTION_ORDERS` | Worker | `false` | **Opt-in prod gate** | Shared gate between `/uat` and `/uat/send-to-market`. |
| `IRESS_PER_CLIENT_GUARD` | Worker | `0` | **Mandatory for production client orders** (`http-api.ts:148-159`) | Toggles client-order pre-trade guard. |
| `IRESS_BUY_GUARD_CAP_RANDS` | Worker | `NaN` → no cap | Optional | Max buy cap. |
| `IRESS_MARKET_BUY_BUFFER` | Worker | `1.02` | Optional | Buffer multiplier for buy guard. |
| `IRESS_DESTINATION` / `IRESS_PRODUCTION_DESTINATION` | BFF + worker | `LONGMARK CARE` | Optional | IOS+ destination free-text. |
| `IRESS_PRICE_OVERLAY` | Worker + adapter | unset (= render IRESS prices) | UAT override | `=0` makes Yahoo own `last_price` + `change_percent`. |
| `IRESS_RETAIL_INGEST` | Worker | `false` | Opt-in | Enables full-universe retail price loop. |
| `IRESS_RETAIL_DRY_RUN` | Worker | `true` | Optional | Retail-ingest dry-run (companion to `IRESS_RETAIL_INGEST=1`). |
| `RETAIL_SETTLEMENT_ENABLED` | Worker | `false` | **Opt-in settlement** | Only path that moves client money. |
| `RETAIL_SETTLEMENT_DRY_RUN` | Worker | `true` | Optional | Default-on; logs wallet/lot deltas without persisting. |
| `RETAIL_PRICE_SOURCE_COL` | Worker | unset | Optional | When `1`, stamps `price_source` on retail writes. |
| `RETAIL_SCALE_REF_COL` | Worker | unset | Optional | Read `scale_ref_cents` column (review-only migration). |
| `IRESS_NEWS_INGEST` | Worker | unset | Opt-in | Enables news ingest loop. |
| `IRESS_NEWS_DRY_RUN` | Worker | `true` | Opt-in | Per-loop news dry-run. |
| `IRESS_NEWS_ALLOW_WRITES` | Worker | `false` | Opt-in | Per-loop news writes to `news_item_c`. |
| `IRESS_NEWS_VENDOR` / `newsVendorCode` | Worker | `SENSD` (prod); `SENS` (CT/UAT) | Optional | Vendor code for `NewsHeadlineGet` (env.ts:333). |
| `IRESS_NEWS_MAX_ROWS` | Worker | `2000` (floor 500) | Optional | Per-loop row cap. |
| `IRESS_NEWS_INGEST_INTERVAL_SEC` | Worker | `21600` (6h, floor 300) | Optional | News loop interval. |
| `IRESS_USE_SINGLE_SEAT` | Worker | `1` | Default | Legacy knob — single-seat is now the only shape. |
| `IRESS_MARKET_DATA_PROD` | Worker | `1` (post-cutover) | Back-compat | Legacy dual-session flag removed. |
| `IRESS_MARKETDATA_BASE_URL` | Worker | `iressConfig.prodUrl` | Optional | Prod market-data endpoint. |
| `IRESS_TIMESERIES_INDEX_CODES` | Worker | `J203` | Optional | Index codes. |
| `IRESS_TIMESERIES_SECTOR_CODES` | Worker | `[]` | Optional | Sector codes. |
| `IRESS_TIMESERIES_CURVE_CODES` | Worker | `["R2030","R2035","R2040"]` | Optional | Curve codes. |
| `IRESS_TIMESERIES_REAL_CODES` | Worker | `[]` | Optional | Real-rate codes. |
| `IRESS_TIMESERIES_CURVE_EXCHANGE` | Worker | `AGB` | Optional | Curve exchange. |
| `IRESS_TIMESERIES_CURVE_DATASOURCE` | Worker | `JSED` | Optional | Curve data source. |
| `IRESS_TIMESERIES_INDEX_DATASOURCE` | Worker | `JSED` | Optional | Index data source. |
| `IRESS_HOT_PRICE_INTERVAL_SEC` | Worker | `0` (off) | Optional | Hot symbol sub-loop. |
| `IRESS_DEBUG_ORDERS_PROBE` | Worker | unset | Optional | One-shot orders-entitlement probe (can evict market-data session if not disabled). |
| `IRESS_ALLOW_MUTATIONS` | Worker | `0` (blocked) | Optional | Allow `/debug/soap-raw` mutating methods. |
| `IRESS_STALE_FALLBACK_HOURS` | BFF (Yahoo cron) | `3` | Optional | Yahoo takes over after this many hours without IRESS update. |

### Worker HTTP API
| Var | Where | Default | Required | Behaviour |
|---|---|---|---|---|
| `WORKER_HTTP_PORT` | Worker | `8765` | Optional | Local port. Railway sets `PORT` automatically. |
| `WORKER_HTTP_HOST` | Worker | `0.0.0.0` | Optional | Bind host. |
| `WORKER_HTTP_DISABLED` | Worker | unset (= on) | Optional | Kill switch. |
| `WORKER_HTTP_TOKEN` | Worker + Vercel | unset (= auth off) | Opt-in pair | Shared bearer; both sides must opt in. |
| `WORKER_REQUIRE_HTTP_TOKEN` | Worker | unset (off) | Opt-in | Enforces the bearer check on the worker. |
| `WORKER_ID` | Worker | `iress-ingest-1` (UAT) / `iress-ingest-prod-1` (prod) | Yes | Used as `worker_session_metadata.worker_id` PK. |
| `RAILWAY_SERVICE_URL` | Vercel (auto-injected) | unset | Optional | Fallback for `IRESS_WORKER_URL`. |
| `IRESS_WORKER_URL` | Vercel | unset | Required for Path B | Public Railway domain. |
| `PORT` (Railway auto) | Worker | Railway-injected | — | Railway's port is honoured before `WORKER_HTTP_PORT`. |
| `RAILWAY_DEPLOYMENT_ID` / `RAILWAY_SERVICE_NAME` | Worker | Railway-injected | — | Build `ApplicationID` + logging identity. |
| `RAILWAY_REPLICA_ID` | Worker | unset | Optional | Stable per-replica ID used in `ApplicationID`. |
| `NEWS_PROBE_MIN_GAP_MS` | Worker | `10000` | Optional | Throttle for `/debug/news-vendor-probe`. |

### Supabase / data tier
| Var | DB | Default fallback | Where |
|---|---|---|---|
| `SUPABASE_URL` | shared legacy | none | Worker + Vercel |
| `SUPABASE_SERVICE_ROLE_KEY` | shared legacy | none | Worker + Vercel |
| `RETAIL_SUPABASE_URL` | `mfxng…` | falls back to `SUPABASE_URL` | Worker + Vercel |
| `RETAIL_SUPABASE_SERVICE_ROLE_KEY` | `mfxng…` | falls back to `SUPABASE_SERVICE_ROLE_KEY` | Worker + Vercel |
| `RETAIL_SUPABASE_ANON_KEY` | `mfxng…` | optional | Vercel (server) |
| `INSTITUTIONAL_SUPABASE_URL` | `nnwz…` | falls back to `SUPABASE_URL` | Worker + Vercel |
| `INSTITUTIONAL_SUPABASE_SERVICE_ROLE_KEY` | `nnwz…` | falls back to `SUPABASE_SERVICE_ROLE_KEY` | Worker + Vercel |
| `STAGING_SUPABASE_URL` / `STAGING_SUPABASE_SERVICE_ROLE_KEY` / `STAGING_SUPABASE_ANON_KEY` | staging (when split) | none / optional | Worker + Vercel |
| `TEST_SUPABASE_URL` / `TEST_SUPABASE_SERVICE_ROLE_KEY` | E2E | optional | agent / test runs |
| `SUPABASE_ANON_KEY` | shared | optional | Vercel (anon clients only) |

Behaviour when missing:
- `RETAIL_SUPABASE_*` unset → retail `securities_c` + `stock_intraday_c` reads return `503 RETAIL database not configured` (see `app/api/quotes/route.ts:101`, `live-queries.ts:205`, `api/equities/route.ts:205`, `api/client-book/route.ts:68`).
- `INSTITUTIONAL_SUPABASE_*` unset → OEMS dashboards / `oems_order_audit` reads return zero/not-configured error.
- Worker startup logs `CONFIG: ... NOT SET ...` warnings (`workers/iress-ingest/src/main.ts:546, 559`).

### Supabase Auth + App env (browser-exposed)
| Var | Scope | Notes |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Vercel (client+server) | Public anon endpoint. |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Vercel (client) | Anon JWT — **must** stay public. |
| `NEXT_PUBLIC_APP_NAME` | Vercel | `Mint Wealth Navigator` (`STACK_ARCHITECTURE.md:235-254`). |
| `NEXT_PUBLIC_APP_REGION` | Vercel | `ZA`. |
| `NEXT_PUBLIC_TICK_STREAM` | Vercel | `/api/ticks`. |
| `NEXT_PUBLIC_TICK_INTERVAL_MS` | Vercel | Tick SSE cadence. |
| `NEXT_PUBLIC_USE_SUPABASE_QUOTES` | Vercel | Mirror of `USE_SUPABASE_QUOTES` for the browser. Default real-data when unset. |
| `USE_SUPABASE_QUOTES` | Vercel (server) | Default `true`; flips to Supabase-first DB read. |

### Vercel cron, auth, integrations
| Var | Where | Notes |
|---|---|---|
| `CRON_SECRET` | Vercel | Cron-authorization bearer for `/api/cron/*`. |
| `BROKER_WORKER_URL` | Vercel | Optional second worker (Phase C2 broker). |
| `NEXT_PUBLIC_BROKER_*` | Vercel | Front-end broker UI gates. |
| `RESEND_API_KEY` | Vercel | Outgoing KYC + View Portfolio mail (`admin/email.ts`). |
| `RESEARCH_AI_*` / `MINT_CLIENT_ORDER_SECRET` | Vercel | Specific feature service tokens. |
| `YAHOO_FUNDAMENTALS_WRITE` | Vercel | Set `=1` to flip `/api/cron/yahoo-fundamentals` from **shadow** to **live writes**. Default shadow. |

### News vendor override
`IRESS_NEWS_VENDOR` accepts the union documented in `src/lib/iress/client.ts:184-202` and `docs/DATA_PROVENANCE.md:235`: `SENS | IRESS | Reuters | Bloomberg | Moneyweb | Dow Jones | Business Day`. Worker defaults are `SENSD` (prod) / `SENS` (CT/UAT); BFF `/api/iress/news` defaults `SENS`. Vendor fault triggers a single fallback to `SENSD` (`news-ingest.ts::shouldFallbackToSensd()`).

---

## 7. Architectural decisions

### Path A vs Path B
- **Path A** — Worker writes IRESS-derived data to Supabase (every ~15s for quotes, ~60s for orders). BFF reads through Supabase service-role clients. UI sees fresh data with sub-second Realtime push on `stock_intraday_c`.
- **Path B** — BFF reverse-proxies the worker's HTTP API (port 8765). Used for ephemeral / live data that shouldn't be persisted (order stream SSE, integration health).
- Default-on `USE_SUPABASE_QUOTES=true` on Vercel. Path B is opt-in via the URL convention `live` (`/api/orders/live`) or by endpoint type (SSE).

### IRESS single-seat
- Only the Railway `Iress-Worker-PROD` holds the prod license seat. Vercel (`IRESS_MODE=mock`) never opens a live IRESS session.
- Single replica on Railway (multiple replicas = 25008 license collisions).
- Sticky `ApplicationID` persisted in `worker_session_metadata` on the institutional DB.

### IRESS base URL cutover (2026-07-23)
- `wealth-navigator/src/lib/iress/index.ts:74` defaults `IRESS_BASE_URL=https://webservices.iress.co.za/v4` (was UAT CT URL pre-cutover).
- `lib/iress/index.ts:230` defaults `IRESS_IOS_SERVER=MINT` (was `MINT_CT`).
- `lib/oems/uat-scope.ts:isUatEnv()` returns false when env is unset (was: true).
- `lib/data-policy.ts:isUseSupabaseQuotesEnabled()` defaults true so unset prod env reads Supabase (Path A).
- Worker `env.ts:newsVendorCode` defaults `SENSD` (only vendor entitled on prod).
- `IRESS_ACCOUNT_CODE` is **required at runtime** — `api/orders/{preflight,submit}` and `api/admin/orderbook/send-to-market` return 503 when unset instead of silently defaulting to `56378` (UAT).

### Investment Committee (server-side gate)
- Membership fixed to 3: Lonwabo (chair), Juan (voting), Lethabo (voting).
- 2/3 majority passes (≥ 2 yes of 3).
- Roster + threshold live in `wealth-navigator/src/lib/research-ic/committee.ts`.
- Server-side gate in `wealth-navigator/src/lib/research-ic/committee-gate.ts` reads `committee_member_c` on the institutional DB with a soft fallback to the static roster if the table isn't migrated.
- Both research-note votes (`research_vote_c`) and rebalance votes (`rebalance_vote_c`) respect the whitelist and the 0.5 threshold.

### OEM calculation convention
**Server-side only**: strategy value, basket construction, P&L, AUM fee, rebalance calculations. Front-end calculation is explicitly banned and treated as a bug. Lonwabo Damane owns the OEM basket/strategy/rebalance data flows.

### Security
- Service-role keys: server-side only, never `NEXT_PUBLIC_*`. Browser only receives `NEXT_PUBLIC_SUPABASE_URL` + `NEXT_PUBLIC_SUPABASE_ANON_KEY`.
- IRESS password: never in AGENTS.md, client bundles, or `NEXT_PUBLIC_*` variables.
- Railway OAuth secrets (`rlwy_oaci_*` / `rlwy_oacs_*`): server-side only.
- Stripe, OAuth client secrets: never exposed.

### `IRESS_PER_CLIENT_GUARD` (production)
- Default-off. When on, validates client SELL orders against the client's actual positions, not the desk omnibus.
- `IRESS_PER_CLIENT_GUARD=1` is **mandatory** for production client orders (`http-api.ts:148-159`).
- The production-order readiness gate (`http-api.ts:127-176`) returns a list of blockers including this flag.

### Three-layer safety gates (worker)
1. **Worker-wide**: `IRESS_WORKER_DRY_RUN` + `SUPABASE_ALLOW_WRITES`.
2. **Per-loop**: news (`IRESS_NEWS_*`), retail (`IRESS_RETAIL_DRY_RUN`).
3. **Explicit opt-ins for client money**: `IRESS_PRODUCTION_ORDERS=1`, `RETAIL_SETTLEMENT_ENABLED=1`, `IRESS_PER_CLIENT_GUARD=1`.

---

## 8. Build & dev

### Scripts (`wealth-navigator/package.json`)
- `dev` — `next dev`
- `build` — `next build`
- `start` — `next start`
- `lint` + `format` (Prettier)
- `test` + `test:watch` + `test:e2e`
- `typecheck` — `tsc --noEmit`
- `worker:iress` — `bun workers/iress-ingest/src/main.ts`
- `worker:iress:prod` — `bun workers/iress-ingest/src/main-prod.ts`
- `iress:logout` — `scripts/iress-logout.ts`
- `iress:probe-frequency`

### Engines
- `bun >= 1.1.0`
- `node >= 20.0.0`

### Branch strategy
- Root `AGENTS.md:1-8`: make all code changes on `MINT-DEVELOPMENT` only — never edit `MINT-LIVE` directly (the dev team syncs DEV → LIVE; live edits get reverted or conflict).
- This repo follows `feature/<ticket>-slug → main → Vercel auto-deploy`.
- Cross-cutting changes that need to land in MINT-LIVE go through the MINT org-level DEV → LIVE syncer.

### Vercel cron (`wealth-navigator/vercel.json`)
```json
{
  "framework": "nextjs",
  "crons": [
    { "path": "/api/cron/yahoo-fundamentals",    "schedule": "*/5 * * * 1-5" },
    { "path": "/api/cron/iress-validation",     "schedule": "0 13 * * 1-5" },
    { "path": "/api/cron/position-reconciliation", "schedule": "30 15 * * 1-5" }
  ]
}
```

### CI/CD
- **No GitHub Actions workflows exist** in this repo or the parent monorepo. Verified via `git ls-files '.github/**'` — empty.
- No pre-commit hooks (`husky`, `lint-staged` absent).
- CI today = manual `bun run lint/typecheck/test/build` before pushing.
- Vercel auto-deploys on push to `main`. Previews are produced for every branch.
- Railway GitHub app integration was **missing** for the worker service (`ISSUES_LOG.md:0.5.1`) — broke worker redeploys on push; installed manually via `https://railway.com/account/integrations`.

---

## 9. Theming & UI primitives

### Theme
- Purple accent on white (light) and dark slate-purple (dark) (root `AGENTS.md:5`).
- Tailwind config in `wealth-navigator/tailwind.config.*`.

### OEMS glassmorphism
- `wealth-navigator/src/components/oems/primitives/glass.tsx` exports:
  - `GlassSection` — card surface.
  - `GlassKpi` — KPI tile.
  - `GlassSegment` — segmented control.
  - `PageCanvas` — re-exported as `PageCanvas = ResearchLabCanvas`.
  - `glass-inset` utility class.
- Shared across desk + persona pages.

### Data-source badge
- `wealth-navigator/src/components/oems/primitives/data-source-badge.tsx:16-32` — the full taxonomy.
- `mapSource()` (`wealth-navigator/src/lib/data-source.ts:27-55`) normalises free-form BFF `source` strings into the badge kind. Default fallback is `"supabase"`.
- `iress` label renders as `IRESS·PROD` (badge.tsx:57). Always production market-data.
- `uat` label renders as `IRESS·UAT` (line 67). Sandbox seat, never production.

### Honest empty states
- `EmptyDataState` primitive in `wealth-navigator/src/components/oems/primitives/empty-data-state.tsx` — used everywhere a BFF returns `source: "unavailable"` / `unconfigured`.
- `useAuditOrders` (`wealth-navigator/src/lib/hooks/use-audit-orders.ts:36-44`) disables the query entirely when `realDataOnly` is on AND the user hasn't opted in via `?mock=1`.
- `/api/integration/health` returns `broker: { status: "unconfigured" }` when `BROKER_WORKER_URL` is empty (`src/app/api/integration/health/route.ts:124-125`).

### Charts
- **recharts v2.15.0** (per `wealth-navigator/package.json:68`).
- Charts used: `<AreaChart>`, `<LineChart>`, `<BarChart>`, `<PieChart>`, sparklines.
- Generic chart theme in `wealth-navigator/src/components/research-lab/chart-theme.ts` (`CHART_COLORS`, `CASH_COLOR`, `tooltipStyle`).
- JetBrains Mono font for chart tooltips; card background.
- Account-vs-benchmark visual separation enforced three ways (paper = solid primary, STX40 = dashed muted, both rebased to 100 with `ReferenceLine y={100}`).

---

## 10. Supabase migrations

### Layout
- Institutional OEMS DDL lives in `wealth-navigator/supabase/migrations/` (project `nnwzhxfjpjbzujevwzlh`).
- Retail price DDL lives in `wealth-navigator/supabase/retail/` (project `mfxnghmuccevsxwcetej`).
- Staging is a third DB; no separate `supabase/staging/` directory exists locally — staging migrations are **co-located in the same directories**, applied to the staging project by ops.

### Idempotency pattern
Every migration uses one of:
- `CREATE TABLE IF NOT EXISTS …` + `ALTER TABLE … ENABLE ROW LEVEL SECURITY` + `CREATE INDEX IF NOT EXISTS …`.
- `CREATE OR REPLACE VIEW` + `DROP POLICY IF EXISTS …` + `CREATE POLICY`.
- `ALTER TYPE … ADD VALUE IF NOT EXISTS` for `oems_order_audit.status` enum expansions.

No `DROP` / `TRUNCATE` / unconditional `DELETE` in shipped migrations.

### Migration author of record
- `securities_c`, `stock_intraday_c` — pre-existing tables (no migration in repo).
- `integration_worker_health` — `supabase/migrations/20260611000000_integration_worker_health.sql`.
- `worker_session_metadata` — `supabase/migrations/20260612000001_worker_session_metadata.sql` (sticky ApplicationID).
- `oems_order_audit` lifecycle states — three migrations:
  - `…20260713000001_oems_order_audit_lifecycle_states.sql:11` (added `pending_ack`, `acknowledged`, `working`, `partial`, `filled`, `cancelled`, `expired`, `rejected`, `failed`).
  - `…20260714000001_oems_order_audit_cancel_amend_pending.sql:16` (added `cancel_pending`, `amend_pending`).
  - `…20260722000001_oems_order_audit_parked.sql:18` (added `parked`).
- `intraday_read_policies` — `supabase/migrations/20260612000003_intraday_read_policies.sql` (anon/auth SELECT only).
- `securities_with_latest_quote` view — `supabase/migrations/20260612000004_iress_instrument_enrichment.sql`.
- Retail `watchlist_c` — `supabase/retail/20260710000012_watchlist_c.sql`.
- Retail `corp_action_c` — `supabase/retail/20260710000010_corp_action_c.sql`.
- `iress_price_validation_c` — `supabase/migrations/20260716000001_iress_price_validation_c.sql`.
- IC committee — `supabase/seeds/ic_committee_institutional.sql` (`committee_member_c` on institutional) + `supabase/seeds/ic_committee_retail.sql` (`admin_team` on retail).
- Model tracking — `supabase/migrations/20260712000001_model_tracking_c.sql`.
- Research notes + IC voting — `supabase/migrations/20260710000001_research_note_c.sql`, `20260710000002_research_vote_c.sql`, `20260710000003_ic_session_c.sql`, `20260710000004_rebalance_request_c.sql`, `20260713000001_rebalance_vote_c.sql`.
- AI research cache — `supabase/migrations/20260621000000_ai_research_cache_c.sql`.

### Cutover pre-req: identify existing `mfxng…stock_intraday_c` writer
Before the worker takes over `stock_intraday_c`, the operator must identify any other writer hitting `securities_c` + `stock_intraday_c` on the retail DB (the existing ~15s writer). The `/api/cron/yahoo-fundamentals` route is one such writer (when `YAHOO_FUNDAMENTALS_WRITE=1`, default shadow).

Steps:
1. `SELECT count(*), min(timestamp) FROM public.stock_intraday_c;` — current tick stream.
2. Tail any Vercel log entries that write to `stock_intraday_c` (cron / external scraper).
3. Pause the incumbent writer (`YAHOO_FUNDAMENTALS_WRITE=0`) before flipping the worker opt-ins (`IRESS_WORKER_DRY_RUN=0` + `SUPABASE_ALLOW_WRITES=1`).
4. Worker default cadence is 15 s (`IRESS_WORKER_QUOTE_INTERVAL_SEC`); drop to 5 s on production only after verifying Vercel cost (`ISSUES_LOG.md:0.5.4.f`).

---

## 11. Operational dashboards

- `/oems` (Cockpit) — KPI strip, sector heatmap, ZAR yield curve, ALSI intraday, SENS feed, open-orders tape, macro pulse, news, JIBAR/USDZAR.
- `/admin/finance` — Phase C7 finance aggregator (AUM fees + Day-1 P&L).
- `/admin/cyber-compliance` — User activity audit (`cc_audit_log`) + API health + incidents + policy checks.
- `/oems/integration` — Endpoint health, IRESS v4 → OEMS surface map, integration map, WSDL/version, gap call-outs.
- `/oems/iress-migration` — Yahoo → IRESS(PROD) cutover console; per-symbol accuracy scoreboard.

---

## 12. Open gaps summary

- Rebalance `push` returns 501 (use `POST /api/admin/orderbook/send-to-market` instead).
- Research Lab thesis add/remove is session-only (no DB persistence).
- IC voting UI not yet shipped to all personas.
- `oems_strategy_c` institutional rollup table is empty (still reading RETAIL `strategies_c`).
- Per-user `page_access` RBAC wiring still in flight.
- Materiality baseline in `src/lib/research-ai/cache.ts:23-32` is frozen at cache generation (by design).
- IC voting affordance — surface a "you have a pending vote" widget on `/oems` for the 3 committee members.
- C4 broker fill pipeline (`workers/broker-ingest/`) is mock-only (blocked on Lonwabo vendor).
- C6 Ozone wallet is mock-only (blocked on Tsie vendor).
- Stale `docs/TWO_DATABASE_STRATEGY.md:278` contains a live retail `service_role` JWT (P0.2 — must be rotated + scrubbed).
- 28 RLS-disabled tables on retail (P0.1).
- MINT crons unauthenticated + service-role + open CORS (P0.3).
- No GitHub Actions workflows exist (CI gap).
- 9 unpushed commits on `main` (`ISSUES_LOG.md:2.1`).
- HTML runbook (`docs/MINT_GO_LIVE_RUNBOOK.html`) is stale — replace with `docs/GO_LIVE_RUNBOOK.md`.
- `WORKER_HTTP_TOKEN` literal is checked into `docs/ISSUES_LOG.md:0.5.4.a` — needs rotation.

---

*This doc is the on-ramp for engineers and infra. Read it, then drill into the desk (Doc 3), IRESS adapter (Doc 4), worker (Doc 5), and deployment/cutover (Doc 11).*
