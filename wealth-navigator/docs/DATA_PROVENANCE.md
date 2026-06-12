# Data Provenance — Mint Wealth Navigator OEMS

Living inventory of every data surface: what is **real IRESS**, what is **seed/mock**, and what is **hybrid**.

> Machine-readable source: `src/lib/iress/provenance.ts` · API: `GET /api/iress/provenance`  
> **Remaining gaps:** `docs/REMAINING_GAPS.md`

## Real-data policy (2026-06-12)

When `USE_SUPABASE_QUOTES=true` and `NEXT_PUBLIC_USE_SUPABASE_QUOTES=true` (Vercel production):

- **Never** render seed/mock prices — `NumberCell` shows `—` when no Supabase tick exists.
- `/api/ticks` SSE and client random walk are **disabled**; quotes come from `/api/quotes` + Realtime only.
- Missing symbols (e.g. BHG hollow CT row) return `source: "unavailable"`, not `seed-fallback`.
- Panels without a live feed show `EmptyDataState` with "Data feed not configured".
- Orders read from `oems_order_audit` via `GET /api/orders`; worker health from `GET /api/worker-health`.

Local dev without the flags still uses mock adapter + seed for UI building.

## Summary (v2.0 live E2E)

| Status | Count | Meaning |
|--------|------:|---------|
| **LIVE** | 2 | Server routes hitting real IRESS SOAP |
| **HYBRID** | 8 | Mix of live API + tick stream + seed fallback |
| **SEED** | 28 | Deterministic `seed.ts` / synthetic UI |
| **MOCK** | 3 | In-process `mock.ts` (orders, blotter mutations) |
| **PENDING** | 0 | No V4 verb known yet |

## Legend

| Status | Badge | Description |
|--------|-------|-------------|
| LIVE | green | Data from IRESS CT/prod SOAP |
| SUPABASE | info | Worker snapshot in `stock_intraday_c` (BFF or Realtime) |
| HYBRID | blue | Live where possible; seed/sim fallback |
| SEED | amber | Static seed or synthetic generation |
| MOCK | muted | In-process mock adapter |
| PENDING | — | No V4 method identified |

---

## Chrome vs panel provenance

Global chrome and per-panel badges answer different questions:

| Surface | What it shows | Driven by |
|---------|---------------|-----------|
| **Ticker bar** (top strip) | `SUPABASE` / `STREAM` / `MOCK` / `STALE` | Tick feed kind from `useQuoteFeedKind()` — set when BFF seeds ticks (`supabase`), SSE `/api/ticks` pushes (`stream`), or seed sim only (`mock`). Stale when last tick &gt; 20 s. |
| **Cockpit masthead** | `DataSourceBadge` on the page header | `useLiveQuotes` → `deriveDataSource()` from `/api/quotes` (when `NEXT_PUBLIC_USE_SUPABASE_QUOTES=true`) or `/api/iress/quotes` (local live only). |
| **Panel title row** | `DataSourceBadge` per panel | Explicit `dataSource` prop — e.g. movers panel uses quote provenance; sector heatmap / open orders stay `seed`. |

Production (Vercel): `IRESS_MODE=mock`, `USE_SUPABASE_QUOTES=true`, `NEXT_PUBLIC_USE_SUPABASE_QUOTES=true`. The Railway worker writes snapshots; the UI polls `/api/quotes` every ~15 s and optionally subscribes to `stock_intraday_c` INSERT for sub-second updates. Display-only sparkline jitter does **not** write to the database and does not run for Supabase-protected symbols.

---

## Cockpit (`/oems`)

| Surface | Route/Component | Current source | Live via IRESS? | V4 method | Status |
|---------|-----------------|----------------|-----------------|-----------|--------|
| KPIs (AUM, P&L) | cockpit-client | seed → oemsStrategies | No | — | SEED |
| Sector heatmap | SectorHeatmap | seed → sectorHeatmap | Yes | PricingQuoteGet | SEED |
| ZAR govi curve | cockpit-client | seed → zarGoviCurve | Yes | TimeSeriesGet2 | SEED |
| Top movers | cockpit-client + NumberCell | `/api/quotes` (Supabase) or `/api/iress/quotes` (local live) + tick store | Worker / Yes | PricingQuoteGet | SUPABASE / HYBRID |
| ALSI intraday | cockpit-client | seed + synthetic | Yes | TimeSeriesGet2 | SEED |
| Open orders | cockpit-client | mock → liveOrders | Yes* | OrderPadGetByAccount | SEED |
| SENS feed | cockpit-client | seed → sensFeed | No | — | SEED |
| News flow | cockpit-client | seed → newsFeed | No | — | SEED |
| Macro pulse | cockpit-client | seed → macroIndicators | No | — | SEED |
| JIBAR / USDZAR KPIs | KpiTile + NumberCell | seed + tick stream | Yes | PricingQuoteGet | HYBRID |
| Curve PCA | cockpit-client | hardcoded | No | — | SEED |

\* Needs `IRESS_ACCOUNT_CODE` for live orders.

