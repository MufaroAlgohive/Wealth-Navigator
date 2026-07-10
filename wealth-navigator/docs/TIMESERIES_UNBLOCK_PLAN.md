# TimeSeriesGet2 Entitlement Unblock — Plan

> **Trigger:** Andre Pietersen (IRESS) email on 2026-07-09 confirming the
> `TimeSeriesGet2` entitlement is working with `DataSource=zax`,
> `Exchange=jse`, and that his working example used `Frequency=monthly`.
>
> **History:** From 2026-06-13 to 2026-07-09 the method was
> entitlement-blocked — every `Frequency` Long (0..32, 60, 100, 86400,
> 31536000, etc.) and every V4 `<Interval>` string (`Daily`, `Weekly`,
> `Monthly`, `Quarterly`, `Yearly`, `IntraDay`) returned
> `soap:Receiver — Invalid Parameter Value: <n> as Frequency` on every
> symbol tested. Full candidate-vs-response table in
> [`TIMESERIES_PROBE_REPORT_FINAL.md`](./TIMESERIES_PROBE_REPORT_FINAL.md).
>
> **Owners:** OEMS desk / Backend / Charles (IRESS) for follow-up probe
> confirmation.
>
> **Status:** **Phase 1 in progress.** Per-stock daily + monthly wiring
> is now live in `/api/history/[sym]` and the Vercel ↔ worker bridge
> (proves out the entitlement via the same path the UI reads). Tier-2
> panels (ALSI intraday, sector heatmap, ZAR sovereign curve) remain
> `blocked-vendor` until a separate probe confirms `Frequency=Tick` /
> `IntraDay` is also accepted (Andre's email only proved `monthly`).

---

## 1 · What we can / cannot prove locally

**We cannot probe live entitlements from this dev box.** The Railway
`iress-ingest` worker holds the single IRESS CT license seat. Standing
rule: **only one process at a time may own the seat.** Spinning the
worker up locally with `IRESS_MODE=live` would kick the production
worker off — which would, in turn, stop live `PricingQuoteGet` ingest
into `stock_intraday_c` and break the OEMS tickers. Therefore:

- The probe in
  [`scripts/probe-timeseries.ts`](../scripts/probe-timeseries.ts)
  is **a record of what to call, not something we can run from
  `bun run dev` locally.** It exits with code 2 + a one-line `skip`
  JSON when `IRESS_WORKER_URL` / `WORKER_URL` is unset, and posts
  candidate bodies to the Railway `/debug/timeseries-probe` endpoint
  when the URL is set.
- The Vercel BFF (`/api/history/[sym]`, `/api/intraday/[sym]`) goes
  through the Railway worker via `callWorker()`. Any wiring change
  here is exercised end-to-end the moment the Vercel env
  `IRESS_WORKER_URL` points at the production worker. Locally,
  `IRESS_MODE=mock` is set, so the changes do **not** affect local
  dev — they only flip on in production.

The probe script defaults to a single-line `skip` JSON when there's
no worker URL, so it can be `bun run`'d in any environment without
side-effects.

## 2 · Probe candidate table (what we'd post to `/debug/timeseries-probe`)

The worker's `/debug/timeseries-probe` accepts a JSON body
`{ code, exchange, interval (or frequency), dataSource, dateFrom, dateTo }`
and surfaces the raw IRESS response (`ok`, `errorNumber`, `rawFault`,
`dataRowCount`, `firstRow`). The candidates below cover every
currently-`blocked-vendor` panel + a few new ones Andre's email proves
should work.

| # | Panel | Code | Exchange | DataSource | Frequency (V4 string) | Proven by Andre? | Expected outcome |
|--:|-------|------|----------|------------|-----------------------|------------------|------------------|
| 1 | per-stock history (5D … YTD) | `SOL` | `JSE` | `zax` | `Daily` | **not explicitly proven** (he proved `Monthly`) | `ok=true, dataRowCount>0` |
| 2 | per-stock history (1Y, 5Y) | `SOL` | `JSE` | `zax` | `Monthly` | **YES — Andre's example** | `ok=true, dataRowCount>0` |
| 3 | per-stock history (All, 10Y+) | `SOL` | `JSE` | `zax` | `Monthly` | **YES — Andre's example** | `ok=true, dataRowCount>0` |
| 4 | per-stock intraday (1D / 5D chart) | `SOL` | `JSE` | `zax` | `Tick` | **no — needs additional probe** | unknown; fall back to Yahoo ticks + Supabase `stock_intraday_c` |
| 5 | per-stock intraday (alt spelling) | `SOL` | `JSE` | `zax` | `IntraDay` | **no — needs additional probe** | unknown; older V4 enum value |
| 6 | per-stock intraday (alt 1m) | `SOL` | `JSE` | `zax` | `1-Minute` | **no — needs additional probe** | unknown; if Tick fails, this is the fallback |
| 7 | ALSI line (J203 daily) | `J203` | `JSE` | `zax` | `Daily` | **not explicitly proven** | `ok=true` — same shape as per-stock daily |
| 8 | ALSI intraday | `J203` | `JSE` | `zax` | `Tick` | **no — needs additional probe** | unknown; tier-2 stays `blocked-vendor` until confirmed |
| 9 | Sector heatmap (J200 daily) | `J200` | `JSE` | `zax` | `Daily` | **not explicitly proven** | `ok=true` if index codes are like per-stock |
| 10 | ZAR sovereign curve (R2030 daily) | `R2030` | `YFX` | `yfxd` | `Daily` | **not explicitly proven** | uncertain — `DataSource=zax` may NOT work for bonds; YFX may still need `yfxd` per the standing `SecuritySearchGet` discovery (see [`timeseries.ts`](../workers/iress-ingest/src/timeseries.ts)). Andre's email is ambiguous on bonds. **Worst case: bond codes keep working as today.** |

The 14 candidates in the script are a superset of the table above
(cross-checking NPN / FSR / SBK / MTN for the per-stock daily panel,
plus the three intraday spellings).

## 3 · Decision tree per panel

```
Panel
├── per-stock history (5D / 1M / 6M / YTD / 1Y / 5Y / All)
│   ├── 1d/5d window      → Yahoo + Supabase stock_intraday_c (today)
│   ├── 1M .. 1Y (daily)  → IRESS TimeSeriesGet2(zax, jse, Daily)   [new — wired this PR]
│   │                       → fallback to Yahoo when entitlement fails
│   └── 5Y / All (monthly)→ IRESS TimeSeriesGet2(zax, jse, Monthly)  [new — wired this PR]
│                           → fallback to Yahoo when entitlement fails
│
├── per-stock intraday (1D / 5D chart)
│   ├── primary           → Supabase stock_intraday_c (worker-upserter) [today]
│   ├── secondary probe   → IRESS TimeSeriesGet2(zax, jse, Tick|IntraDay|1-Minute)
│   │                       → return stock_intraday_c when probe returns 25010/25034
│   └── unchanged         → chart shape stays the same; "blocked-vendor" badge NOT shown
│                           because stock_intraday_c is the Supabase-fed authoritative source
│
├── ALSI (J203) daily chart
│   ├── primary           → IRESS TimeSeriesGet2(zax, jse, Daily)     [new — wired this PR]
│   │                       → already proven shape; same as per-stock daily
│   └── fallback          → empty state (no Yahoo fallback for index codes)
│
├── ALSI intraday                                          ← STAYS blocked-vendor
│   ├── requires          → IRESS TimeSeriesGet2(zax, jse, Tick)
│   │                       → NOT yet proven; needs additional probe
│   └── action            → flag in VENDOR_ENTITLEMENT_STATUS.md as
│                           "needs additional probe (Frequency=Tick)"; do NOT
│                           change BFF until probe confirms ok=true dataRowCount>0
│
├── Sector heatmap (J200 etc. daily)                       ← STAYS blocked-vendor
│   ├── requires          → IRESS TimeSeriesGet2(zax, jse, Daily) per sector code
│   │                       → NOT yet proven; same row as per-stock daily but
│   │                         Andre's email was about a single symbol
│   └── action            → same as ALSI daily — only enable after per-stock daily
│                           probe confirms ok=true
│
└── ZAR sovereign curve (R2030 etc. daily)                 ← STAYS blocked-vendor
    ├── requires          → IRESS TimeSeriesGet2(yfxd, yfx, Daily) per R-code
    │                       → DIFFERENT DataSource (yfxd) than equities (zax);
    │                         Andre's email is about equities, not bonds
    ├── already-confirmed → per existing live probe (2026-06-16) the worker's
    │                         syncTimeSeries loop is wiring YFXD correctly; the
    │                         historic "Invalid access" was a JSED-on-YFX mistake
    └── action            → no change to bond wiring; flag in
                            VENDOR_ENTITLEMENT_STATUS.md that the bond path
                            needs its own probe (DataSource=zax may not work
                            for YFX bonds)
```

## 4 · Wire-up (this PR)

1. **`src/lib/iress/live.ts` — `timeSeriesGet2()`:** default
   `DataSource` to `zax` and `Exchange` to `jse` when the caller doesn't
   supply one. Per-call overrides still win (so the bond path's `yfxd`
   keeps working). Log a structured `time_series_entitlement_failure`
   event when the response carries fault codes 25010 / 25034 so we can
   see when an entitlement flip re-blocks the path.

2. **`src/app/api/history/[sym]/route.ts`:** for SA symbols (`.JO` /
   `.JSE` suffix or bare ZSE-listed codes), prefer IRESS `TimeSeriesGet2`
   (`Daily` for ranges up to YTD, `Monthly` for 5Y / All) over the
   existing Yahoo fallthrough. Falls back to Yahoo when IRESS returns
   `ok=false dataRowCount=0` or 25010/25034 entitlement faults. Adds
   `?provider=iress` override for testing.

3. **`src/app/api/intraday/[sym]/route.ts`:** add a `?provider=iress`
   path that calls IRESS `TimeSeriesGet2` with `Frequency=Tick` first
   and falls back to `1-Minute` on the 25010/25034 fault. Default
   behaviour (DB-first via `stock_intraday_c`) is unchanged — the
   Supabase-fed ticks are already the authoritative source.

4. **`docs/VENDOR_ENTITLEMENT_STATUS.md`:** flip the
   `TimeSeriesGet2` row from `blocked-vendor` to `available` for the
   per-stock daily + monthly case (proved by Andre), and document the
   `Tick` / `IntraDay` / sector / bond cases as `code-gap` / `unblock-pending`
   until a separate probe confirms.

5. **Typecheck** (`bunx tsc --noEmit`) — no new errors expected; only
   the optional `?provider=iress` query string is added and the
   `DataSource` default changes from `JSED` to `zax` (the env var
   `IRESS_TS_DATASOURCE` still overrides per-call).

## 5 · What does NOT change this PR

- **Tier-2 panels** (ALSI intraday, sector heatmap, ZAR sovereign curve)
  — `Frequency=Tick` is not yet proven. The BFF surfaces
  `blocked-vendor` for these and the VENDOR_ENTITLEMENT_STATUS doc
  records the next-probe precondition.
- **The Railway worker's `syncTimeSeries` loop** — it already uses
  `JSED` / `YFXD` per exchange. We do NOT flip it to `zax` until the
  tier-2 probe confirms; the standing rule is "exchange-specific
  DataSource" (see
  [`timeseries.ts`](../workers/iress-ingest/src/timeseries.ts) lines
  96-110).
