# Go-Live Runbook — Mint OEMS with IRESS + Supabase + Vercel

> **Audience:** Juan, executing the bring-up alone, with no destructive side-effects on the LIVE Supabase project (`mfxnghmuccevsxwcetej`).
> **Companions:** `docs/CLOUD_DEPLOYMENT.md` (topology + env contract), `docs/STACK_ARCHITECTURE.md` §5b (DB-first data flow), `TABLES.md` (schema reference), `workers/iress-ingest/README.md` (worker runbook).
> **Golden rules:**
> 1. The Railway worker **owns the IRESS license seat**. Do not run another IRESS client against `webservices-ct.iress.co.za` while the worker is up — that risks `25008` license contention.
> 2. The UI **never** talks to IRESS directly when `USE_SUPABASE_QUOTES=true`; the database is the source of truth for quotes.
> 3. Every SQL action on the LIVE database is **executed by Juan in the Supabase SQL editor** — the runbook never auto-applies DDL.

---

## Phase 0 — Local safety

1. **Confirm `supabase_creds` is git-ignored.** From the repo root:
   ```bash
   git check-ignore -v supabase_creds
   ```
   Expect a hit on `.gitignore` line 2. If not, add it and commit before proceeding.
2. **Confirm no destructive scripts in the working tree.** Grep for risky SQL keywords shipped to the repo (none should be in `wealth-navigator/`):
   ```bash
   rg -nP '\b(DROP|TRUNCATE|DELETE\s+FROM|UPDATE\s+\w+\s+SET)\b' wealth-navigator/supabase wealth-navigator/src
   ```
   The `integration_worker_health` migration uses `CREATE TABLE IF NOT EXISTS` (idempotent). Anything else containing `DROP` / `TRUNCATE` is a bug — stop and review.
3. **Confirm `bun run test` passes locally.** From `wealth-navigator/`:
   ```bash
   bun install
   bun run test
   ```
   The existing `auth-login.test.ts` and IRESS session-manager tests should be green. Do not proceed to Phase 1 with red tests.
4. **Sanity-check the worker entrypoint boots in dry-run.** From `wealth-navigator/`:
   ```bash
   IRESS_MODE=mock IRESS_WORKER_DRY_RUN=1 bun run worker:iress
   ```
   Expect: `[iress-ingest] starting` followed by `would upsert stock_intraday_c` lines. Stop with `Ctrl+C` (the worker calls `IRESSSessionEnd` on `SIGTERM` and waits the `LICENSE_RELEASE_DELAY_MS = 3000` to free the seat).

> **Pause for approval:** confirm Phase 0 outputs match the expectations above before touching the LIVE database.

---

## Phase 1 — Supabase LIVE database (read-only first, then migration)

> **Order matters:** verify before applying; apply before writes.

5. **Run the three pre-flight `SELECT`s in the Supabase SQL editor** (project `mfxnghmuccevsxwcetej`). They are read-only.
   ```sql
   -- 1) Confirm ingest targets exist with the columns the worker writes
   SELECT column_name, data_type
   FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name IN ('securities_c', 'stock_intraday_c')
   ORDER BY table_name, ordinal_position;

   -- 2) Confirm every symbol in IRESS_WATCHLIST_SYMBOLS resolves to a UUID
   --    (default: NPN, PRX, FSR, SBK, AGL, BHG, MTN, SOL, SHP, CPI)
   SELECT id, symbol FROM public.securities_c
   WHERE symbol IN ('NPN','PRX','FSR','SBK','AGL','BHG','MTN','SOL','SHP','CPI');

   -- 3) Confirm the heartbeat table does NOT yet exist (will be created in step 8)
   SELECT to_regclass('public.integration_worker_health') AS heartbeat_table;
   ```
