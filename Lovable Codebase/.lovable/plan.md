# Mint OEMS v2 — Institutional Cockpit

Rebuild the OEMS surface on top of the IRESS API spec we just shipped. Goal: a single, Bloomberg-grade operating environment for the desk — dense, fast, calm, with charts, tables, tickers, depth, curves, news and order workflow co-located.

## Design language

- Dark-first "trading desk" theme (toggle to light). Deep navy `#0B1020` background, `#0F1730` panels, hairline borders `#1C2747`, electric blue primary `#3B82F6`, semantic green/red for tick direction, amber for warnings.
- Type: Inter for UI, JetBrains Mono for all numerics (tabular-nums, fixed decimals).
- Information density: 12px base in tables, no card chrome inside data panels, sticky headers, zebra off, row hover highlight, flash-green/flash-red on price tick (200ms).
- Layout: resizable panels (`react-resizable-panels`, already installed), saved layouts per user, keyboard-first (`/` focus search, `g d` go dashboard, `g e` equities, etc.).
- Every numeric cell shows `value · Δ · Δ%` with arrow glyph; every timestamp is `HH:MM:SS.mmm` with stale-data pill if >SLA.

## Information architecture

Sidebar (OEMS section), each route is a full workspace:

1. **Cockpit** (`/oems`) — unified landing
2. **Blotter & Orders** (`/oems/blotter`) — order/trade/exec management
3. **Strategies** (`/oems/strategies`) — strategy → investor linkage, rebalance gate
4. **Equities** (`/oems/equities`)
5. **Fixed Income** (`/oems/fixed-income`)
6. **Money Market** (`/oems/money-market`)
7. **Curves & Rates** (`/oems/curves`)
8. **Macro** (`/oems/macro`)
9. **News & SENS** (`/oems/news`)
10. **Security Lookup** (`/oems/security/:isin`)
11. **Integration Health** (`/oems/integration`) — IRESS endpoint status, last-seq, latency

Global chrome on every OEMS page:
- **Top ticker bar** (sticky): JSE Top40, ALSI, ALBI, USDZAR, EURZAR, Brent, Gold, R2030, R2035, JIBAR 3M, ZARONIA — horizontal scroll, live tick flash.
- **Command palette** (`⌘K`): jump to ISIN/ticker/strategy/order.
- **Connection pill**: WebSocket status, message lag, last-seq cursor.

## Cockpit (landing) layout

Resizable 12-col grid, 3 rows:

```text
+-----------------------------------------------------------+
| TICKER BAR (sticky)                                       |
+-----------------+-----------------+-----------------------+
| Market heat-map | ZAR yield curve | Top movers (JSE)      |
| (treemap, sec)  | (NSS, 3 tenors  | (sortable, sparkline) |
|                 |  overlay)       |                       |
+-----------------+-----------------+-----------------------+
| FX & Rates panel| Strategy P&L    | SENS feed (live)      |
| (USDZAR chart + | (intraday, by   | (issuer · time · tag) |
|  JIBAR/ZARONIA) |  strategy)      |                       |
+-----------------+-----------------+-----------------------+
| Open orders blotter (live, filterable) | Alerts & breaches|
+-----------------------------------------------------------+
```

Every tile has: title, last-update timestamp, expand-to-full button, source endpoint tooltip (maps to IRESS endpoint from the spec).

## Tab-by-tab specifications

### Blotter & Orders
- Tabs: Working · Filled · Cancelled · Rejected · Allocations
- Columns: time, strategy, side, ISIN, qty, limit, last, fill %, VWAP, slippage bps, venue, trader, state.
- Row click → side drawer with child orders, fills timeline, FIX message log.
- New-order ticket (modal): security search → live L1/L2 depth ladder → qty/price/TIF → pre-trade checks (mandate, cash, concentration) → route.
- Bulk actions: cancel-all, replace-price, pause strategy.

### Strategies
- Grid of strategy cards: AUM, NAV, MTD/YTD, # investors, drift vs model, last rebalance, **Rebalance** button (disabled until ≥1 investor linked — keep existing gate).
- Detail page: holdings table, target vs actual weights bar, attribution waterfall, linked investors list, rebalance simulator (paper run before commit).
- Money Market strategy variant: WAM, WAL, credit breakdown (donut), liquidity ladder.

