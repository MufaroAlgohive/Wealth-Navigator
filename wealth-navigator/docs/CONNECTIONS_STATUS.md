# Connections & integration status

A board of every external connection the platform uses — what it powers, whether
it's working, and what's blocked. Pairs with [DATA_SOURCE_MAP.md](./DATA_SOURCE_MAP.md)
(per-page data sources) and [IRESS_ISSUES_FOR_ANDRE.md](./IRESS_ISSUES_FOR_ANDRE.md)
(the open IRESS items in detail).

Last verified: 2026-06-22.

**How to read this**
- ✅ **Working** — connected and returning real data (verified).
- ⚠️ **Partial / unverified** — connected but some feeds blocked, or not verifiable from here.
- ⛔ **Not connected** — not wired / credentials absent / deferred.
- **Local vs prod:** the Vercel app reads Supabase + public APIs directly and is verified here. **IRESS is only reached by the Railway worker, which does not run locally** — so all IRESS-fed data is seed/empty on a dev machine and only live in production. IRESS production status below is from the integration code + IRESS's own confirmations (15–16 Jun), not a live-worker check from this environment.

---

## At a glance

| Connection | Type | Status | Powers | Verified |
|---|---|---|---|---|
| Supabase **RETAIL** (`mfxng`) | Database | ✅ Working | Securities universe, fundamentals, holdings, strategies, clients/KYC, news wire | Yes — 246 securities, 9 strategies, news |
| Supabase **INSTITUTIONAL** (`nnwz`) | Database | ✅ Working | OEMS book, order audit, curves, bonds, indices, worker health | Yes — quote snapshots, 18 orders |
| **IRESS V4** (CT, `DFM@Mint`) | Market data / orders | ⚠️ Partial (prod) | Live quotes, bonds, curves, order mirror | Prod-only (see below) |
| **Railway worker** (`iress-ingest`) | IRESS bridge | ⚠️ Prod-only | The only process that talks to IRESS → writes Supabase | Not running locally |
| **Yahoo Finance** | Market data (fallback) | ✅ Working | Fundamentals (mkt cap/PE/div/YTD) + AI-research financials & news | Yes |
| **Tavily** | Web search | ✅ Working | AI-research live web research | Yes — key set, returns results |
| **MiniMax-M3** | LLM | ✅ Working | AI-research synthesis | Yes — live calls succeed |
| **SARB** | Public API | ✅ Working | Repo/prime/ZARONIA + macro rates | Yes |
| **ECB / Frankfurter** | Public API | ✅ Working | FX spot (USD/ZAR etc.) | Yes |
| **RSS** (Moneyweb, BusinessTech) | News feed | ✅ Working | News/SENS tape (general wire) | Yes |
| **Supabase Auth** | Auth | ✅ Working | Login / sessions | Yes |
| **Anthropic / Claude** | LLM (alt) | ⛔ Not active | AI-research swap-in for MiniMax | Key not set |
| **Resend** | Email | ⛔ Not wired | Marketing campaigns + transactional sends | Sends deferred |
| **SumSub** | KYC | ⛔ Not configured | Client KYC review | "Credentials not configured" |

---

## Working (verified)

- **Supabase RETAIL (`mfxng`)** and **INSTITUTIONAL (`nnwz`)** — both connected and serving real data. Retail: 246 securities, 9 strategies, client book, news. Institutional: live quote snapshots, 18 order-audit rows.
  - One gap: the AI-research cache table `ai_research_cache_c` is **not yet created** on `nnwz` → research caching runs in-memory per-instance until the migration is applied.
- **Yahoo, Tavily, MiniMax-M3** — power the AI Research feature; all three verified live (real financials + web sources + model output).
- **SARB, ECB/Frankfurter, RSS** — public feeds for rates, FX and news; all returning data.

## ⚠️ IRESS — partial (production only)

IRESS is reached **only** by the Railway worker (single CT licence seat); the web
app reads what the worker writes into Supabase. Status of each IRESS feed:

**Working in production** (confirmed with IRESS, 15–16 Jun):
- Equity quotes — `PricingQuoteGet`, `JSE`/`JSED` (10-name watchlist live)
- Bonds + ZAR yield curves — `TimeSeriesGet2`, `YFX`/`YFXD`
- Order mirror (read-only) — `OrderPadGetByAccount`, IOS+, account 56378

**Blocked / open** (see [IRESS_ISSUES_FOR_ANDRE.md](./IRESS_ISSUES_FOR_ANDRE.md) for the data + asks):
- JSE index levels — J203 (ALSI), J200 (Top 40), sector indices → resolve but return no data
- FX spot (USD/ZAR) — no usable IRESS code (using ECB instead)
- Money market — JIBAR / ZARONIA / Prime / Repo → no codes / placeholder series
- Fundamentals — no `SecurityGet` method/entitlement (using Yahoo instead)
- Equity price history (1M/6M/YTD returns) — JSE daily history unconfirmed
- L2 depth / time-&-sales — method/entitlement unconfirmed
- News / SENS — no IRESS path (using RSS / needs a vendor)
- CT vs production endpoint + licence-seat handling — to confirm

**Operational note:** the full-universe retail price + **day-move** (`change_percent`)
loop in the worker is built but **dormant** — that's why the heatmap/sector
day-moves read flat. Turning it on needs no IRESS entitlement: a migration + two
worker env vars + a redeploy.

## ⛔ Not connected yet

- **Anthropic / Claude** — wired as a swap-in AI provider but no key set; MiniMax-M3 is the active model.
- **Resend (email)** — marketing-campaign + transactional sends are deferred (no live blast).
- **SumSub (KYC)** — client KYC review shows "credentials not configured"; needs SumSub keys.

---

## Environment flags that change behaviour

| Flag | Effect | Notes |
|---|---|---|
| `NEXT_PUBLIC_USE_SUPABASE_QUOTES` | UI real-data mode | Now **defaults to real-data-only**; mock via `?mock=1` |
| `USE_SUPABASE_QUOTES` | BFF reads Supabase vs seed | Set in production |
| `IRESS_WORKER_URL` / `RAILWAY_SERVICE_URL` | Worker passthrough (live orders, history, health) | If unset → those routes return 503 / honest-empty |
| `IRESS_RETAIL_INGEST=1` + `IRESS_RETAIL_DRY_RUN=0` | Full-universe IRESS price + day-move | The dormant loop above |
| `TAVILY_API_KEY` / `tavily_key` | AI-research web search | Code reads both casings |
| `MINIMAX_API_KEY` | AI-research model | Active |

---

## Bottom line

Databases, Yahoo, Tavily, MiniMax, and the public APIs (SARB/ECB/RSS) are
**connected and working**. The web app itself has no broken connections. The open
work is concentrated in **IRESS** (entitlements/codes from Charles + the technical
items for Andre, and standing up the production worker), plus three
not-yet-connected services (Claude key, Resend, SumSub) that are deferred by
design.