6. **Map the gap.** Compare the symbols returned by step 5.2 against the planned `IRESS_WATCHLIST_SYMBOLS`. For every symbol missing from `securities_c`, choose one of:
   - **Reduce the watchlist** to the intersection (set `IRESS_WATCHLIST_SYMBOLS=…` to only the symbols present).
   - **Insert minimal rows.** A safe `INSERT` template — **review each row** and only run on LIVE after a colleague sanity-checks the data:
     ```sql
     INSERT INTO public.securities_c (symbol, name, asset_type, sector, last_price)
     VALUES
       ('NPN', 'Naspers Ltd',                   'stock', 'Media',     0),
       ('PRX', 'Prosus N.V.',                   'stock', 'Internet',  0),
       ('FSR', 'FirstRand Ltd',                 'stock', 'Banks',     0),
       ('SBK', 'Standard Bank Group Ltd',       'stock', 'Banks',     0),
       ('AGL', 'Anglo American plc',            'stock', 'Mining',    0),
       ('BHG', 'Brait plc',                     'stock', 'Investment',0),
       ('MTN', 'MTN Group Ltd',                 'stock', 'Telecoms',  0),
       ('SOL', 'Sasol Ltd',                     'stock', 'Chemicals', 0),
       ('SHP', 'Shoprite Holdings Ltd',         'stock', 'Retail',    0),
       ('CPI', 'Capitec Bank Holdings Ltd',     'stock', 'Banks',     0)
     ON CONFLICT (symbol) DO NOTHING;
     ```
     > **Juan runs in SQL Editor.** Confirm `last_price` is the right place-holder — the worker updates this on every successful tick. The migration does **not** touch this table.
7. **Decide whether the runbook can continue.** Every watchlist symbol must appear in `securities_c` **before** the worker writes. If `last_price` is 0 across the board, the worker will overwrite it on the first successful tick — that is the intended bootstrap.
8. **Apply the heartbeat migration** via the Supabase SQL editor (paste, do not auto-deploy):
   ```sql
   -- contents of supabase/migrations/20260611000000_integration_worker_health.sql
   CREATE TABLE IF NOT EXISTS public.integration_worker_health (
     worker_id text PRIMARY KEY,
     service_name text NOT NULL DEFAULT 'iress-ingest',
     status text NOT NULL DEFAULT 'unknown',
     last_heartbeat_at timestamptz NOT NULL DEFAULT now(),
     last_quote_sync_at timestamptz,
     iress_mode text,
     metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
     updated_at timestamptz NOT NULL DEFAULT now()
   );

   COMMENT ON TABLE public.integration_worker_health IS
     'Railway/long-running worker heartbeats (IRESS ingest, future pipelines).';

   ALTER TABLE public.integration_worker_health ENABLE ROW LEVEL SECURITY;
   ```
   The migration is idempotent (`IF NOT EXISTS` + RLS re-enable). No service_role policies are added; service_role bypasses RLS by design.
9. **Re-run the third pre-flight query to confirm the table exists:**
   ```sql
   SELECT to_regclass('public.integration_worker_health') AS heartbeat_table;
   -- expect: integration_worker_health
   ```
   After the worker first heartbeat (Phase 2 step 16), verify the row:
   ```sql
   SELECT worker_id, status, iress_mode, last_heartbeat_at, last_quote_sync_at
   FROM public.integration_worker_health
   ORDER BY last_heartbeat_at DESC;
   ```

> **Pause for approval:** confirm `integration_worker_health` is visible in the dashboard and `securities_c` covers every watchlist symbol.

---

## Phase 1.5 — Additional schema for LIVE-DATA-READY (apply in this exact order)

> **Why this phase exists:** Phase 1 only added `integration_worker_health`. To run the worker writing to LIVE and the UI reading from Supabase, you need four more review-only migrations. None contains `DROP` / `TRUNCATE` / `DELETE`; all are idempotent (`IF NOT EXISTS` + `CREATE OR REPLACE VIEW` + `DROP POLICY IF EXISTS` patterns only). They are **review-only** — do not run them automatically; paste each block into the Supabase SQL editor and confirm the result.

Apply them in this order. Each one builds on the previous (e.g. the `securities_with_latest_quote` view depends on `securities_c` and `stock_intraday_c` being readable to whoever queries the view).

9a. **Paste** `supabase/migrations/20260612000001_worker_session_metadata.sql` into the SQL editor and run.
    - Creates `public.worker_session_metadata` (worker_id PK, application_id, iress_session_key, iress_hostname, last_started_at, expires_at, metadata jsonb).
    - RLS enabled, no policies → anon/authenticated denied, service_role full.
    - Verification:
      ```sql
      SELECT to_regclass('public.worker_session_metadata') AS table_name;
      -- expect: worker_session_metadata
      ```

