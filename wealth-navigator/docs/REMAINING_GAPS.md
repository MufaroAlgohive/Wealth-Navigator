# Remaining Data Gaps — Real Data Mandate

Last updated: 2026-06-12. Production policy: `USE_SUPABASE_QUOTES=true` + `NEXT_PUBLIC_USE_SUPABASE_QUOTES=true` → **no seed/mock prices in UI**. Empty states show `Data feed not configured`.

## Wired in this session

| Surface | Source | Route/API |
|---------|--------|-----------|
| Watchlist / movers prices | `stock_intraday_c` + Realtime | `/api/quotes`, `useLiveQuotes` |
| Tick SSE / random walk | Disabled in prod | `/api/ticks` → 503 |
| Missing quote (e.g. BHG hollow CT row) | `—` not seed 528 | `NumberCell`, `live-queries` `unavailable` |
| Open orders (cockpit + blotter) | `oems_order_audit` | `/api/orders` |
| Integration worker status | `integration_worker_health` | `/api/worker-health` |
| Instrument metadata | `securities_c` | joined in `/api/quotes` |

## Requires IRESS entitlement (Charles / CT)

| Surface | IRESS V4 method | Notes |
|---------|-----------------|-------|
| Sector heatmap | `PricingQuoteGet` on J200 / sector index codes | Need symbol list + entitlement |
| ALSI intraday | `TimeSeriesGet2` on J203 | Index time series |
| ZAR govi / swap curves | `TimeSeriesGet2` | Curve codes TBD with IRESS |
| JIBAR / USDZAR KPIs | `PricingQuoteGet` | Add symbols to worker watchlist |
| FX crosses (EURZAR, etc.) | `PricingQuoteGet` | Worker watchlist expansion |
| Live orders (if audit empty) | `OrderPadGetByAccount` | Worker needs `IRESS_ACCOUNT_CODE`, writes enabled |
| Depth L2 | TBD | No V4 method wired |
| Time & sales | TBD | No V4 method wired |

## Requires external vendor / portfolio system

| Surface | Vendor / system | Notes |
|---------|-----------------|-------|
| SENS announcements | JSE SENS / Refinitiv / etc. | No IRESS method in adapter |
| News flow | Bloomberg / Refinitiv / IRESS news | Not in current V4 surface |
| Macro pulse (CPI, PMI, etc.) | Macro data vendor | Not in IRESS mock surface |
| Platform AUM / Day P&L | Portfolio / accounting system | Strategies are seed-only |
| PCA curve decomposition | Derived from live curve | Blocked on curve feed |
| Persona pages (`/wm`, `/strategist`, `/admin`, `/business`, `/fc`) | CRM / ops systems | All seed placeholders |
| Fundamentals on security page | Ref data vendor | Hardcoded today |
| Fixed income / money market / curves pages | IRESS + index vendors | Seed-only UI |

## Timeline estimate for 100% real

| Phase | Scope | Effort | Dependency |
|-------|-------|--------|------------|
| **Now** | Quotes for 10-symbol watchlist | Done | Railway worker LIVE + Supabase |
| **Week 1** | Orders in audit, worker health visible | Done (UI); worker writes need `SUPABASE_ALLOW_WRITES=1` | Account code from Charles |
| **Week 2** | Index + FX + JIBAR on worker watchlist | 2–3 days eng | IRESS symbol entitlement |
| **Week 3** | Sector indices + ALSI intraday | 3–5 days eng | `TimeSeriesGet2` entitlement |
| **Week 4+** | SENS, news, macro | Vendor selection + contract | External feed budget |
| **Week 6+** | AUM/P&L, personas, fundamentals | Portfolio system integration | Business systems |

**100% real across every panel**: unlikely before **8–12 weeks** without parallel vendor onboarding; **quotes + orders + worker health** can be production-honest within **1–2 weeks** once Railway worker runs LIVE writes and Charles confirms BHG/sector entitlements.

## Charles / vendor action items

1. Confirm `BHG` board / quotation basis — CT returns hollow row today.
2. Provide sector index codes for JSE heatmap.
3. Confirm `OrderPadGetByAccount` account code for worker poll.
4. Advise on SENS/news — IRESS path vs third-party.
5. Entitlement check for `TimeSeriesGet2` on J203 and ZAR curve codes.

See also: `docs/DATA_PROVENANCE.md`, `docs/MINT_GO_LIVE_RUNBOOK.html`.
