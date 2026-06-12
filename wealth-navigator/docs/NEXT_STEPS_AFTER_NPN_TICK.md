# Next Steps — After the First Live NPN Tick

> **Where we are (2026-06-12):** Railway `iress-ingest` worker is producing live
> NPN ticks into LIVE Supabase `stock_intraday_c` every ~15 s. `ok=1 errors=0
> empty=0`, session auto-rebuilds on dead session, `worker_session_metadata`
> holds the sticky `ApplicationID`. 4 NPN rows in `stock_intraday_c` spanning
> R 610.00 → R 609.00. All 172 unit tests pass (`bun run test`).
>
> **Goal of this doc:** get from "1 symbol ticking" to "10 symbols ticking +
> Vercel UI reading live ticks from Supabase" with the smallest safe diff and
> zero changes to the IRESS license seat. The Railway replica holds the
> only CT seat — every change below has to avoid a 25008 collision.

---

## 1. Watchlist expansion (immediate, no code change)

The worker reads `IRESS_WATCHLIST_SYMBOLS` from Railway env. The parser is
`parseList` in `workers/iress-ingest/src/env.ts` (split on `,`, trim,
uppercase, drop empties). Each symbol is then `normaliseSymbol`-d in
`quotes.ts` (strips `.JSE`, removes spaces, uppercases) before
`PricingQuoteGet`.

**Action — set this on Railway now:**

```
IRESS_WATCHLIST_SYMBOLS=AGL,BHG,CPI,FSR,MTN,NPN,PRX,SBK,SHP,SOL
```

- All 10 symbols already exist in LIVE `securities_c` (verified per
  `securities_c` query).
- The default 20-name fallback in `env.ts` (`DEFAULT_WATCHLIST`) is replaced
  the moment this env var is non-empty, so we intentionally do **not** include
  the extra 10 (`REM`, `BID`, `ABG`, `SLM`, `AMS`, `WHL`, `TBS`, `GRT`,
  `CLS`, `MNP`) until those rows are confirmed in `securities_c`.
- Restart the Railway service after setting the var (worker reads env at
  boot — `loadWorkerEnv()` is called once from `main.ts`).
- Watch logs for: `[iress-ingest] quote sync complete` with
  `requested=10 ok=N`. Expect ok≈10 mid-session; pre-open / halt symbols
  will land in `empty` and log `[iress-ingest] PricingQuoteGet(SYM) returned
  no trade (marketState=PRE_OPEN …)`.
- Verify in Supabase SQL editor:
  ```sql
  SELECT s.symbol, count(*) AS ticks
  FROM public.stock_intraday_c i
  JOIN public.securities_c s ON s.id = i.security_id
  WHERE i.timestamp > now() - interval '5 minutes'
  GROUP BY s.symbol
  ORDER BY s.symbol;
  ```
  Expect ≥ 1 row per active symbol within ~15 s of restart.

**Test coverage added:** `src/__tests__/worker-env.test.ts` (7 new tests,
172 total passing). Locks the comma/case/empty-filter/fallback behaviour and
pins the 10-symbol production list. Future typo in the env var surfaces
here, not in the Railway log stream.

---

## 2. Vercel: flip `USE_SUPABASE_QUOTES=true`

`/api/quotes` is **already** wired to read from Supabase when the flag is
on. See `src/app/api/quotes/route.ts`:

```28:32:wealth-navigator/src/app/api/quotes/route.ts
function isUseSupabaseQuotesEnabled(): boolean {
  const raw = process.env.USE_SUPABASE_QUOTES;
  if (!raw) return false;
  return raw === "1" || raw.toLowerCase() === "true";
}
```

…and the DB-first read path is in `src/lib/iress/live-queries.ts`
(`fetchQuotesFromSupabase` joins `securities_c` + `stock_intraday_c`,
returns `source: "supabase"` rows). When the flag is off, the existing
`live-queries` SOAP path stays untouched.

**Action — on Vercel project (Production environment):**

1. Set `USE_SUPABASE_QUOTES=true` (env-only; no rebuild of the worker).
2. Confirm `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are set to the
   **LIVE** project values (same project the worker is writing to).
3. Redeploy Vercel. Existing `live-queries` tests still pass (`fetchQuotes`
   and `fetchQuotesSafe` short-circuit to Supabase when the flag is on).
4. Smoke `/api/quotes?symbols=NPN,AGL,PRX&exchange=JSE` and check the
   response: `useSupabase: true`, `mode: "supabase"`,
   `supabaseCount ≥ 1`. The provenance badge on `/oems/integration` will
   flip to `SUPABASE` (or whatever the new source label is).
5. UI consumers that already call `fetchQuotes` / `fetchQuotesSafe`
   (notably `/oems` watchlist tiles, intraday card) get live Supabase
   reads for free — no client code change required.

**Tests covering this path:** `src/__tests__/supabase-quotes.test.ts` (5
tests) mocks the service-role client at the route boundary and asserts
`USE_SUPABASE_QUOTES=true` short-circuits IRESS. The flag-off fallback
to `seed-fallback` is also pinned.

---

## 3. Realtime subscriptions (optional but recommended)

`GO_LIVE_RUNBOOK.md` Phase 4 step 23 calls for a Supabase Realtime
subscription on `stock_intraday_c` so the OEMS dashboard updates within
~1 s of a worker write. **Not currently wired** — `/api/quotes` is polled,
not pushed.

**Action (low risk, no env changes):**

1. Add a client-side `supabase.channel('intraday').on('postgres_changes',
   …, schema: 'public', table: 'stock_intraday_c')` hook in the OEMS
   watchlist component. Tear down on unmount.
2. RLS is already permissive enough — `20260612000003_intraday_read_policies`
   grants SELECT to `anon` and `authenticated`.
3. `supabase_realtime` publication is set on the table (it ships with
   `stock_intraday_c` per the migration naming convention). Confirm:
   ```sql
   SELECT * FROM pg_publication_tables
   WHERE pubname = 'supabase_realtime' AND tablename = 'stock_intraday_c';
   ```
   If absent, run `ALTER PUBLICATION supabase_realtime ADD TABLE
   public.stock_intraday_c;` (idempotent on re-run).
4. Latency probe to verify the socket: `bun run scripts/realtime-quote-test.ts`
   (env: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
   `NEXT_PUBLIC_SUPABASE_ANON_KEY`). Expect `latencyMs` < 2000 on a
   healthy region.

**Why this is Phase 2 work, not Phase 1:** polling at 15 s (matching the
worker tick interval) is acceptable for the OEMS read path while the
Realtime plumbing is verified. The worker is the source of truth; the
client poll is just a re-read.

---

## 4. Mock-data cleanup (RT-LATENCY-* on TEST project)

`scripts/realtime-quote-test.ts` upserts a `securities_c` row with
`symbol = "RT-LATENCY-" + Date.now().toString(36)` on every run and
leaves the row behind when it exits. After several probe runs the TEST
project (`nnwzhxfjpjbzujevwzlh`) accumulates junk rows that are easy to
spot with:

```sql
-- Run on TEST project (NOT LIVE)
SELECT id, symbol, last_price
FROM public.securities_c
WHERE symbol LIKE 'RT-LATENCY-%'
ORDER BY symbol;
```

**Action — paste in TEST Supabase SQL editor:**

```sql
-- 1) Delete intraday ticks for probe rows
DELETE FROM public.stock_intraday_c
WHERE security_id IN (
  SELECT id FROM public.securities_c WHERE symbol LIKE 'RT-LATENCY-%'
);