## Blotter (`/oems/blotter`)

| Surface | Route/Component | Current source | Live via IRESS? | V4 method | Status |
|---------|-----------------|----------------|-----------------|-----------|--------|
| Orders table | blotter/page | mock → liveOrders | Yes* | OrderPadGetByAccount | SEED |
| New order | new-order-dialog | mock client | Yes | OrderCreate3 | MOCK |
| Cancel/amend | blotter/page | mock client | Yes | OrderDelete/Amend2 | MOCK |

## Security (`/oems/security`)

| Surface | Route/Component | Current source | Live via IRESS? | V4 method | Status |
|---------|-----------------|----------------|-----------------|-----------|--------|
| Quote header | security/page | `/api/iress/quotes` + tick | Yes | PricingQuoteGet | HYBRID |
| Intraday chart | SecurityChart | tick stream | Yes | PricingQuoteGetUpdates | HYBRID |
| Depth L2 | DepthLadder | synthetic | No | — | SEED |
| Time & sales | TimeAndSales | synthetic | No | — | SEED |
| Fundamentals | security/page | hardcoded | No | — | SEED |
| Watchlist | security/page | seed + live quotes | Yes | PricingQuoteGet | HYBRID |

## Other OEMS pages

| Surface | Route | Current source | V4 method | Status |
|---------|-------|----------------|-----------|--------|
| Equities universe | /oems/equities | seed | PricingQuoteGet | SEED |
| Strategies + holdings | /oems/strategies | seed | — | SEED |
| Fixed income bonds | /oems/fixed-income | seed | PricingQuoteGet | SEED |
| Money market | /oems/money-market | seed | TimeSeriesGet2 | SEED |
| Curves | /oems/curves | seed | TimeSeriesGet2 | SEED |
| Macro | /oems/macro | seed | — | SEED |
| News + SENS | /oems/news | seed | — | SEED |
| Integration health | /oems/integration | seed + `/api/iress/health` | IRESSSessionStart | HYBRID |

## Infrastructure

| Surface | Route | Current source | V4 method | Status |
|---------|-------|----------------|-----------|--------|
| Tick stream SSE | /api/ticks | local sim / live updates | PricingQuoteGetUpdates | HYBRID |
| IRESS health | /api/iress/health | session-manager | IRESSSessionStart | LIVE |
| Live quotes API | /api/iress/quotes | live-queries | PricingQuoteGet | LIVE |
| Session status | /api/iress/session | session-manager | IRESSSessionStart | LIVE |
| BFF quotes (DB-first) | /api/quotes | `fetchQuotesSafe` w/ `USE_SUPABASE_QUOTES=true` reads `stock_intraday_c`; else proxies to `live-queries` | PricingQuoteGet (worker) | HYBRID |

## Persona placeholders (all SEED)

| Persona | Route |
|---------|-------|
| Strategist | /strategist |
| Wealth manager | /wm |
| Admin | /admin |
| Business | /business |
| Funeral cover | /fc |

---

## IRESS CT connectivity notes

If SOAP to `https://webservices-ct.iress.co.za/v4` fails (network, auth, WSDL entitlement), the app:

1. Logs the exact error server-side
2. Falls back to `seed-fallback` in `/api/iress/quotes`
3. Shows **SEED** or **HYBRID** badges — never pretends data is live
4. Documents the error in this file (update after verification runs)

### Last verification (2026-06-11)

```
Login:       OK — mint-auth cookie set
Health:      FAIL — soap:Receiver - Error: Login failed. Unknown client/user/password combination.
Quotes NPN:  OK — source=seed-fallback last=4180.55 (live=0 fallback=1)
```

IRESS CT rejected `DFM@Mint` / `123` on `webservices-ct.iress.co.za`. The app gracefully
falls back to seed data and shows **SEED/HYBRID** badges — never pretends quotes are live.

### CT quote row shapes (2026-06-12)

IRESS CT `PricingQuoteGet` returns **two row shapes** for JSE watchlist names:

| Shape | Example | Price fields | Scaling |
|-------|---------|--------------|---------|
| Bare `Last` | NPN | `Last=610` (ZAR) | None |
| `*Price` cents | FSR, MTN, SBK, AGL, BHG | `LastPrice`, `OpenPrice`, `PreviousClosePrice` | ÷100 when integer cents detected |

**AGL (~R1,200):** CT returns internally consistent prices via `LastPrice`/`OpenPrice`/`TotalValue÷TotalVolume` VWAP (~R1,200). This is **not** seed reference (~R552) and is **not** forced to seed — the mapper reflects CT feed as-is. Confirm board / `QuotationBasisCode` with Charles if seed parity is expected.

**BHG (~R528):** CT can send a **hollow** row — `LastPrice=PreviousClosePrice=2445` with zero Open/High/Low/Bid/Ask/Volume (no OHLC cents cluster). Mapper skips the write (`last=0`) rather than persisting R2445. Confirm `Board` / `QuotationBasisCode` / symbol entitlement with Charles.