9b. **Paste** `supabase/migrations/20260612000002_oems_order_audit.sql` into the SQL editor and run.
    - Creates `public.oems_order_audit` with CHECK constraints on `side` (`buy|sell|sell_short|buy_cover`) and `status` (`created|working|filled|partial|cancelled|rejected|amended`).
    - Indexes on `order_id`, `client_account`, `created_at DESC`.
    - RLS enabled, no policies → writes are service_role only.
    - Verification:
      ```sql
      SELECT to_regclass('public.oems_order_audit') AS table_name;
      -- expect: oems_order_audit
      ```

9c. **Paste** `supabase/migrations/20260612000003_intraday_read_policies.sql` into the SQL editor and run.
    - `ALTER TABLE … ENABLE ROW LEVEL SECURITY` on `stock_intraday_c` and `securities_c`.
    - Drops + re-creates four SELECT-only policies (`anon` and `authenticated` on both tables).
    - **No INSERT / UPDATE / DELETE policies** — writes remain service_role.
    - Verification:
      ```sql
      SELECT tablename, policyname, cmd
      FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename IN ('stock_intraday_c', 'securities_c')
      ORDER BY tablename, policyname;
      -- expect: 4 rows, all 'SELECT'
      ```

9d. **Paste** `supabase/migrations/20260612000004_iress_instrument_enrichment.sql` into the SQL editor and run.
    - Creates / replaces `public.securities_with_latest_quote` view joining the latest `stock_intraday_c` per `security_id`.
    - RLS inherited from the base tables.
    - Verification:
      ```sql
      SELECT * FROM public.securities_with_latest_quote LIMIT 5;
      -- expect: rows with security_id, symbol, latest_intraday_price, latest_intraday_at
      ```

> **Pause for approval:** confirm all four `to_regclass` / `pg_policies` / view queries return expected rows before Phase 2.

---

## Phase 2 — Railway IRESS worker

10. **Local mock dry-run.** From `wealth-navigator/`:
    ```bash
    IRESS_MODE=mock IRESS_WORKER_DRY_RUN=1 bun run worker:iress
    ```
    Expect `would upsert stock_intraday_c` lines for every watchlist symbol. Stop with `Ctrl+C` — confirm the shutdown hook logs `SIGTERM: releasing IRESS license…` (mock mode skips the SOAP call but still exercises the path).
11. **Local live dry-run (real SOAP, no DB writes).** Requires `IRESS_USERNAME` / `IRESS_PASSWORD` / `IRESS_COMPANY_NAME` in env (do not commit). From `wealth-navigator/`:
    ```bash
    IRESS_MODE=live IRESS_WORKER_DRY_RUN=1 \
      IRESS_USERNAME=... IRESS_PASSWORD=... IRESS_COMPANY_NAME=Mint \
      IRESS_BASE_URL=https://webservices-ct.iress.co.za/v4 \
      bun run worker:iress
    ```
    Expect one `[iress-ingest] quote sync complete (N symbols)` line per cycle. Failures on a single symbol should be `WARN` and continue; if every symbol fails with `25001` / `25008`, stop — your `IRESS_*` creds are wrong or another process holds the seat.
