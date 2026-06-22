# Data Source Map

Where every dashboard panel gets its data, which database it lives in, and how
the source/database badges on each panel are wired. Read this before touching
anything that displays a number — the rule is **real data, an honest empty
state, or a clearly-labelled mock; never a fabricated value dressed up as real.**

Last verified: 2026-06-21 (full scan of all 38 pages + 55 API routes).

---

## 1. The rule

Every data-bearing panel falls into one of four buckets. The first three are
fine; the fourth is a bug.

| Bucket | Meaning | Allowed? |
|---|---|---|
| **Real** | Pulled from a Supabase `_c` table, IRESS (via the worker), Yahoo, or an external API (SARB, ECB, RSS, Tavily). | Yes |
| **Honest-empty** | Renders `—`, `EmptyDataState`, "not configured", or an entitlement notice. No fake numbers. | Yes |
| **Gated mock** | Seed/demo data shown only behind a mock gate (`realDataOnly`, `IRESS_MODE=mock`, `USE_SUPABASE_QUOTES=false`) **and** labelled `MOCK`/`SEED`. | Dev only |
| **Fabricated** | Hardcoded / `Math.random` values rendered as if real, not gated, not labelled. | **No — fix it** |

See section 7 for the current list of bucket-4 offenders.

---

## 2. Architecture / data flow

There is exactly **one IRESS CT licence seat**. The Vercel app never calls IRESS
directly — a single Railway worker (`workers/iress-ingest`) holds the seat,
polls IRESS, and writes the results into Supabase. The web app only ever reads
Supabase (plus a few public external APIs).

```
IRESS V4 (CT seat)
  └─ workers/iress-ingest (Railway, the only IRESS client)
       ├─ quotes loop      → securities_c.last_price, stock_intraday_c (retail)
       │                     quote_snapshot_c (institutional, full L1)
       ├─ retail-ingest    → securities_c.{last_price, change_percent, price_source} (DORMANT)
       └─ timeseries/bonds → yield_curve_history_c, oems_curve_metric_c, bonds_c,
                             index_intraday_c, sector_intraday_c (institutional)

Yahoo Finance
  └─ /api/cron/yahoo-fundamentals → securities_c.{market_cap, pe_ratio, dividend_*, ytd_performance} (retail)
       (NEVER writes last_price/change_percent — IRESS owns those)

External (read live, no DB): SARB (rates), Frankfurter/ECB (FX), RSS (news), Tavily (AI research web)

Vercel app:  page → /api/* (BFF) → Supabase _c tables / external API → render
```

Key gates (env):
- `IRESS_MODE` — `live`/`wsdl-stub` = real SOAP (worker only); anything else = mock. Vercel runs `mock`; only the worker runs `live`.
- `USE_SUPABASE_QUOTES` — BFF reads quotes/curves/indices from Supabase vs in-process IRESS.
- `IRESS_RETAIL_INGEST=1` + `IRESS_RETAIL_DRY_RUN=0` — turns the full-universe retail price/day-move loop on (currently off → see §6).
- `NEXT_PUBLIC_USE_SUPABASE_QUOTES` — client real-data gate (`src/lib/data-policy.ts`). Defaults to **real-data-only** when unset; mock is an explicit opt-in (`=0`/`false`, or `?mock=1` with a DEV·MOCK banner). This is what keeps seed/fixture branches from rendering as if real — see §7.

---

## 3. The two databases

| | RETAIL (`mfxng…`) | INSTITUTIONAL (`nnwz…`) |
|---|---|---|
| Client | `createRetailServiceRoleClient()` | `createInstitutionalServiceRoleClient()` / `createServiceRoleClient()` |
| What | LIVE retail platform + the shared price tables | OEMS desk trading book + desk analytics |
| Price tables | `securities_c` (universe + Yahoo fundamentals + IRESS price overlay), `stock_intraday_c` | `quote_snapshot_c` (IRESS full L1), `index_intraday_c`, `sector_intraday_c` |
| Curves/FI | — | `yield_curve_history_c`, `oems_curve_metric_c`, `bonds_c` |
| Books | `stock_holdings_c`, `strategies_c`, `client_strategy_returns_c`, `profiles`, KYC, `wallets` | `oems_order_audit`, `oems_account_c`, `oems_position_c`, `oems_transaction_c` |
| Other | `News_articles` (Alliance wire), `email_*`, `app_settings` | `macro_*`, `money_market_*`, `jibar_fixing_c`, `news_item_c`, `integration_worker_health` |

`securities_c` and `stock_intraday_c` exist in **both** DBs with different shapes.
The app's price reads hit the **retail** copy; the IRESS overlay is read from the
**institutional** `quote_snapshot_c` and merged by `symbol` (the row ids differ
per project). Legacy single `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` resolves
to **institutional**.

