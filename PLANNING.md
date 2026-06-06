# MINT Wealth Navigator — Rebuild Plan (v2)

> **Mission:** Rebuild the Lovable prototype into a production-grade trading-desk + wealth platform using **Next.js 16 (App Router) + React 19 + Bun + TypeScript + Tailwind 4 + shadcn/ui**, designed for the **IRESS V4 Web Services** integration described in `Documentation & Vision/iress-v4-docs/` and the `Email` requirements manifest.
>
> The OEMS (Order & Execution Management System) trading desk is the **centerpiece**; the wealth-manager / funeral-cover / business / admin personas are **out of scope for v2.0** but the role system is preserved so we can light them up later without refactoring routing.

---

## 1 · What we are building

A single, multi-persona web application. The same `User` is shown the surfaces that are entitled for their role. The default landing for an institutional user is the **OEMS trading desk**.

### 1.1 Personas (preserved from Lovable prototype)

| Role | Default home | Status in v2.0 |
|---|---|---|
| `oems` (institutional trading desk) | `/oems` | **Built** |
| `wealth_manager` | `/wm/dashboard` | Deferred (placeholder) |
| `strategist` | `/strategist` | Deferred (placeholder) |
| `business` | `/business` | Deferred (placeholder) |
| `admin` | `/admin` | Deferred (placeholder) |
| `funeral_cover` | `/fc/overview` | Deferred (placeholder) |

A global role switcher in the top chrome lets us preview any persona while we're building.

### 1.2 OEMS surface map (v2.0 scope)

| Route | What it shows | IRESS V4 method(s) |
|---|---|---|
| `/oems` (Cockpit) | KPI strip · sector heatmap · ZAR yield curve · JSE movers · intraday ALSI · live SENS feed · open-orders tape · macro pulse | composite of `PricingQuoteGet` + `TimeSeriesGet2` + `OrderPadGetByAccount` + news/macro |
| `/oems/blotter` | Working / partial / filled / cancelled / rejected order tape, search, new-order dialog | `OrderPadGetByAccount(Updates)` + `OrderCreate3` + `OrderAmend2` + `OrderDelete` |
| `/oems/strategies` | Mandate cards (equity + money-market) with rebalance gate, target-vs-actual drift | `PositionGetByStrategy` + `InvestorCount` + `OrderCreate3` rebalance block |
| `/oems/equities` | JSE L1 quotes table, top movers, sector breakdown | `PricingQuoteGet` + `PricingQuoteExGet` |
| `/oems/fixed-income` | Bond screener, single-bond detail (clean/dirty/DV01/convexity/KRD), P&L sensitivity | `PricingQuoteGet` (bonds) + bond-reference + NSS curve |
| `/oems/money-market` | JIBAR fixings, NCD/T-Bill universe, weighted-yield, ZAR govi | `TimeSeriesGet2(JIBAR…)` + `TimeSeriesGet2(ZAR NSS)` + reference |
| `/oems/curves` | Govi · swap · real (ILB) · breakeven overlay, change table, PCA decomposition | `TimeSeriesGet2(NSS)` + history |
| `/oems/macro` | Macro tile strip (SARB, StatsSA, G10), calendar, surprise chart | `TimeSeriesGet2(macro codes)` + calendar |
| `/oems/news` | Filtered news & SENS tape, priority badges, ticker chips | news / SENS feed |
| `/oems/security` | Watchlist + single-security L2 depth + time-and-sales + fundamentals | `PricingQuoteGet` + `PricingQuoteExGet` + L2 + cashflows |
| `/oems/integration` | Endpoint health, IRES v4 → OEMS surface map, auth/streaming/repo, WSDL/version, gap call-outs | ops surface (not a V4 method) |

### 1.3 Out of scope for v2.0 (deferred)