12. **Local staging write against one symbol (LIVE database, controlled).** Pin the watchlist to a single JSE top-40 name you have confirmed is in `securities_c` from step 5.2:
    ```bash
    IRESS_MODE=live IRESS_WORKER_DRY_RUN=0 SUPABASE_ALLOW_WRITES=1 \
      IRESS_USERNAME=... IRESS_PASSWORD=... IRESS_COMPANY_NAME=Mint \
      IRESS_BASE_URL=https://webservices-ct.iress.co.za/v4 \
      SUPABASE_URL=https://mfxnghmuccevsxwcetej.supabase.co \
      SUPABASE_SERVICE_ROLE_KEY=... \
      IRESS_WATCHLIST_SYMBOLS=NPN \
      IRESS_WORKER_QUOTE_INTERVAL_SEC=15 \
      IRESS_WORKER_HEARTBEAT_SEC=30 \
      bun run worker:iress
    ```
    In a second terminal, verify the writes:
    ```sql
    -- heartbeat
    SELECT worker_id, status, iress_mode, last_heartbeat_at
    FROM public.integration_worker_health
    ORDER BY last_heartbeat_at DESC LIMIT 1;

    -- intraday ticks (should grow by ~1 every quoteIntervalSec)
    SELECT current_price, timestamp
    FROM public.stock_intraday_c
    WHERE security_id = (SELECT id FROM public.securities_c WHERE symbol = 'NPN')
    ORDER BY timestamp DESC LIMIT 10;
    ```
    Stop the worker with `Ctrl+C` after a few cycles. Confirm the shutdown heartbeat wrote `status='error'` with `metadata.shutdown='SIGINT'` (expected on graceful exit).
13. **Deploy to Railway.**
    1. Create a **new service** in the Mint Railway project.
    2. **Root directory:** `wealth-navigator` (the Dockerfile copies `workers/iress-ingest` and the shared `src/`).
    3. **Builder:** Dockerfile (Railway reads `workers/iress-ingest/railway.toml` automatically).
    4. **Replicas:** **1** — the worker holds a single IRESS license seat; scaling out would create `25008` collisions. Document the constraint in the service description.
    5. **Env vars** (from `CLOUD_DEPLOYMENT.md` Railway table). At minimum:
       ```
       IRESS_MODE=live
       IRESS_USERNAME=...
       IRESS_PASSWORD=...
       IRESS_COMPANY_NAME=Mint
       IRESS_BASE_URL=https://webservices-ct.iress.co.za/v4
       IRESS_WATCHLIST_SYMBOLS=NPN,PRX,FSR,SBK,AGL,BHG,MTN,SOL,SHP,CPI
       SUPABASE_URL=https://mfxnghmuccevsxwcetej.supabase.co
       SUPABASE_SERVICE_ROLE_KEY=...
       IRESS_WORKER_DRY_RUN=0
       SUPABASE_ALLOW_WRITES=1
       WORKER_ID=iress-ingest-1
       IRESS_WORKER_HEARTBEAT_SEC=30
       IRESS_WORKER_QUOTE_INTERVAL_SEC=15
       ```
       `IRESS_APPLICATION_LABEL` is optional but helps in IRESS admin logs; persist a stable `ApplicationID` per service (see Phase 5 step 23).
    6. **Trigger deploy.** Watch the Railway logs for `[iress-ingest] starting` → `quote sync complete (10 symbols)`.
14. **Verify the Railway worker on LIVE.**
    ```sql
    SELECT worker_id, status, iress_mode, last_heartbeat_at, last_quote_sync_at, metadata
    FROM public.integration_worker_health;

    -- Tick volume per symbol, last 5 minutes
    SELECT s.symbol, count(*) AS ticks
    FROM public.stock_intraday_c i
    JOIN public.securities_c s ON s.id = i.security_id
    WHERE i.timestamp > now() - interval '5 minutes'
    GROUP BY s.symbol
    ORDER BY s.symbol;
    ```
    Expect ≥ 1 row in `integration_worker_health` (status `healthy`) and the tick counts to grow on every refresh.

> **Pause for approval:** confirm the Railway worker is producing live ticks for every watchlist symbol before pointing the UI at it.

---

## Phase 3 — Vercel (UI)

15. **Set Vercel production env vars** (Project → Settings → Environment Variables, Production):
    ```
    IRESS_MODE=mock                          # start in mock to confirm smoke; flip to live in step 19
    IRESS_USERNAME=...
    IRESS_PASSWORD=...
    IRESS_COMPANY_NAME=Mint
    IRESS_BASE_URL=https://webservices-ct.iress.co.za/v4
    IRESS_APPLICATION_LABEL=Mint-OEMS-Production
    NEXT_PUBLIC_SUPABASE_URL=https://mfxnghmuccevsxwcetej.supabase.co
    NEXT_PUBLIC_SUPABASE_ANON_KEY=...
    SUPABASE_URL=https://mfxnghmuccevsxwcetej.supabase.co
    SUPABASE_SERVICE_ROLE_KEY=...            # Vercel encrypted env
    USE_SUPABASE_QUOTES=false                # keep UI on the existing path; toggle in Phase 4
    ```
    The three `IRESS_USERNAME` / `IRESS_PASSWORD` / `IRESS_COMPANY_NAME` vars are **server-only** — never prefix with `NEXT_PUBLIC_`.
