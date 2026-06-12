# Data Provenance — Mint Wealth Navigator OEMS

Living inventory of every data surface: what is **real IRESS**, what is **seed/mock**, and what is **hybrid**.

> Machine-readable source: `src/lib/iress/provenance.ts` · API: `GET /api/iress/provenance`

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
| HYBRID | blue | Live where possible; seed/sim fallback |
| SEED | amber | Static seed or synthetic generation |
| MOCK | muted | In-process mock adapter |
| PENDING | — | No V4 method identified |

---

## Cockpit (`/oems`)

| Surface | Route/Component | Current source | Live via IRESS? | V4 method | Status |
|---------|-----------------|----------------|-----------------|-----------|--------|
| KPIs (AUM, P&L) | cockpit-client | seed → oemsStrategies | No | — | SEED |
| Sector heatmap | SectorHeatmap | seed → sectorHeatmap | Yes | PricingQuoteGet | SEED |
| ZAR govi curve | cockpit-client | seed → zarGoviCurve | Yes | TimeSeriesGet2 | SEED |
| Top movers | cockpit-client + NumberCell | seed + `/api/iress/quotes` | Yes | PricingQuoteGet | HYBRID |
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