---

## 4. The source badge

Defined in `src/components/oems/primitives/data-source-badge.tsx`, rendered by
`GlassSection` (`glass.tsx`). A panel sets two props:

- `db` — `"retail"` (chip `MFXNG`) or `"institutional"` (chip `NNWZ`). Omit for external feeds (SARB/ECB) that aren't in either DB.
- `dataSource` — a `DataSourceKind`: `iress | yahoo | external | supabase | live | seed | mock | hybrid | worker | stream | unconfigured | unavailable | blocked-external | blocked-vendor | code-gap`.

For panels whose source varies at runtime (the equities universe can be IRESS or
Yahoo per row), pass `dataSource={mapSource(data?.source, "<default>")}` —
`mapSource` (`src/lib/data-source.ts`) normalises a BFF's `source`/`price_source`
string into a kind. Static panels (curves are always IRESS, admin is always
Supabase) pass a literal kind. Entitlement/empty branches use `blocked-external` /
`blocked-vendor`, not the populated-state kind.

Everything reads `SEED`/`MOCK` on a local dev server (`IRESS_MODE=mock`, no
worker); the same panels resolve to `IRESS`/`YAHOO`/`SUPABASE`/`EXTERNAL` in
production where the worker + crons are running.

---

## 5. Per-module map

`db` · `source` per page. "(real)" = the production branch; mock branches are
gated + labelled.

### OEMS desk

| Page | Panel | Endpoint | DB | Source |
|---|---|---|---|---|
| Cockpit | AUM / Day P&L / Portfolio accounts | `/api/client-book` | retail | supabase |
| Cockpit | Open orders, blotter | `/api/orders` | institutional | supabase (IRESS order mirror) |
| Cockpit | Rates / FX tiles | `/api/sa-rates`, `/api/fx/*` | — | external (SARB, ECB) |
| Cockpit | Sector treemap, top movers, JSE heatmap | `/api/equities` | retail (+inst overlay) | iress / yahoo (runtime) |
| Cockpit | US heatmap / movers | `/api/global-movers` | — | yahoo |
| Cockpit | ZAR curve, curve-move PCA | `/api/curves/ZAR_NSS(/metrics)` | institutional | iress |
| Cockpit | J203 ALSI intraday | `/api/indices/J203` | institutional | blocked-external (TS2) |
| Cockpit | News flow | `/api/news` | retail | external (RSS + wire) |
| Cockpit | IPS accounts / positions | `/api/portfolio` | institutional | supabase |
| Equities | KPIs | `/api/portfolio` | institutional | supabase |
| Equities | Top movers, securities universe | `/api/equities` | retail (+inst) | iress / yahoo (runtime); 1M/6M cols TS2-blocked |
| Curves | all curve/PCA/OIS/carry panels | `/api/curves/*` | institutional | iress (seed/blocked when empty) |
| Fixed Income | bond screener, detail, P&L sensitivity | `/api/bonds` | institutional | iress (blocked-vendor when empty) |
| Fixed Income | ZAR govi history | `/api/curves/ZAR_GOVI` | institutional | blocked-external (TS2) |
| Money Market | SARB rates | `/api/sa-rates` | — | external |
| Money Market | JIBAR, instruments | `/api/money-market` | institutional | blocked-external (TS2) |
| Macro | indicators, releases | `/api/macro`, `/api/sa-rates` | institutional / — | supabase / external |
| News | tape (All/SENS/Wires) | `/api/news` | retail | external (RSS + wire); SENS = blocked-vendor |
| Security | key stats | `/api/quote-snapshot/[sym]` + `/api/equities` | institutional + retail | iress + yahoo |
| Security | intraday / history chart | `/api/intraday/[sym]`, `/api/history/[sym]` | retail / worker | iress; history TS2-blocked |
| Security | depth L2 / time & sales | — | — | unconfigured (gated mock locally) |
| Blotter | orders + state | `/api/orders`, `/api/orders/live` | institutional | supabase / iress |
| Integration | worker health, latency, IRESS status | `/api/worker-health` | institutional | worker heartbeat |
| Research Lab | composition / fundamentals | `/api/research-lab` | retail | supabase |
| Research Lab | AI Research | `/api/research-ai` | retail (+inst cache) | yahoo + tavily + MiniMax-M3 |

### Admin (all retail · supabase)

Dashboard, Clients, Order-book, Factsheets, Studio, Investors, EFT/Wallets,
Emailers, Team, App-settings, Cyber-compliance, Mint-mornings, Approvals — 34
routes, all read/write the **retail** DB. No IRESS/Yahoo. Real where the tables
are populated; honest-empty otherwise.

---

## 6. IRESS vs Yahoo — capability & gaps