16. **Smoke `/api/iress/health`** (still with `IRESS_MODE=mock` first; expect the route to return `cached: false` because mock mode skips session start).
    ```bash
    curl -sS https://<your-vercel-domain>/api/iress/health | jq
    ```
17. **Smoke the OEMS dashboard in mock mode** (UI unchanged):
    - `/oems` — landing tiles render, mock tick stream via `/api/ticks`.
    - `/oems/holdings` — seed valuations display, no 500s.
    - `/oems/blotter` — `fetchOrdersByAccount` falls back to seed.
    - `/oems/integration` — provenance badge says `MOCK` or `SEED`.
18. **Flip `IRESS_MODE=live` on Vercel production** and redeploy. Re-hit `/api/iress/health`:
    ```bash
    curl -sS https://<your-vercel-domain>/api/iress/health | jq
    ```
    Expect `cached: true`, `valid: true`, and a non-empty `services: []` array (`IOSPlus`, etc.) once `getMintSession()` has warmed up. If `cached: false` and the request returns quickly, IRESS session start failed — check Vercel function logs for the SOAP error.
19. **Verify the UI still renders live data without `USE_SUPABASE_QUOTES`.** With `IRESS_MODE=live` and `USE_SUPABASE_QUOTES=false`, `live-queries.ts` is the read path. `/oems` should display the same numbers the worker just wrote (because the Vercel BFF is calling `pricingQuoteGet` on demand — a second IRESS session). Note: this is **the legacy path** and is what Phase 4 retires for the hot read path.

> **Pause for approval:** confirm `/oems` and `/oems/holdings` render with `IRESS_MODE=live` and the Vercel health check shows a valid session.

---

## Phase 4 — Wire UI to Supabase (DB-first read path)

> Implementation steps belong in code reviews, not in the SQL editor. This phase describes the **integration test** Juan must pass before flipping the production flag.

20. **Implement the flag check in `src/lib/iress/live-queries.ts`** (or a sibling helper). When `USE_SUPABASE_QUOTES=true`:
    - Read `stock_intraday_c` and `securities_c` via the service-role Supabase client.
    - Do **not** call `getMintSession()` / `pricingQuoteGet` on the read path. The IRESS session stays idle on the UI tier.
    - Tag the response with `source: "supabase"` in addition to the existing `"live" | "seed-fallback" | "mock"` enum.
    - Keep `seedQuoteFor` as the ultimate fallback so the UI never crashes if a query times out.
21. **Add `/api/quotes`** as a server route backed by `createServiceRoleClient()` from `src/lib/supabase/server.ts`. Shape:
    - `GET /api/quotes?symbols=NPN,PRX,…` → array of `{ symbol, last_price, timestamp, source }`.
    - RLS-safe because service role; later swap to anon when real auth is wired.
    - Default behaviour when `USE_SUPABASE_QUOTES=false`: route returns 501 / empty array, UI falls back to existing `live-queries` path.
22. **Update UI consumers** (`/oems`, `/oems/holdings`, intraday card) to fetch from `/api/quotes` instead of calling `live-queries` directly. Keep the response shape identical so callers do not need to branch on the flag.
23. **(Optional but recommended) Add a Supabase Realtime subscription** on `stock_intraday_c` so the OEMS dashboard updates within ~1 s of a worker write. Subscribe per `security_id`; tear down on unmount.
24. **Tests.**
    - Mock the Supabase client at the route boundary; assert the route returns rows in the expected shape.
    - Verify `USE_SUPABASE_QUOTES=false` keeps the legacy path green (existing `auth-login.test.ts` and any `live-queries` tests must still pass).
    - Confirm the `seed-fallback` path still triggers when the Supabase client errors (set `SUPABASE_URL` to an invalid host in CI).
