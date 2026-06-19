# Phase 1 — Iress retail price cutover (operator runbook)

**Status:** ready for operator execution. Part of `docs/MINT_WN_MERGE_PLAN.md` (Phase 1).
**Authored:** 2026-06-19
**Goal:** move live price + intraday + `change_percent` for the RETAIL/LIVE DB (`mfxnghmuccevsxwcetej`) from Yahoo to Iress, and disconnect Yahoo for those fields — keeping a thin Yahoo job only for the gap fields.

> ⚠️ This touches a LIVE customer DB and the single Iress CT license seat. The agent has NOT run any of the live steps below. Steps B–D are operator actions on Railway / Supabase.

---

## 0. Open dependency #2 — RESOLVED: who writes `mfxng.stock_intraday_c` every ~15s?

**Answer: the wealth-navigator Railway worker's own quote loop.** Evidence in-repo:
- `docs/DATA_PROVENANCE.md:17` — "WORKER --|upsert every 15s|--> securities_c / stock_intraday_c".
- `docs/TWO_DATABASE_STRATEGY.md:53` — "`stock_intraday_c` (OEMS — populated by the Railway worker every 15s)".
- `docs/NEXT_STEPS_AFTER_NPN_TICK.md` — "NPN ticks into LIVE Supabase `stock_intraday_c` every ~15s".
- `workers/iress-ingest/src/env.ts` — `quoteIntervalSec` default `15` (`IRESS_WORKER_QUOTE_INTERVAL_SEC`).

The watchlist quote loop (`quotes.ts`, 12 symbols) already appends `stock_intraday_c` and (gated) `securities_c.last_price` to the LIVE retail DB. The broader full-universe `retail-ingest.ts` loop is separate and still shadow-gated.

**The legacy Mint CRM is NOT a competing 15s writer.** `MyMintAdmin-main/server.js` runs Yahoo **daily** (`startMarketDataScheduler`, 07:00 SAST) PATCHing the security master (`/rest/v1/securities`), and its only 15-**minute** loop is the health check. It never writes `stock_intraday_c`.

**Operator confirmation (read-only, do this first):**
```bash
# from wealth-navigator/ — needs RETAIL_SUPABASE_URL + RETAIL_SUPABASE_SERVICE_ROLE_KEY
# in gitignored .env.local (never commit / paste the key)
bun run scripts/scan-retail.ts
```
Inspect `intraday_recent` timestamps + cadence. If the newest rows match the worker's source/cadence and there's no foreign writer (edge function / pg_cron / other app), tick the box in `docs/DB_TOPOLOGY_DECISION.md` §105.

---

## 1. What the worker already does (no change needed)
- **Watchlist quote loop** (`quotes.ts`, ~15s, 12 symbols): RETAIL `stock_intraday_c` append + (gated) `securities_c.last_price`; INSTITUTIONAL `quote_snapshot_c` upsert.
- **Retail-ingest loop** (`retail-ingest.ts`, full `securities_c` universe, slower): writes RETAIL `securities_c.last_price` + `stock_intraday_c` **only when** `IRESS_RETAIL_INGEST=1` + `RETAIL_SUPABASE_URL` set + `IRESS_RETAIL_DRY_RUN=0`. Always best-effort upserts INSTITUTIONAL `quote_snapshot_c` (not a customer table).

## 2. Code change made this phase
- `retail-ingest.ts` now also sets `securities_c.change_percent`, derived from the IRESS quote (`(last − prevClose) / prevClose × 100`, scale-free). It is part of the same gated `update` — **inert until `IRESS_RETAIL_DRY_RUN=0`** and a worker redeploy. This matches the Yahoo job's `change_percent` parity. `change_price` is intentionally left until the per-symbol cents scale is verified.

---

## 3. Operator runbook (Railway worker + Supabase)

**Pre-reqs:** worker live on Iress (`IRESS_MODE=live`), single CT seat held by Railway only (do not run live Iress locally).

**Step A — apply review-only migration** (Supabase SQL editor, RETAIL project `mfxng`):
- `supabase/retail/20260614_add_price_source.sql` (additive, nullable `price_source` column; idempotent).

**Step B — SHADOW run** (writes nothing to retail; validates coverage + scaling). Set on the Railway worker:
```
IRESS_RETAIL_INGEST=1
RETAIL_SUPABASE_URL=https://mfxnghmuccevsxwcetej.supabase.co
RETAIL_SUPABASE_SERVICE_ROLE_KEY=<retail service role key>
IRESS_RETAIL_DRY_RUN=1          # shadow — no retail writes
RETAIL_PRICE_SOURCE_COL=1       # after Step A
# optional: IRESS_RETAIL_INGEST_INTERVAL_SEC=300
```
Watch the `retail_ingest_complete` event in logs: check `covered/requested` ratio and the `sample` array (`iressCents` vs `yahooCents`, `basis`). Confirm scaling is anchored (cents match the existing `last_price` magnitude) and coverage is acceptable.

**Step C — GO LIVE:** flip `IRESS_RETAIL_DRY_RUN=0` and redeploy. The worker now writes `securities_c.{last_price, change_percent, price_source='iress'}` + appends `stock_intraday_c` for covered symbols. Uncovered symbols are skipped (left for the thin Yahoo job — never stale).

**Step D — disconnect Yahoo for price/intraday:** stop the Yahoo writes to `last_price`/`change_percent` (legacy `syncAllSecuritiesFromYahoo`). Keep Yahoo **only** for the gap fields (`market_cap`, `pe_ratio`, `dividend_per_share`, `dividend_yield`, `ytd_performance`). In the merged app this thin Yahoo job becomes a Vercel cron (Phase 2); until the CRM is retired it can stay in `server.js` trimmed to gap fields only.

---

## 4. Success criteria
- Covered `mfxng.securities_c` rows show `price_source='iress'` with fresh `last_price` + `change_percent`.
- `stock_intraday_c` receiving Iress ticks; realtime UI (orderbook/investors) moves on its own.
- Yahoo no longer writes `last_price`/`change_percent` (only the gap fields).
- Coverage ratio acceptable; uncovered symbols remain fresh via the thin Yahoo job.

## 5. Rollback
- Set `IRESS_RETAIL_DRY_RUN=1` (back to shadow) → worker stops all retail writes immediately; restore the full Yahoo job. No DDL to revert (`price_source` is additive/nullable).

## 6. Remaining gap (tracked, not in this phase)
- `change_percent` — ✅ done in worker (this phase).
- `market_cap` / `pe_ratio` / dividends — keep thin Yahoo until Iress **fundamentals** entitlement (`SecurityGet`/company data).
- `ytd_performance` + `stock_returns_c` + `pbc_screen_results` — keep thin Yahoo/returns job until **`TimeSeriesGet2`** entitlement (Charles, `DFM@Mint`; blocked as of 2026-06-13).
- Optional enhancement: populate retail `stock_intraday_c.{1d_pct,1d_abs}` from `prevClose`.
