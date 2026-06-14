# MINT OEMS — Status & Charles Ask (2026-06-14)

Single source of truth for: what's live, what we still wire ourselves, what's
blocked on IRESS (Charles), and what needs a vendor. Verified against the live
production worker (`/debug/iress-methods`) and the V4 docs.

---

## ✅ LIVE in production (real data, verified)
| Surface | Source |
|---|---|
| Cockpit Top Movers · Security watchlist · Security intraday | Retail `securities_c` / `stock_intraday_c` (Yahoo today → IRESS once price cut-over lands) |
| News & SENS page (Wires tab) | Retail `News_articles` (Alliance News wire, ~4,800 rows) |
| Integration / worker health | Institutional `integration_worker_health` |
| IRESS session + equity quotes | `IRESSSessionStart` + `PricingQuoteGet` (working) |

## 🟢 LEFT TO WIRE — us, no IRESS/vendor needed (data + routes ready)
| Panel | Source | Note |
|---|---|---|
| Equities page → full 246 universe | `/api/equities` | currently the 10-name stub |
| Cockpit Sector Heatmap | `/api/equities` (computed, mkt-cap-wtd) | a *proxy* from constituents (not official J2xx) |
| Cockpit Top Movers → 246 + fix `+/-` sign | `/api/equities` | currently 7 names; sign bug between ticker & panel |
| Security fundamentals (P/E, EPS, ISIN, beta) | `securities_c` | panel says "vendor required" but data exists |
| Platform AUM / Day P&L | client book (`stock_holdings_c`, `client_strategy_returns_c`) | small book today (31 holdings) — real |
| Strategies page (optional) | retail `strategies_c` (9 model portfolios) | |

## 🔴 BLOCKED on IRESS — the concise CHARLES ASK (priority order)
1. **Service sessions (IOS+, IPS, FIX+).** `ServiceSessionStart` → HTTP 500 for all three. We send the documented `Server` names (`IOSPLUSAPI` / `IPSAPI` / `FIXPLUSAPI`). **Confirm they're entitled on `DFM@Mint` + the correct Server identifiers.** → unlocks **orders, blotter, portfolio (AUM/P&L/positions), bookings, FIX+.**
2. **TimeSeriesGet2.** Every request rejected (`Invalid Parameter Value: <n> as Frequency`). We tried the **documented `<Interval>Daily</Interval>` string AND `<Frequency>` integers** — all rejected, so the live WSDL differs from the published docs. **Confirm entitlement + send the live WSDL or one working request/response.** → unlocks **ZAR curves, ALSI / J203 index, sector indices, money-market (JIBAR), macro.**
3. **Trading account code(s).** Confirm the production account code(s) for `OrderPadGetByAccount` / IPS.
4. **PricingQuoteGet coverage.** Confirm the full JSE board + ETFs (Satrix/Sygnia) are entitled.
5. **L2 depth / time-&-sales.** Is `PricingQuoteExGet` (or another method) available in V4 for L2/depth? (We'll wire it — just need confirmation + the WSDL shape.)

*Working today: `IRESSSessionStart` + `PricingQuoteGet`. Items 1 & 2 unlock the majority of the desk.*

## 🟡 BLOCKED on VENDOR (not IRESS)
| Surface | Needs |
|---|---|
| SENS regulatory tape | JSE SENS Web Feed subscription |
| Macro Pulse | SARB / StatsSA / macro provider (or `TimeSeriesGet2` if IRESS entitles it) |
| Additional news wires | Reuters / Bloomberg (Alliance News already covers the wire tab) |

---

**Re-run `GET https://iress-worker-production.up.railway.app/debug/iress-methods`
after Charles changes anything — the matrix updates live, confirming the fix
with zero ambiguity.**