25. **Deploy the UI change to a Vercel preview branch** with `USE_SUPABASE_QUOTES=true` set as a preview-only env var. Compare `/oems` to production: numbers should match the worker ticks from step 14.
26. **Promote to production** by setting `USE_SUPABASE_QUOTES=true` in Vercel production env, redeploying. Monitor the OEMS dashboard for at least one full market-hour cycle:
    - All watchlist tiles update.
    - The provenance badge on `/oems/integration` now reads `SUPABASE` (or whatever the new source label is) instead of `LIVE` (the IRESS BFF call) or `MOCK`.

> **Pause for approval:** the UI must show live ticks sourced from Supabase before Phase 5.

---

## Phase 5 — Hardening

27. **Replica count reminder.** Document in the Railway service description: *“Single replica — one IRESS license seat. Do not scale up without re-architecting for license pooling.”* Mirror the note in `workers/iress-ingest/README.md`.
28. **Heartbeat alert.** Add a Vercel cron or a small monitoring endpoint that pages when `integration_worker_health.last_heartbeat_at` is older than 2 × `IRESS_WORKER_HEARTBEAT_SEC` (i.e. > 2 min by default). The query:
    ```sql
    SELECT worker_id, EXTRACT(EPOCH FROM (now() - last_heartbeat_at)) AS age_sec
    FROM public.integration_worker_health
    WHERE now() - last_heartbeat_at > interval '2 minutes';
    ```
    For a starter setup, wrap the query in a Vercel cron route and push to Slack / PagerDuty.
29. **RLS for read-side tables.** **Juan runs in SQL Editor.** Service role bypasses RLS, so the worker is unaffected. The UI will eventually need anon/authenticated read access:
    ```sql
    -- Read-only policies for stock_intraday_c and securities_c.
    -- Lock down writes to service_role only.
    ALTER TABLE public.stock_intraday_c ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.securities_c    ENABLE ROW LEVEL SECURITY;

    -- Drop any existing policies if you re-run this block.
    DROP POLICY IF EXISTS "anon read stock_intraday_c" ON public.stock_intraday_c;
    DROP POLICY IF EXISTS "auth read stock_intraday_c" ON public.stock_intraday_c;
    DROP POLICY IF EXISTS "anon read securities_c"    ON public.securities_c;
    DROP POLICY IF EXISTS "auth read securities_c"    ON public.securities_c;

    CREATE POLICY "anon read stock_intraday_c"
      ON public.stock_intraday_c
      FOR SELECT TO anon USING (true);

    CREATE POLICY "auth read stock_intraday_c"
      ON public.stock_intraday_c
      FOR SELECT TO authenticated USING (true);

    CREATE POLICY "anon read securities_c"
      ON public.securities_c
      FOR SELECT TO anon USING (true);

    CREATE POLICY "auth read securities_c"
      ON public.securities_c
      FOR SELECT TO authenticated USING (true);
    ```
    No `INSERT` / `UPDATE` / `DELETE` policies are created — only service_role (the worker) can write. The migration `20260611000000_integration_worker_health.sql` already leaves `integration_worker_health` locked down (no policies) so infra heartbeats stay private.
30. **Audit log table for OEMS orders.** Not in `TABLES.md` — proposed columns for a **review-only** migration (do not apply yet):
    ```sql
    -- REVIEW ONLY — proposed oems_order_audit
    CREATE TABLE public.oems_order_audit (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      order_tag text NOT NULL UNIQUE,           -- IRESS OrderTag idempotency key
      user_id uuid REFERENCES auth.users(id),    -- null until auth is wired
      account_code text NOT NULL,
      symbol text NOT NULL,
      side text NOT NULL CHECK (side IN ('BUY','SELL')),
      quantity numeric NOT NULL CHECK (quantity > 0),
      price_cents numeric,
      order_type text NOT NULL,                  -- MKT, LMT, STP …
      status text NOT NULL,                      -- PENDING, ACK, FILLED, PARTIAL, CANCELLED, REJECTED
      iress_request_id text,                     -- correlation back to SOAP ResponseID
      raw_response jsonb,                        -- last SOAP payload for support
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE INDEX oems_order_audit_user_idx     ON public.oems_order_audit (user_id);
    CREATE INDEX oems_order_audit_account_idx  ON public.oems_order_audit (account_code);
    CREATE INDEX oems_order_audit_status_idx   ON public.oems_order_audit (status);

    ALTER TABLE public.oems_order_audit ENABLE ROW LEVEL SECURITY;
    -- service_role writes; users read their own (anon policies added when auth lands).
    ```
    > **Juan runs in SQL Editor** *only after* the order-pad code path is ready. Keep the file in `supabase/migrations/` as a review artefact for now.