-- 2) Delete the probe securities
DELETE FROM public.securities_c
WHERE symbol LIKE 'RT-LATENCY-%';
```

**Do not run on LIVE (`mfxnghmuccevsxwcetej`)** — the worker only writes
NPN-style symbols and there is no realtime probe path against LIVE.

**Prevention (optional, in a follow-up):** add a `DELETE` to
`scripts/realtime-quote-test.ts` after the round-trip so the probe is
self-cleaning. Not a blocker for the Vercel deploy.

---

## 5. Remaining TODOs from the audit (ordered)

> Sourced from `docs/GO_LIVE_RUNBOOK.md` Phases 4-5 and the prior audit
> notes. None of these are blockers for the 10-symbol + Vercel flip.

| # | Item | Phase | Action |
|---|---|---|---|
| 5.1 | Phase 1.5 migrations 9a–9d (`worker_session_metadata`, `oems_order_audit`, `intraday_read_policies`, `securities_with_latest_quote`) | Phase 1.5 | Confirm all four `to_regclass` / `pg_policies` / view queries return expected rows. Worker is writing — `worker_session_metadata` and `securities_with_latest_quote` are the highest value. |
| 5.2 | Replica count reminder on Railway service description | Phase 5 step 27 | Document: *“Single replica — one IRESS license seat.”* in Railway service notes. |
| 5.3 | Heartbeat alert (Vercel cron + Slack/PagerDuty) | Phase 5 step 28 | Wrap the `integration_worker_health` age query in a Vercel cron. Defer until the 10-symbol deploy is stable for one full market hour. |
| 5.4 | RLS for read-side tables | Phase 5 step 29 | Already covered by `20260612000003_intraday_read_policies.sql`. Verify the four policies exist and are `SELECT`-only. |
| 5.5 | `oems_order_audit` is empty today | Phase 1.5 step 9b | Worker does not write orders yet (`orders.ts` is read-only). Defer until the order-create path is wired. |
| 5.6 | Cleanup RT-LATENCY-* rows on TEST | This doc §4 | SQL above. |

---

## 6. What is **not** in scope (yet)

- **`OrderCreate3` / `OrderAmend2` / `OrderDelete` writes.** Worker only
  ingests quotes and polls `OrderPadGetByAccount` for fills. Real order
  routing from the OEMS UI is a separate design step.
- **Supabase Auth on the Vercel UI.** Login is still dev-only `admin` /
  `admin`. RLS is in place to make the swap a config flip; anon/authenticated
  policies exist on the read-side tables.
- **TEST → LIVE credential rotation on Vercel.** `CLOUD_DEPLOYMENT.md`
  already calls this out — confirm the Production env block in the Vercel
  project is pointing at `mfxnghmuccevsxwcetej` (LIVE), not the throwaway
  TEST project.
- **Worker auto-restart on 25008.** The sticky `ApplicationID` + boot
  force-kick (`worker_session.test.ts` covers this) handles the
  reattach-after-orphan case. `IRESS_FORCE_KICK_ALL=1` is a manual escape
  hatch; do **not** set it permanently.

---

## 7. Order of operations (one-liner)

1. **Railway → set `IRESS_WATCHLIST_SYMBOLS=AGL,BHG,CPI,FSR,MTN,NPN,PRX,SBK,SHP,SOL`, restart.**
2. **Verify 10-symbol ticks** in `stock_intraday_c` via the SQL editor.
3. **Vercel → set `USE_SUPABASE_QUOTES=true`, redeploy.**
4. **Smoke `/api/quotes?symbols=NPN,AGL,PRX`** — expect `useSupabase: true`.
5. **Cleanup RT-LATENCY-* on TEST project** (SQL above, no rush).
6. **Schedule the heartbeat alert cron** once the 10-symbol deploy has
   survived one full market hour (JSE close is 17:00 SAST).

No code change is required for steps 1-5. The only diff shipped in this
turn is the new `worker-env.test.ts` (7 tests, 172 total passing).