### Equities
- Left: watchlist (sectors, indices, custom). Middle: chart (candles + volume, indicator dropdown: SMA/EMA/VWAP/Bollinger/RSI). Right: L2 depth ladder (bids/asks, cumulative, imbalance bar) + Time & Sales tape.
- Below chart: fundamentals strip (P/E, EV/EBITDA, div yield, mkt cap, 52w hi/lo, ADV), corp actions timeline, broker consensus.

### Fixed Income
- Bond screener: ISIN, issuer, coupon, maturity, YTM, clean, dirty, MD, DV01, convexity, rating, spread to curve.
- Selected bond: price/yield chart, cashflow ladder, key-rate-duration bars, sensitivity table (±25/50/100bps).
- Curve overlay panel: ZAR govi vs swap vs ILB.

### Money Market
- JIBAR (1M/3M/6M/12M) + ZARONIA tiles with intraday chart.
- NCD/treasury bill rate matrix (issuer × tenor heat-map).
- Repo & FRA strip, SARB MPC countdown widget.

### Curves & Rates
- NSS-fitted ZAR curve (today vs 1D vs 1W vs 1M overlay), draggable cursor reads tenor/yield.
- Curve change waterfall (level/slope/curvature decomposition).
- Real vs nominal (breakeven inflation curve).

### Macro
- Calendar table (SARB, StatsSA, Fed, ECB) with consensus/actual/prior, surprise index.
- Series explorer: CPI, GDP, PPI, unemployment — chart + YoY/MoM toggle.
- Global macro tiles: US10Y, DXY, Brent, Gold, BTC, EM FX basket.

### News & SENS
- Three-column: filters (issuer, tag, severity) · headline list (live append, flash on new) · reader pane with full body, linked ISIN chip, sentiment tag.
- "Pin to cockpit" action; "Create alert" from any headline.

### Security Lookup (`/oems/security/:isin`)
- Universal terminal page — auto-detects asset class and renders the relevant blocks above. This is the `GO` page.

### Integration Health
- Already exists — extend with per-endpoint table from the spec: endpoint, status (green/amber/red), p50/p95 latency, last-seq, messages/sec, last error. Replay-from-seq button.

## Data & state

- Single `useOEMSStream` hook stubs WebSocket: emits ticks into a Zustand store keyed by ISIN. All tiles subscribe via selectors so only changed cells re-render (avoids whole-grid repaint).
- Mock data generator in `src/lib/oemsData.ts` extended to: synthesize realistic ZAR curve (NSS), 50 equities with intraday paths, 30 bonds, JIBAR/ZARONIA fixings, rolling SENS headlines, macro calendar.
- Every panel tagged with `sourceEndpoint` prop → tooltip reveals IRESS endpoint from the v1.0 spec → keeps doc and UI in lock-step.

## Technical bits

- New deps: none required (recharts ✓, resizable-panels ✓, lucide ✓). Add `zustand` for the tick store.
- New files (high level):
  - `src/lib/oemsStore.ts` — Zustand tick store + selectors
  - `src/lib/oemsStream.ts` — mock WS generator (tick, depth, news, fixings)
  - `src/lib/oemsMock/{curves,bonds,equities,macro,sens}.ts`
  - `src/components/oems/` — `TickerBar`, `PriceCell`, `DepthLadder`, `TimeAndSales`, `Sparkline`, `CurveChart`, `Heatmap`, `SensFeed`, `OrderTicket`, `BlotterTable`, `PanelFrame`, `EndpointTag`, `CommandPalette`, `ConnectionPill`.
  - `src/pages/oems/` — extend with `OEMSBlotter`, `OEMSStrategies`, `OEMSFixedIncome`, `OEMSCurves`, `OEMSSecurity`, refactor existing pages onto `PanelFrame`.
  - `src/components/RoleRouter.tsx` — add new routes.
  - `src/index.css` — add trading-desk tokens (tick flash keyframes, mono font, dense table utility).

## Out of scope (call out)

- Real IRESS wiring — stubbed; spec already delivered to vendor.
- Auth/permissions per desk — uses existing role context.
- Persistence of user layouts — local state only in v2 (can add Cloud later).

## Deliverable

A coherent, dense, fast OEMS that visibly exercises every domain in the IRESS spec (equities, FI, MM, curves, macro, SENS, integration), so the UI/UX is reviewable end-to-end before the data pipes go live.
