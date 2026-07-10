# Vendor Entitlement Status

> **Phase:** Mint OEM Finalisation Phase C2 (vendor feeds).
> **Owners:** OEMS desk / IRESS integrations / Treasury ops.
> **Source of truth:** the entitlement status of each vendor integration the
> OEMS relies on, plus the per-vendor unblock condition an operator can hand
> to Charles (IRESS) or Tsie (Ozone / SARB).

The table below is the canonical state per the 2026-07-09 cutover. When
entitlements flip on, edit this file in the same commit that wires the
upstream.

> **2026-07-09 update — IRESS `TimeSeriesGet2` unblock.** Andre Pietersen
> confirmed the entitlement is live with `DataSource=zax`,
> `Exchange=jse`, `Frequency=monthly`. Per-stock daily + monthly is now
> flipped to **available** on `/api/history/[sym]` (Y-axis: time-series
> daily close for the Security page chart ranges). The same V4 string
> form is used for the daily bucket. **Uncertainty:** per-symbol
> intraday (`Frequency=Tick | IntraDay | 1-Minute`), the sector indices
> (J200 etc.), the ZAR sovereign curve (R-codes on YFX), and the J203
> All Share index are **not yet probed**. They stay `blocked-vendor` /
> `unblock-pending` until a separate probe (Andre's email proves
> monthly, not the rest). Probe script + plan in
> [`TIMESERIES_UNBLOCK_PLAN.md`](./TIMESERIES_UNBLOCK_PLAN.md).

---

## Status legend

- **available** — vendor reachable, data flowing, no entitlement gaps.
- **degraded** — vendor reachable but partial (e.g. only 1 of 3 series).
- **blocked-vendor** — entitlement or contract pending; the BFF renders
  `data-source="blocked-vendor"` empty states.
- **code-gap** — vendor is public, but the upstream shape or auth isn't
  yet implemented; surfaces as `data-source="code-gap"`.
- **unconfigured** — vendor not wired at all (planned / stub only).

The Phase C BFFs translate each of these states into the same
`DataSourceKind` badges the rest of the OEMS chrome uses — the Cockpit,
`/oems/macro`, `/oems/money-market`, `/oems/bonds`, and the Cockpit News
Flow all read off the same taxonomy.

---

## 1 · Per-vendor status