IRESS is the source of truth. Yahoo is a fallback only where IRESS can't supply
yet. Curves and bonds were confirmed live on **Exchange=YFX, DataSource=YFXD**
(2026-06-16) — the older `DB_TOPOLOGY_DECISION.md` calling them blocked is stale.

| Feed | IRESS now | Fallback | To go IRESS-only |
|---|---|---|---|
| Live price, intraday, full L1, day-move | yes | Yahoo (uncovered syms) | flip retail-ingest (no entitlement) |
| ZAR curves, bonds | yes (YFX/YFXD) | seed | done |
| Orders (live + audit) | yes (worker) | — | — |
| Fundamentals (mkt cap, P/E, div) | no | Yahoo cron | Charles: `SecurityGet` entitlement |
| YTD / returns history | no | Yahoo | Charles: `TimeSeriesGet2` equity history |
| Index intraday (J203), sectors, money market | no (TS2 on JSE/JSED) | seed | Charles: TS2 + sector/index codes |
| News / SENS | no | RSS + Alliance wire | SENS vendor (or confirm IRESS path) |
| L2 depth / time & sales | no | — | `PricingQuoteExGet` entitlement / vendor |

**Day-move is flat in production** because the full-universe `retail-ingest` loop
(which computes `change_percent` from prev_close) is built but dormant. Turning
it on needs no entitlement: apply the `price_source` migration → set
`IRESS_RETAIL_INGEST=1` + `RETAIL_SUPABASE_URL` → shadow run → flip
`IRESS_RETAIL_DRY_RUN=0` → redeploy the worker.

---

## 7. Fabricated data — resolved (2026-06-21)

A full scan (all 38 pages + 55 routes) found the main desk + admin + BFFs clean.
Seven fabrications lived in the secondary persona portals + settings; all are now
fixed. The shared root cause was `isRealDataOnlyClient()` defaulting to NOT-real
when `NEXT_PUBLIC_USE_SUPABASE_QUOTES` was unset, so the demo/fixture branches
rendered under `SUPABASE`/`IRESS` badges.

| # | File | What it fabricated | Fix applied |
|---|---|---|---|
| 1 | `src/app/settings/page.tsx` | IRESS endpoint health (`Math.random` p95/status) — **ungated** | query gated `enabled: !realDataOnly`; real mode shows an honest note pointing to live worker health on the Integration page |
| 2 | `src/app/business/page.tsx` | named compliance breaches + sales pipeline | `PersonaRealDataGate` → honest "Not configured" by default (gate flip) |
| 3 | `src/app/compliance/page.tsx` | pending-approvals queue + audit trail | same — honest-empty by default |
| 4 | `src/app/fc/overview/page.tsx` | reconciliation legs / cash / exceptions | same — honest-empty by default |
| 5 | `src/app/wm/page.tsx` | client book (named clients, R250k withdrawal) | same — honest-empty by default |
| 6 | `src/app/strategist/page.tsx` | seed fixtures badged real | same — honest-empty by default |
| 7 | `src/app/admin/factsheets/page.tsx` | `cashWeight = 8` hardcoded | reads `app_settings.executionReserveRate` (defensive, falls back to 8) |

**The systemic fix** (`src/lib/data-policy.ts`): `isRealDataOnlyClient()` now
defaults to **true** (real-data-only) when the flag is unset, server- and
client-side identically. Mock/seed is an explicit opt-in (`=0`/`false` or
`?mock=1`). This makes all five persona pages render `PersonaRealDataGate`'s
honest "Not configured" state by default, and flips the whole app to real data /
honest-empty unless mock is deliberately requested. Verified live: `/wm` shows
"Not configured" (no fake clients); `/oems` cockpit renders real
`MFXNG·SUPABASE` / `NNWZ·IRESS` / `EXTERNAL` / honest `BLOCKED-EXTERNAL` /
`UNCONFIGURED`; `/settings` shows the honest worker-health note.

Remaining minor hygiene (gated mock, not fabrication): `depth-ladder.tsx` + the
time-&-sales panel use `Math.random` for a simulated order book — now only
reachable under an explicit `?mock=1` opt-in (the real branch is honest-empty).
An inline `SIMULATED` tag would be nice-to-have.

---

## 8. Page status — verified / pending / unverified (2026-06-21)

Checked page-by-page against the running dev server in **real-data-default mode
with no IRESS worker** — so worker-fed feeds are empty/seed locally and populate
in production. Method: every BFF endpoint probed for HTTP status / source / row
count, and every page client-rendered and checked for a crash.

**Nothing is broken** — every endpoint returns 200, every page renders without a
React error. The gaps below are "real path, no data here yet" (worker /
entitlement / admin auth), not failures.

Legend: ✓ real data · ◑ honest-empty, awaiting worker/entitlement/data · ⚠ unverified · ✗ broken (none found)

### OEMS desk — all render, no crashes