31. **`ApplicationID` persistence per Railway service.** The shared `buildApplicationId` in `src/lib/iress/index.ts` already embeds hostname + GUID. For Railway, set `IRESS_APPLICATION_LABEL=Mint-OEMS-Railway-1` (or similar) and pin a `RAILWAY_REPLICA_ID` (or reuse `RAILWAY_SERVICE_NAME`/`RAILWAY_DEPLOYMENT_ID`) so that restarts of the same replica recover the same label. This avoids creating a new IRESS session per restart.
32. **Graceful deploys (current limitation).** Document this in `workers/iress-ingest/README.md` and in the Railway service description:
    - The worker has a single replica and one IRESS license. A rolling deploy kills the old container (SIGTERM → `IRESSSessionEnd` + 3 s release) and starts the new one. There is a **brief 3-second window with no license**; `*Updates` long-poll loops in the future must tolerate this gap.
    - **A 2-replica drain is NOT safe** today — both replicas would briefly hold the license (25008 collision) before the SIGTERM handler frees the old one. If you need zero-downtime deploys, the design needs (a) license pooling on the IRESS side or (b) a queue-based handoff (Redis Stream) that the new replica drains. File this as a follow-up before scaling.
    - For now, accept the 3-second gap and rely on Railway’s automatic restart policy (`on_failure`, max 5 retries — already set in `railway.toml`).

> **Pause for approval:** confirm the RLS policies, audit-log migration review, and ApplicationID approach are acceptable before Phase 6.

---

## Phase 6 — Rollout checklist (final)

Execute in this exact order. Each row has a verification step you can run to confirm success.

| # | Step | Owner | Verification |
|---|------|-------|--------------|
| 1 | Pre-flight SELECTs (step 5) | Juan (SQL editor) | All three queries return expected rows |
| 2 | `securities_c` gap fill (step 6) | Juan (SQL editor) | Every watchlist symbol has a row |
| 3 | Apply `integration_worker_health` migration (step 8) | Juan (SQL editor) | `to_regclass` returns the table name |
| 4 | Worker mock dry-run (step 10) | Juan (local) | `would upsert stock_intraday_c` lines |
| 5 | Worker live dry-run (step 11) | Juan (local) | `quote sync complete (N symbols)` |
| 6 | Worker staging write (step 12) | Juan (local) | `stock_intraday_c` rows for the test symbol grow |
| 7 | Deploy Railway worker (step 13) | Juan (Railway) | Service logs show `starting` + `quote sync complete` |
| 8 | Verify LIVE ticks (step 14) | Juan (SQL editor) | `integration_worker_health` row + ticking `stock_intraday_c` |
| 9 | Set Vercel env, smoke mock (steps 15–17) | Juan (Vercel) | `/oems` and `/oems/holdings` render without 500s |
| 10 | Flip Vercel `IRESS_MODE=live` (steps 18–19) | Juan (Vercel) | `/api/iress/health` returns `valid: true` |
| 11 | Wire UI to Supabase read path (steps 20–24) | Engineering PR → Juan (Vercel preview) | Preview matches worker ticks; legacy path still green |
| 12 | Promote `USE_SUPABASE_QUOTES=true` (step 26) | Juan (Vercel) | Dashboard tile, blotter, intraday card all show live data with the new source badge |
| 13 | Heartbeat alert + RLS + audit-log review (steps 28–30) | Juan (SQL editor + monitoring) | Alert fires when worker is killed; policies in place |
| 14 | Document replica / graceful-deploy limits (steps 27, 32) | Juan | Notes in Railway service description and worker README |