- Real IRESS SOAP connection (we don't have creds yet — build the adapter, ship a mock, swap when creds land)
- Real auth (we use a mocked `useSession()`)
- Wealth-manager / strategist / business / admin / funeral-cover pages
- FIX+ drop-copy TCP connection (we model it but don't connect)
- Settlement / clearing (STRATE)
- Mobile-first layout (desktop-first; tablet reasonable; phone gets a "best-effort" view)

---

## 2 · Tech stack

| Layer | Choice | Why |
|---|---|---|
| Runtime | **Bun 1.3+** | Fast installs, fast scripts, native TS, native WebSocket server for the tick stream |
| Framework | **Next.js 16 (App Router, RSC + Server Actions, Cache Components)** | Production-ready SSR/streaming, file-based routing, edge-ready |
| Language | **TypeScript 5.7+ strict** | Catch errors at build time, document the V4 types as we go |
| UI primitives | **shadcn/ui (Radix)** | Composable, copy-in, no lock-in, accessible by default |
| Styling | **Tailwind CSS v4** | Speed, design-token CSS, no CSS-in-JS runtime |
| Charts | **Recharts** (kept) + **lightweight-charts** for tick / depth | Recharts for analytics, lightweight-charts for the trading-deck-grade depth and time-series |
| Data / streaming | **Zustand** (client state) + **TanStack Query** (server cache) + **EventSource / WebSocket** (live ticks) | Right tool for each job |
| Forms | **react-hook-form** + **Zod** | Typed end-to-end |
| Icons | **lucide-react** | Tree-shakable, consistent |
| Lint / format | **Biome** | One tool, fast |
| Tests | **Vitest** + **Playwright** | Unit + e2e |
| Package manager | **Bun** (`bun install`, `bun run`) | Fast |
| Deployment | **Vercel-ready** (works in any Node/Bun host) | First-class Next.js, env vars, previews |

### 2.1 Why we keep Recharts + add lightweight-charts

Recharts is fine for **categorical** analytics (KPIs, portfolio breakdowns, curve-change tables, PCA bars). It is **not** the right tool for a **Bloomberg-grade tick / depth / time-and-sales** panel. We will use TradingView's `lightweight-charts` (free, MIT) for:

- Intraday ALSI / single-security line / candlestick
- Real-time tick / sparkline
- Market-depth ladder (custom canvas, not lightweight-charts)

That gives us a real trading-desk feel without dropping into D3.

---

## 3 · IRESS V4 integration shape

We will not connect to IRESS in v2.0 (no creds). We **will** build the integration boundary so that the swap from mock → live is a 1-line config change.

### 3.1 The adapter pattern

```
src/lib/iress/
├── index.ts          ← public API
├── client.ts         ← IressClient interface (matches real V4 method names)
├── session.ts        ← IRESSSessionStart / ServiceSessionStart / End / recovery
├── market-data.ts    ← PricingQuoteGet, TimeSeriesGet2, PricingQuoteExGet
├── trading.ts        ← OrderCreate3, OrderAmend2, OrderDelete, OrderPadGet*
├── portfolio.ts      ← IPSTransactionGetByAccount5, IPSAccountGetAll1, …
├── fix-plus.ts       ← TargetIDGet, TargetIDStatusGet
├── errors.ts         ← typed session error codes (25001-25035, 666)
├── recovery.ts       ← auto-reconnect on 25006/25009/25014/25019/25022/25033
├── ws.ts             ← Updates (long-polling) pattern, idempotent RequestID
├── soap.ts           ← SOAP envelope builder / response parser (zod-typed)
├── types.ts          ← TypeScript interfaces matching the WSDL shape
└── mock/             ← mock implementation backed by deterministic generators
    ├── client.ts
    ├── seed.ts
    └── …
```

The mock implementation lives behind a flag (`process.env.IRESS_MODE = "mock" | "live" | "wsdl-stub"`). UI never knows the difference.

### 3.2 Typed V4 surface (subset we'll build)

```ts
// session.ts
IRESSSessionStart(req: {
  UserName: string; CompanyName: string; Password: string;
  ApplicationID: string; ApplicationLabel?: string;
  SessionTimeout?: number;  // minutes, max 1440
  SessionNumberToKick?: number;  // -1 = force-close all
  KickLikeSessions?: boolean;
  Locale?: "en-ZA";
}): Promise<{ IRESSSessionKey: string; SessionTimeout: number; SessionNumber: number }>;

ServiceSessionStart(req: {
  IRESSSessionKey: string; Service: "IOSPlus" | "IPS" | "FIXPlus"; Server: string;
}): Promise<{ ServiceSessionKey: string }>;

// market-data.ts
PricingQuoteGet(req: { SecurityCode: string; Exchange: string; Updates?: boolean; RequestID?: string }): Promise<{ HeaderRow, DataRows[] }>;
TimeSeriesGet2(req: { Code: string; From?: string; To?: string; Updates?: boolean; RequestID?: string }): Promise<{ HeaderRow, DataRows[] }>;

// trading.ts
OrderCreate3(req: { ServiceSessionKey: string; Order: NewOrder; OrderTag: string /* idempotency! */ }): Promise<{ OrderNumber: string }>;
OrderAmend2(req: { ServiceSessionKey: string; OrderNumber: string; …amend fields }): Promise<void>;
OrderDelete(req: { ServiceSessionKey: string; OrderNumber: string }): Promise<void>;
OrderPadGetByAccount(req: { ServiceSessionKey: string; AccountCode: string; OrderFilter: 1|2|3|4|5; Updates?: boolean; RequestID: string }): Promise<Paginated<OrderPadRow>>;
```

(All shapes are best-effort mappings from `Documentation & Vision/iress-v4-docs/`. They will be confirmed against the WSDL the day we get creds — but the **method names, parameter names, and ordering** are the real ones from the doc.)

### 3.3 Idempotency, recovery, and the "low-hanging fruit" checklist

From `11-mint-oems/04-low-hanging-fruit.md` we will bake in from day one:

1. **`OrderTag` on every order** — UUID per create; duplicate-tag guard.
2. **Cut-down WSDLs** — `IRESS_INTEGRATION_MAP` in `lib/iress/wsdl.ts` lists exactly the methods we'll call.
3. **`Accept-Encoding: gzip`** on every client call.
4. **Session hashing** — never log raw `IRESSSessionKey`; SHA-256 prefix in logs.
5. **Two-step reconciliation** — active snapshot + inactive search on reconnect.
6. **ApplicationID pattern** — `Mint-OEMS-<env>-<node>-<guid>`, configurable.
7. **Auto-recovery** — see `recovery.ts`: on 25006/25009/25019/25033 → rebuild service session; on 25014/25019/25022 → rebuild Iress session + all children; retry with backoff.
8. **WSDL versioning** — `wsdl/iress-<env>-<date>.wsdl` in VCS, diff on every refresh.

### 3.4 The IRESS coverage we mock

The Lovable prototype already models ~95% of the data we need. We port it forward and **tag every fixture with the V4 method it would come from** (single source of truth = the same tag the integration map will reference).

---

## 4 · Design language

The Lovable prototype is functional but reads as "AI-generated SaaS". For v2.0 we are aiming for **"modern institutional trading desk"** — the kind of polish you'd see at Block.one / Stripe / Linear / modern Bloomberg Terminal revamp. Specifically:

- **Typography:** Inter for UI, **JetBrains Mono** for numbers (tabular-nums everywhere money moves). Tighter line-heights. Larger KPI numerals. Uppercase eyebrow labels for panel titles.
- **Color:** Dark-first. Default theme = a refined **midnight-slate** (not the prototype's dark navy), with an optional **"terminal"** theme (near-black, amber accents) and a light theme. Semantic tokens for up / down / warning / halt use **green/amber/red** that are calibrated to **WCAG AA** on both backgrounds.
- **Density:** Bloomberg-like. The Cockpit is **dense** (12 viewports at once) but every panel has **at least 16px of padding** and **6-8px of internal spacing** — no more 1-2 px cramped grids.
- **Motion:** **Restrained** — price-flash on tick (≤ 400ms), panel mount fade-in, command-palette slide. No spinning loaders, no bounce, no parallax.
- **Iconography:** lucide only. No emoji. No stock chart clip art.
- **Component language:**
  - **Panel** = the unit of the desk. Header (title + IRESS-endpoint pill + status dot + right slot) + body (scroll/dense/normal). Hover lifts a 1-px border.
  - **Number cell** = right-aligned, tabular-nums, with `+` prefix, color-coded, with optional flash on update.
  - **Status pill** = uppercase, mono, 1-px ring, semantic color.
  - **Ticker chip** = uppercase mono, 1-px ring, primary color.
- **No "AI slop":** no "Hey there 👋", no giant gradient hero, no "supercharge your workflow". The product is the desk. The desk is the product.

### 4.1 Color tokens (proposal)

```css
/* dark (default) */
--bg-canvas       slate-950   #0a0e1a
--bg-surface      slate-900   #111729
--bg-elevated     slate-850   #1a2238
--border-subtle   slate-800   #232c44
--border-strong   slate-700   #364362
--text-primary    slate-50    #f1f5f9
--text-secondary  slate-400   #94a3b8
--text-muted      slate-500   #64748b
--accent          violet-500  #8b5cf6   /* primary action, links, focus */
--up              emerald-400 #34d399
--down            rose-400    #fb7185
--warn            amber-400   #fbbf24
--halt            red-500     #ef4444
--info            sky-400     #38bdf8

/* light */
--bg-canvas       slate-50    #f8fafc
--bg-surface      white       #ffffff
--bg-elevated     slate-100   #f1f5f9
--border-subtle   slate-200   #e2e8f0
…
```

### 4.2 The "panel" primitive

```tsx
<Panel
  title="ZAR Sovereign Curve"
  eyebrow="10Y · 11.42%"
  endpoint="TimeSeriesGet2 · NSS"
  status="live"
  density="comfortable"   // comfortable | dense | scroll
  actions={<>…</>}
>
  <ResponsiveContainer …>…</ResponsiveContainer>
</Panel>
```

The `endpoint` prop is the IRESS V4 method the panel is bound to; we render it as a pill with a hover-tooltip that explains the call. This makes the **integration map visible from any panel** — a designer/PM can click through the app and see exactly which V4 methods power it.

---

## 5 · Architecture

### 5.1 Directory layout

```
wealth-navigator/
├── README.md
├── PLANNING.md                    ← this file
├── package.json
├── bun.lockb
├── next.config.ts
├── tsconfig.json
├── tailwind.config.ts
├── postcss.config.mjs
├── components.json
├── biome.json
├── src/
│   ├── app/
│   │   ├── layout.tsx              ← root layout, fonts, theme provider
│   │   ├── globals.css             ← tailwind + tokens
│   │   ├── page.tsx                ← landing / role pick
│   │   ├── oems/
│   │   │   ├── layout.tsx          ← OEMS chrome (top bar, ticker, side nav)
│   │   │   ├── page.tsx            ← Cockpit
│   │   │   ├── blotter/page.tsx
│   │   │   ├── strategies/page.tsx
│   │   │   ├── equities/page.tsx
│   │   │   ├── fixed-income/page.tsx
│   │   │   ├── money-market/page.tsx
│   │   │   ├── curves/page.tsx
│   │   │   ├── macro/page.tsx
│   │   │   ├── news/page.tsx
│   │   │   ├── security/page.tsx
│   │   │   └── integration/page.tsx
│   │   ├── (other-personas)/
│   │   │   ├── wm/…               ← placeholders
│   │   │   ├── strategist/…
│   │   │   ├── business/…
│   │   │   ├── admin/…
│   │   │   └── fc/…
│   │   └── api/
│   │       └── ticks/route.ts      ← SSE tick stream (Bun/Node WS)
│   ├── components/
│   │   ├── ui/                     ← shadcn primitives
│   │   ├── oems/
│   │   │   ├── shell/              ← TopBar, TickerBar, SideNav, CommandPalette
│   │   │   ├── primitives/         ← Panel, NumberCell, Pill, EndpointPill
│   │   │   ├── cockpit/            ← KpiStrip, Heatmap, Curve, Movers, OpenOrdersTape, MacroPulse
│   │   │   ├── blotter/            ← OrderTable, StateFilterTabs, NewOrderDialog
│   │   │   ├── strategies/         ← MandateCard, DriftBar, RebalanceGate
│   │   │   ├── security/           ← DepthLadder, TimeAndSales, Sparkline
│   │   │   └── integration/        ← EndpointHealthTable, IntegrationMap
│   │   └── shared/
│   ├── lib/
│   │   ├── iress/                  ← V4 client (see §3.1)
│   │   ├── store/                  ← Zustand: useTickStore, useSessionStore
│   │   ├── format.ts               ← formatZAR, formatPct, formatBps, formatTenor
│   │   ├── cn.ts                   ← class-name helper
│   │   ├── sa-holidays.ts          ← JSE 2026 holiday calendar
│   │   └── ws-server.ts            ← dev-mode tick broadcaster
│   ├── hooks/
│   │   ├── use-tick.ts
│   │   ├── use-iress.ts            ← react-query bindings
│   │   └── use-keyboard-shortcut.ts
│   ├── types/
│   │   ├── iress.ts
│   │   └── domain.ts
│   └── styles/
│       └── tokens.css
└── public/
    └── favicon.svg
```

### 5.2 Data flow

```
[Mock IRESS adapter]  ──seed──►  in-memory store (Zustand)  ──subscribe──►  UI panels
       │                                                                     ▲
       │                                                                     │  useTick(sym)
       │                                                                     │
       └─────── on tick (1.1s) ──►  EventSource /api/ticks  ─────────────────┘
```

The mock adapter is the **only** place that knows data shape. UI never imports `mock/seed.ts` directly.

### 5.3 Real-time strategy

For v2.0 we ship an **EventSource (SSE) endpoint** at `/api/ticks` that the client subscribes to. Bun's `Bun.serve()` is happy to do this; on a Node-host we fall back to Next's `Response` streaming. Trade-off: SSE is one-way (server → client), which is what we want for ticks, and works through any HTTP proxy. When we go live we'll swap the SSE feed for a WebSocket to the IRESS edge proxy (`wss://stream.mint.local/v1/...`).

### 5.4 State management

- **Zustand** for ephemeral client state (ticks, UI flags, command-palette open).
- **TanStack Query** for anything that has a server round-trip (session start, order create, account list). The mock adapter is wrapped in `useQuery` hooks so the swap to live IRESS is a one-line change inside `use-iress.ts`.
- **No Redux, no Recoil.** Keep it boring.

---

## 6 · Build order (the work plan)

We do this in **8 phases**. Each phase is shippable on its own.

| # | Phase | Outcome |
|---|---|---|
| 0 | **Bootstrap** | `bun create next-app`, install deps, dark/light mode wired, fonts loaded, `bun run dev` lights up. |
| 1 | **Design system** | Tokens, `Panel`, `NumberCell`, `Pill`, `EndpointPill`, `TickerBar`, role switcher, top bar. |
| 2 | **IRESS adapter (mock)** | `lib/iress/*` typed; `mock/seed.ts`; `use-iress.ts` TanStack hooks. Tick stream at `/api/ticks`. |
| 3 | **OEMS shell** | `/oems` layout, side nav, top chrome, command palette, theme toggle. |
| 4 | **Cockpit** | KPI strip, heatmap, curve, movers, intraday ALSI, SENS, open orders, macro pulse. This is the showpiece. |
| 5 | **Blotter + Security Lookup + Strategies** | The three next-most-used surfaces. |
| 6 | **Equities · Fixed Income · Money Market · Curves · Macro · News · Integration** | Fill out the desk. |
| 7 | **Polish** | Error boundaries, skeletons, empty states, a11y pass, Lighthouse, keyboard shortcuts, `bun run build && bun run start` smoke test. |

We are starting with **phases 0–3 + 4 in this session** and stubbing the rest with route + nav so the navigation works. Phases 5–7 are follow-ups that have a clear scope.

---

## 7 · Quality bar (the "production-ready" promise)

- **TypeScript strict.** Zero `any` in app code (libraries get `as unknown as`).
- **No `console.log`** in app code; logger with `pino` or `consola`.
- **Biome** for lint + format. Pre-commit hook via `lefthook` (optional).
- **Tests:** Vitest for the IRESS adapter (mock → live parity), Playwright smoke for the OEMS nav.
- **Accessibility:** All panels are `<section>` with `aria-label`; status pills have text + icon, not just color; keyboard focus rings are visible against both themes.
- **Performance:** RSC for the integration map, deferred client components for charts, dynamic imports for `lightweight-charts` (it's a chunky dep).
- **Observability:** `?ping` route reports adapter mode + tick-stream health + last error.
- **Env hygiene:** `.env.example` lists every var (`IRESS_MODE`, `IRESS_BASE_URL`, `NEXT_PUBLIC_TICK_STREAM`, …); `.env` is gitignored.
- **Error UX:** Every panel has a `Panel.Error` state, every page has an `error.tsx`, every long-poll has a back-off.

---

## 8 · Risks & decisions to confirm

1. **Bun + Next.js 16.** Works but the `next dev` server runs on Bun's JS runtime. If we hit a Vercel/edge issue we fall back to Node. The `package.json` scripts use `bun --bun next dev` so the runtime is unambiguous.
2. **Lightweight-charts license.** MIT-licensed, free for commercial use. ✅
3. **No real IRESS creds.** The mock is the source of truth. The day we get creds, we ship a second adapter (`lib/iress/live/`) that implements the same `IressClient` interface and flip `IRESS_MODE=live`.
4. **Role switcher in v2.0.** Real role-based access lives behind a future auth provider (Clerk / Auth0). For now the switcher is a `useState` in the root layout, persisted to `localStorage`, gated client-side. Server-side gating comes with the auth story.

---

## 9 · What "amazing" means here

A trader at a JSE-member firm opens `/oems` at 08:55 SAST, sees the ZAR govi curve, the ALSI ticking up, a JSE-sector heatmap, the open-orders tape, and three SENS headlines from overnight. They spot a corporate action on `NPN`, hit `NPN` on the watchlist, see the depth ladder and time-and-sales update in real time, and stage an order from the new-order dialog. They never feel like they're using a "prototype". The data is dense, the keyboard works, the colors are correct, the latency is honest. The IRESS-endpoint pill on every panel reminds them and the engineering team what the desk is bound to.

That is the bar. We are building to it.