| Vendor | BFF | Status (2026-07-09) | Unblock condition | Owner |
|---|---|---|---|---|
| **IRESS quotes** (`PricingQuoteGet`) | `/api/quotes`, `/api/intraday/[sym]`, `/api/history/[sym]`, `/api/equities` | **available** via Supabase-ingested snapshots (`USE_SUPABASE_QUOTES=true`). The Railway worker holds the CT seat and ingests to `stock_intraday_c` on RETAIL prod. | Already live on Vercel. `ACTIVE_MARKET_DATA_PROVIDER` flips between iress / yahoo / mock / iris for non-DB code paths. | Backend / IRESS |
| **IRESS order book** (`IOS+ OrderCreate3`, `OrderPadGetByAccount`, `OrderAmend2`, `OrderDelete`) | `/api/orders`, `/api/orders/live` | **blocked-vendor** in production today; mock for UAT. Live IRESS path is gated by `IRESS_MODE=live` on the worker + the operator choosing to flip the master "LIVE writes" gate (`SUPABASE_ALLOW_WRITES=1`). | Confirm Charles has flipped `IOS+` (and `IPS+`, `FIX+`) entitlements on `DFM@Mint`; flip `IRESS_MODE=live` + `SUPABASE_ALLOW_WRITES=1` on Railway. | Charles / Backend |
| **Yahoo Finance** (public `/v7/finance/quote`, `/v8/finance/chart`) | `/api/quotes?provider=yahoo`, `/api/intraday/[sym]` (fallthrough), `/api/history/[sym]` | **available** — public, no entitlement. Used as the IRESS fallthrough + the `ACTIVE_MARKET_DATA_PROVIDER=yahoo` default on Vercel. | n/a | Backend |
| **JSE ETF universe** (Yahoo `.JO` ETF roots — Satrix, Sygnia, 1nvest, NewGold, Absa) | `/api/admin/etf-universe`, `/api/quotes?provider=yahoo` (auto-suffix), `/api/equities` | **available** via the seed list (`lib/data/providers/jse-etfs.ts`). The worker `SecuritySearchGet` ingest will eventually replace the seed with a master table. | n/a | Backend |
| **JSE SENS** (`NewsVendorGet` `vendor=SENS`) | `/api/iress/news?vendor=SENS`, `/api/news?category=SENS` | **blocked-vendor** — the SENS vendor is not entitled on `DFM@Mint` as of the last worker probe (2026-06-26). The BFF translates IRESS faults `25010` / `25034` into `data-source="blocked-vendor"` and the Cockpit News Flow renders the "Charles/IRESS to flip DFM@Mint access" empty state. The Alliance newswire (RSS: Moneyweb + BusinessTech) continues to deliver headlines under the All tab. | Charles/IRESS to flip the SENS vendor entitlement on `DFM@Mint`. Re-probe via `GET /api/iress/news?vendor=SENS` to confirm. | Charles |
| **JSE ALSI / J203 + sector indices** (`TimeSeriesGet2` on `JSE_DS`) | `/api/sa-rates/timeseries` (no — that's SARB), tier-2 cockpit panels (sector heatmap, ALSI line) | **available (per-stock daily/monthly)** as of 2026-07-09 — Andre's unblock email proves `DataSource=zax, Exchange=jse, Frequency=monthly` works; the daily bucket is on the same entitlement and is used by `/api/history/[sym]`. The ALSI / sector-index panels (`J203`, `J200`, …) and **per-symbol intraday** (`Tick | IntraDay | 1-Minute`) are still **blocked-vendor / unblock-pending** — they need a separate probe confirmation. | Re-validate the unproven `Frequency` values via the worker's `/debug/timeseries-probe`; see [`TIMESERIES_UNBLOCK_PLAN.md`](./TIMESERIES_UNBLOCK_PLAN.md) for the candidate list + decision tree. | Charles / Backend |
| **ZAR govt + ILB curves** (`TimeSeriesGet2` on `YFX` / `YFXD` — R2030, GOVI, ZAR_NSS, ZAR_REAL) | `/api/curves/ZAR_NSS`, `/api/curves/ZAR_REAL` | **unblock-pending** — Andre's 2026-07-09 unblock is for the equity feed (`DataSource=zax, Exchange=jse`); the bond/curve path still needs `DataSource=yfxd, Exchange=yfx`, which is the standing live config (CONFIRMED 2026-06-16 via `SecuritySearchGet` discovery) but **was not re-confirmed** under the new entitlement. The curves stay `blocked-vendor` until a YFX bond probe confirms. | Re-probe `TimeSeriesGet2(R2030, YFX, yfxd, Daily)` via the worker's `/debug/timeseries-probe`; the standing config should still work, but Andre's unblock email is silent on bonds. | Charles / Backend |
| **Full fixed-income feed** (`SecuritySearchGet` + bond YTM analytics — clean/dirty, duration, DV01, convexity) | `/api/bonds` | **blocked-vendor** — `bonds_c` requires `SecuritySearchGet` + YTM entitlement. Empty table surfaces as `data-source="blocked-vendor"` with the unblock condition. | Charles/IRESS to flip `SecuritySearchGet` + YTM entitlement on `DFM@Mint`; apply `supabase/migrations/20260613000004_oems_instrument_universe.sql`. The worker will then populate `bonds_c`. | Charles / Backend |
| **Money-market curve feed** (rate-feed entitlement — MM instrument universe + JIBAR fixings) | `/api/money-market` | **blocked-vendor** — `money_market_instrument_c` + `jibar_fixing_c` empty. BFF surfaces `data-source="blocked-vendor"` with the unblock condition. | Charles/IRESS to flip the rate-feed entitlement on `DFM@Mint`; apply `supabase/migrations/20260613000005_money_market_universe.sql`. | Charles / Treasury |
| **Macro series (SARB public Web API — repo, prime, ZARONIA)** | `/api/sa-rates/timeseries` (read), `/api/cron/sa-rates-update` (cron), `/api/admin/vendor-health` (probe) | **available** — SARB public Web API is reachable from Vercel with no auth. The daily cron (registered in `vercel.json` at `5 14 * * 1-5` UTC) pulls the headline series and (when `SA_RATES_WRITE=1`) persists to `macro_indicator_c` on institutional Supabase. | n/a. **Caveat:** if SARB blocks egress from Vercel IPs, the cron degrades gracefully and `/api/admin/vendor-health` flags the vendor as `error`. | Treasury / Backend |
| **Macro series (household-debt-to-GDP)** | `/api/sa-rates/timeseries` | **code-gap** — SARB's free time-series feed doesn't carry this series. The read side surfaces a `code-gap` row so the chart shows the dashed placeholder + the explanation. | Either (a) subscribe to the SARB data portal (paid API key) or (b) wire a StatsSA / SARB quarterly publication scraper. | Treasury |
| **IRIS** (planned — indices / rates / IRIS-S) | (stub provider — never wired today) | **unconfigured** — stubbed in `lib/data/providers/iris.ts`. The provider returns empty arrays + `unconfigured` health so the BFF degrades cleanly. | Confirm the IRIS API endpoints + auth with Charles/Juan; replace the stub with the real implementation. | Charles / Juan |
| **Ozone top-up wallet** (Tsie — wallet top-ups via Ozone API) | `/oems/banking/wallet-topup` (placeholder UI) | **code-gap** — UI placeholder per Phase B4; no real Ozone integration yet. | Tsie to investigate the Ozone API and replace the placeholder form with a real callback + `wallet_transactions` writes (`topup_method='ozone'`). | Tsie / Backend |
| **Broker feed (execution reports)** | `POST /api/admin/orderbook/fills` (mock) | **unconfigured (mock)** — broker feed is the mock endpoint from Phase B3. Real broker API integration is Phase C4. | Lonwabo to confirm the broker vendor; replace the mock with the broker's real format + auth. | Lonwabo / Backend |

---

## 2 · Entitlement-change checklist

When Charles confirms an entitlement flip on `DFM@Mint`, the order of
operations is:

1. **Probe from the worker.** Validate the new entitlement directly via
   the worker's debug routes — `/debug/news-vendor-probe` for SENS,
   `/debug/timeseries-probe` for `TimeSeriesGet2`. Confirm the SOAP fault
   is gone (no more 25010 / 25034).
2. **Re-probe from Vercel.** `GET /api/iress/news?vendor=SENS` and
   `GET /api/admin/vendor-health`. The vendor entry should flip from
   `blocked` to `ok` (or `degraded` if partial).
3. **Update this file.** Edit the table at the top — flip the Status to
   `available` (or `degraded`), note the date, and link the probe evidence.
4. **Drop the `data-source="blocked-vendor"` fallback.** The BFFs in this
   phase translate to `blocked-vendor` when the entitlement is missing; once
   the data flows, flip the route back to surfacing `unavailable` only for
   genuine outages.
5. **Surface in `/oems/integration`.** The Integration cockpit reads
   `/api/admin/vendor-health` — confirm the new state shows up on the page.

---

## 3 · Cron route catalogue

| Path | Schedule | Mode | Description |
|---|---|---|---|
| `/api/cron/yahoo-fundamentals` | `*/30 6-16 * * 1-5` (existing) | Shadow by default; `YAHOO_FUNDAMENTALS_WRITE=1` writes | Yahoo fundamentals bridge — market_cap / pe / dividend / ytd backfill on `securities_c` (gap fields only; IRESS owns `last_price` + `change_percent` in production). |
| `/api/cron/sa-rates-update` | `5 14 * * 1-5` (Phase C2) | Shadow by default; `SA_RATES_WRITE=1` writes | SARB public Web API daily pull of repo / prime / ZARONIA → `macro_indicator_c`. Graceful on upstream failure; logs only. |

---

## 4 · See also

- `wealth-navigator/docs/PROVIDER_SWITCH_RUNBOOK.md` — provider cutover
  procedure + parity acceptance test.
- `wealth-navigator/docs/STACK_ARCHITECTURE.md` — provider abstraction
  architecture and the IRESS-first overlay policy.
- `wealth-navigator/docs/TIMESERIES_PROBE_REPORT_FINAL.md` — the
  historical TimeSeriesGet2 probe report (June 2026).
- `wealth-navigator/docs/TIMESERIES_UNBLOCK_PLAN.md` — the 2026-07-09
  unblock plan: per-panel decision tree + probe script + what's wired
  vs what still needs additional probe confirmation.
- `wealth-navigator/scripts/probe-timeseries.ts` — the probe script
  that posts the candidate `TimeSeriesGet2` calls to the Railway
  worker's `/debug/timeseries-probe` endpoint.
- `wealth-navigator/docs/IRESS_AUTH_TROUBLESHOOTING.md` — session + 25008
  fault recovery.
- `wealth-navigator/docs/MINT_GO_LIVE_RUNBOOK.html` — the higher-level
  go-live runbook; this document is the entitlement slice.

---

_Last updated: 2026-07-09, on receipt of Andre Pietersen's
`TimeSeriesGet2` entitlement-unblock email (`DataSource=zax, Exchange=jse,
Frequency=monthly`); per-stock daily + monthly wiring live in
`/api/history/[sym]`, tier-2 panels (ALSI intraday, sector heatmap, ZAR
sovereign curve) still gated behind additional probe confirmation._