- **The probe-frequency script** (`scripts/probe-frequency.ts`) — that
  is the legacy `Frequency` Long probe from June 13 2026. Andre's email
  supersedes it; the new probe is in
  [`scripts/probe-timeseries.ts`](../scripts/probe-timeseries.ts).

## 6 · Validation plan

After deploy (Vercel preview + main):

1. Hit `/api/history/NPN?range=1Y` — confirm `source: "iress"`, points
   populated. `source: "yahoo"` means IRESS returned an empty / faulted
   response.
2. Hit `/api/history/SOL?range=5Y` — confirm monthly series, ~60
   points, `source: "iress"`.
3. Hit `/api/history/NPN?provider=iress&range=1M` — explicit override.
4. Hit `/api/intraday/NPN?provider=iress&limit=20` — Tick attempt; if
   the entitlement is missing, the response surfaces
   `source: "supabase"` (DB-first) with a `warning` field noting the
   IRESS probe was 25010/25034. **Until a Tick probe confirms, the
   default route does NOT call IRESS for intraday** — the Supabase
   `stock_intraday_c` is the source of truth.
5. Watch the worker's structured log for
   `time_series_entitlement_failure` events — should be zero for the
   per-stock daily path on the first deploy; non-zero means the
   entitlement flipped off again and we need to roll back to Yahoo.

## 7 · Next probe (when Charles / RailOps get a window)

1. Run `bun run scripts/probe-timeseries.ts` against the production
   worker (`IRESS_WORKER_URL=https://iress-worker-production.up.railway.app`
   + `WORKER_TOKEN=…`).
2. Save the resulting JSON stream to
   `docs/TIMESERIES_PROBE_RUN_<YYYY-MM-DD>.json` for the record.
3. For each row that returns `ok=true dataRowCount=0`, escalate back
   to Charles — the entitlement should be live per his email.
4. For each row that returns `ok=true dataRowCount>0` and is in the
   tier-2 list, open a follow-up PR to wire the corresponding BFF
   (`/api/sa-rates/timeseries`, the sector heatmap, the curve BFFs).
5. For each row that returns `ok=false` with a fault that's NOT
   25010/25034 (e.g. `Invalid Parameter Value`), document the fault
   in the probe report and ping Charles for the right V4 frequency
   spelling on that code.

---

_Last updated: 2026-07-09, on receipt of Andre Pietersen's email
confirming the `TimeSeriesGet2` entitlement unblock for the
`DataSource=zax, Exchange=jse, Frequency=monthly` shape._