| Page | Endpoint(s) | Local data | Notes |
|---|---|---|---|
| Cockpit `/oems` | client-book, orders, equities, curves, indices, news, portfolio, sa-rates, fx | ✓ equities/orders(18)/news/rates · ◑ curves & J203 = seed · ◑ portfolio empty | curves are IRESS in prod, seed-fallback locally |
| Equities `/oems/equities` | `/api/equities`, `/api/portfolio` | ✓ 246 securities · ◑ portfolio empty | 1M/6M return cols pending TS2 |
| Curves `/oems/curves` | `/api/curves/*`, `/metrics` | ◑ seed (12 pts); metrics `unavailable` | IRESS-live in prod (YFX/YFXD) |
| Fixed Income `/oems/fixed-income` | `/api/bonds`, `/api/curves/ZAR_GOVI` | ◑ bonds empty (0); govi history TS2-blocked | IRESS-live in prod |
| Money Market `/oems/money-market` | `/api/money-market`, `/api/sa-rates` | ✓ SARB rates · ◑ instruments/JIBAR empty | TS2-blocked |
| Macro `/oems/macro` | `/api/macro`, `/api/sa-rates` | ✓ SARB · ◑ indicators empty | vendor table empty locally |
| News `/oems/news` | `/api/news` | ✓ RSS wire (5+) | SENS = vendor, not wired |
| Blotter `/oems/blotter` | `/api/orders`(`/live`) | ✓ 18 orders | live-orders = worker passthrough |
| Security `/oems/security` | quote-snapshot, intraday, history, equities | ✓ snapshot · ◑ intraday/history empty (no worker) | depth/T&S simulated only under `?mock=1` |
| Integration `/oems/integration` | `/api/worker-health` | ◑ no worker locally | live in prod |
| Research Lab `/oems/research-lab` | `/api/research-lab`, `/api/research-ai` | ✓ 9 strategies; AI works (MiniMax-M3) | |

### Portals & settings — all render

| Page | Endpoint(s) | Local data | Notes |
|---|---|---|---|
| Strategies `/strategies` | `/api/strategies` | ✓ 9 strategies (real) | the real `StrategiesMonitor` |
| WM / Strategist / FC / Business / Compliance | PersonaRealDataGate | ◑ honest "Not configured" by default | ⚠ headers show demo identities — see Unsure #4 |
| Settings `/settings` | `iress.config` + worker-health note | ✓ config real; health = honest note | |

### Admin — render, but data UNVERIFIED

All `/admin/*` pages (dashboard, clients, order-book, factsheets, emailers, team,
app-settings, investors, eft) render without crashing, but under the session used
here they show the **auth gate** — the admin BFFs require admin RBAC and returned
`no-session` (401) both headless and in-browser. ⚠ **Their data rendering needs an
authenticated admin session to verify — not checked.**

### Unsure / needs attention

1. **Admin page data** — unverified; needs an admin login (the RBAC gate blocked verification here).
2. **Worker-fed feeds** — live curves, intraday, history, portfolio/IPS accounts, money-market, J203 index, sectors are empty/seed locally because the Railway `iress-ingest` worker isn't running. **Unverified against a live worker**; expected to populate in production once the worker + entitlements are on.
3. **Curves / indices / sectors badges** — show `IRESS`/`blocked-external` (the *production* source), but locally without the worker the data is a **seed fallback**. The badge is prod-accurate, not local-accurate.
4. **Persona headers** — wm/strategist/fc/business/compliance data is honest-empty, but `PersonaHeader` still shows a **sample demo identity** from `PERSONA_USERS` (`src/lib/store/session-provider.ts`) — the persona-switcher demo. Product call: keep the demo personas or wire real auth identities. (Not financial data.)
5. **`/api/history`** — returns "Railway IRESS worker URL not configured" locally → honest-empty; needs `IRESS_WORKER_URL` set in production.
6. **SENS feed** — not configured; needs a vendor (or a confirmed IRESS news path).

### Not working

None found. Every endpoint returns 200; every page renders without a crash. The
empties are honest, expected states — not bugs.

## 9. Source-of-truth files

- Supabase clients + DB targeting: `src/lib/supabase/server.ts`
- Source kinds + badge: `src/components/oems/primitives/data-source-badge.tsx`
- Badge mapping helper: `src/lib/data-source.ts`
- Real-data gate (client): `src/lib/data-policy.ts`
- Quote routing / `deriveDataSource`: `src/lib/hooks/quote-routing.ts`
- IRESS adapter + mock: `src/lib/iress/`
- IRESS worker: `workers/iress-ingest/`
- Yahoo fundamentals cron: `src/app/api/cron/yahoo-fundamentals/route.ts`
- AI research (Yahoo + Tavily + MiniMax): `src/lib/research-ai/`