### Common failure modes & fixes

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| `25008` license error from IRESS | Another process holds the seat (e.g. dev server with `IRESS_MODE=live` or a probe script) | Stop all other IRESS clients; `tearDownMintSession` from the offending process; restart the worker. With two Railway replicas — scale back to one (step 27). |
| `stock_intraday_c` stays empty for some symbols | Watchlist symbol missing from `securities_c` | Re-run step 5.2; either narrow `IRESS_WATCHLIST_SYMBOLS` or `INSERT` the missing rows in the SQL editor. |
| `integration_worker_health` row never appears | Worker crashed before first heartbeat, or `SUPABASE_ALLOW_WRITES=0` is still set | Check Railway deploy logs and the env block; set `IRESS_WORKER_DRY_RUN=0` and `SUPABASE_ALLOW_WRITES=1`; restart. |
| Heartbeat present but `last_quote_sync_at` stays null | `securities_c` lookup returns zero rows; worker logs `no securities_c row for SYM — skipping write` | Same as the empty-tick row above; the heartbeat still updates so the alert won’t fire — add a derived check (compare `last_quote_sync_at` age against `last_heartbeat_at`). |
| UI still shows seed data after `USE_SUPABASE_QUOTES=true` | Flag not set on the **production** env, or `/api/quotes` not hit (cache layer) | Confirm Vercel production env (preview branches have their own scope); clear the route cache; re-curl `/api/quotes?symbols=NPN` to confirm rows. |
| `25001 invalid session` storms in worker logs | IRESS session expired and the auto-recover path is not triggered | `WorkerSessionManager.invalidate()` + `getSession()` already handles this; if it persists, the SOAP call is racing the cache — restart the worker (it will rebuild the cache). |
| Heartbeat alert fires immediately after deploy | `now() - last_heartbeat_at` window is too tight for Railway restart latency | Raise the alert window to 2 × `IRESS_WORKER_HEARTBEAT_SEC` plus the deploy’s worst-case container start time (default 60 s in step 28 is comfortable). |

---

## Appendix — proposed follow-up migrations (not in `TABLES.md`)

These are surfaced here so the runbook can land without blocking on them, but they need their own review PRs and `TABLES.md` updates.

| Migration (proposed filename) | Purpose | Tables touched | Status |
|-------------------------------|---------|----------------|--------|
| `20260611000000_integration_worker_health.sql` | Heartbeat table for the Railway worker | new `integration_worker_health` | **Ready to apply** (step 8) |
| `20260612000000_oems_order_audit.sql` | OEMS order audit trail | new `oems_order_audit` | **Review only** (step 30) |
| `20260612000000_rls_read_policies_quotes.sql` | Read-side RLS policies for `stock_intraday_c` and `securities_c` | alters existing tables | **Ready to apply** after step 29 review |
| `20260612000000_strate_recon_state.sql` (future) | Reconciliation state + last successful STRATE / IPS feed run | new `recon_runs` | Not in this runbook; back-of-the-envelope only |
| `20260612000001_worker_session_metadata.sql` | Sticky ApplicationID per worker | new `worker_session_metadata` | **Ready to apply** (Phase 1.5 step 9a) |
| `20260612000002_oems_order_audit.sql` | OEMS order audit mirror | new `oems_order_audit` | **Ready to apply** (Phase 1.5 step 9b) |
| `20260612000003_intraday_read_policies.sql` | anon / authenticated SELECT on `stock_intraday_c` + `securities_c` | alters existing tables | **Ready to apply** (Phase 1.5 step 9c) |
| `20260612000004_iress_instrument_enrichment.sql` | Helper view `securities_with_latest_quote` | new view | **Ready to apply** (Phase 1.5 step 9d) |
| `20260612000000_worker_session_metadata.sql` (legacy filename) | Superseded by `20260612000001_…` | — | Renamed during LIVE-DATA-READY pass |

`TABLES.md` does not yet document `integration_worker_health` or `oems_order_audit`. After step 8 (and the future audit-log migration), append both tables to `TABLES.md` under a new **⚙️ Infrastructure** section so the schema reference stays complete.

---

*Last updated: June 2026. Phases 0–4 are required for the first production cut. Phases 5–6 are the hardening pass that must land within the same sprint as the OEMS pilot.*
