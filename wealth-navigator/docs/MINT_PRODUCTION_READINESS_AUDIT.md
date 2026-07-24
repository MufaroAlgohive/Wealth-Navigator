# MINT / Wealth Navigator — Production Readiness Audit

**Date:** 2026-07-24 · **Method:** 14-agent parallel audit (7 dimensions × deep-dive + adversarial verification), all read-only, verified against live prod DBs, both repos, Railway, and Vercel config. **Nothing was changed in production.**

## VERDICT: 🔴 NO-GO

Not production-ready. **29 confirmed critical/high issues.** Worse: **three of them are active, exploitable exposures right now** (not just go-live risks) — a live financial/KYC data leak path, a committed production admin key, and unauthenticated service-role endpoints. Those should be treated as a security incident and fixed **independently of** any go-live decision.

The good news: **your database is not corrupted**, the current *code* is mostly correct, and every fix below is safe if staged (preview/dev first, review-only SQL, key rotation). Read-path between WN and MINT is genuinely in sync.

---

## ⛔ P0 — ACTIVE EXPOSURES (fix now, regardless of go-live)

### P0.1 — The public anon key can read/write client wallets, bank data, credit & KYC
**Confirmed** via `has_table_privilege()` on live retail prod: `anon` **and** `authenticated` hold full SELECT/INSERT/UPDATE/DELETE on ~28 RLS-disabled tables — including **`wallets`, `truid_bank_snapshots` (open-banking), `credit_transactions_history`, `loan_application`, `loan_engine_score`, `aum_fee_transactions`, `user_onboarding_pack_details` (KYC), `stock_intraday_c`, `strategies_c`**. The MINT browser app ships the retail **anon key to the client** (`VITE_SUPABASE_ANON_KEY` + `/api/config`), so it is public. **Anyone on the internet who reads that key can read and modify customer money and KYC records.** This is a POPIA-grade breach path.
**Fix (moderate, preview-branch first):** for each table, add PostgREST-matching RLS policies **before** enabling RLS. Owner-scoped tables (`user_id`/`id`) → `USING (user_id = auth.uid())`; admin-only → `USING (EXISTS (SELECT 1 FROM admin_profiles ap WHERE ap.user_id = auth.uid()))`. Then `ALTER TABLE … ENABLE ROW LEVEL SECURITY;` and `REVOKE … FROM anon, authenticated` where only the service-role BFF should touch it. Verify the app's real access pattern (service-role vs client) per table first — enabling RLS blind can break reads.

### P0.2 — Live retail `service_role` key committed to the repo
**Confirmed:** a live retail **`service_role` JWT (full RLS bypass, valid to 2036)** is committed at `wealth-navigator/docs/TWO_DATABASE_STRATEGY.md:278` — on `main` HEAD, throughout history, and on a backup branch.
**Fix (moderate):** 1) Rotate the retail `service_role` **and** `anon` keys (Supabase → Settings → API → Rotate). 2) Update every consumer (Railway worker, Vercel WN env, MINT anon key) and redeploy. 3) Scrub the literals from the doc (history scrub optional but the rotation is what matters).

### P0.3 — MINT Vercel crons are unauthenticated + service-role + open CORS
**Confirmed:** `api/prices/eod-save.js`, `api/gift/expire.js`, `api/aum-fee/run.js` have **no caller auth**, use the **service-role** client (bypasses RLS), behind `Access-Control-Allow-Origin: *`. Anyone can invoke RLS-bypassing DB writes on the already-maxed DB. `aum-fee/run?settle=force` is a latent money-movement path the moment `AUM_SETTLE_ENABLED` is set.
**Fix (moderate):** add the same guard WN already uses — require `Authorization: Bearer ${CRON_SECRET}` (Vercel injects it automatically when `CRON_SECRET` is set), else 401. This is a change **in MINT-DEVELOPMENT** that must ship before/with the next MINT-LIVE deploy.

### P0.4 — Storage buckets expose signed agreements & proof-of-payment
**Confirmed:** the *private* `signed-agreements` bucket has a **PUBLIC read** policy; the public `documents` bucket holds proof-of-payment; broad cross-user read policies exist.
**Fix (moderate):** drop the blanket read policy; scope to `split_part(name,'/',1)=auth.uid()::text` + admin variant; set `documents`/`exco_documents` to `public=false` and serve via signed URLs.

---

## 🚧 P1 — GO-LIVE BLOCKERS (by area)

### Answer to "are WN + MINT both on IRESS production + in sync?"
**No.** IRESS is prod-connected but **not writing prices** (`IRESS_RETAIL_INGEST=0`, all dry-run). **Yahoo is the sole price feed**, from *two* uncoordinated writers: MINT `server/index.cjs` (`refreshIntradayPrices`/`refreshHeldSecurities`) **and** the external **Qentari** pusher (`docker-compose-pusher.yml`, off-repo). Both apps read the same retail tables, so **read-path sync is confirmed**, and Yahoo's write path is scale-safe today. To move to IRESS safely, these **must** be resolved first:
- **P1.1 (critical):** No kill-switch — enabling IRESS creates **two simultaneous writers** to the same price columns. Add a disable flag to the MINT loops + stop Qentari, and cut over single-writer (shadow → stop Yahoo → enable IRESS). Never overlap.
- **P1.2 (critical):** The **×100 perpetuation fix is coded but not wired** — `chooseDisplayCents` still self-anchors to the mutable `last_price` (only 2-arg calls; `scale_ref_cents` unmigrated/unused). Enabling IRESS writes re-arms the corruption. Apply the additive `scale_ref_cents` migration, backfill from today's clean values, wire the 3rd arg. *(safe)*
- **P1.3 (high):** IRESS retail-ingest writes an **incomplete column set** (no `1d_pct`/`1d_abs`/`change_price`) vs what MINT reads → daily-change UI breaks post-cutover. *(safe)*
- **P1.4 (high):** The **Qentari pusher is unversioned/uncontrolled** — bring under ops control before cutover.
- **P1.5 (high):** **Micro tier at ~99.7% CPU cannot absorb a second full-universe writer** — upgrade compute first.

### Supabase security (beyond P0)
- **P1.6 (critical):** `"Staff view … USING(true)"` policies scoped to `authenticated` → **any logged-in user can read every customer's** profile, bank accounts, KYC, holdings. Replace `true` with `user_id = auth.uid()` / admin `EXISTS()`.
- **P1.7 (high):** anon-executable **SECURITY DEFINER money/credit functions** (`transfer_parent_to_child_wallet`, `secure_pledge_liquidity_v1`, `apply_strategy_rebalance_cash_event`) with no `auth.uid()` caller check → `REVOKE EXECUTE … FROM anon, PUBLIC` + add caller guards.
- **P1.8 (high):** INSTITUTIONAL `oems_order_book` RLS disabled with anon SELECT/INSERT → enable RLS + revoke.

### Supabase performance (the ~100% CPU)
Root cause is **not** the lint counts — it's a few unbounded reads on an undersized tier (proven with `EXPLAIN ANALYZE`):
- **P1.9 (critical):** `stock_intraday_c` hot read has **no time-window** → **7.5s**, exhausts the connection pool (a latent outage). Fix: bound the query to a 2-day window + `DISTINCT ON` (56× faster). App change, deploy via preview.
- **P1.10 (high):** `stock_returns_c` has **no index on `security_id`** → 1.6s chart query. `CREATE INDEX CONCURRENTLY idx_stock_returns_sec_date ON stock_returns_c (security_id, as_of_date DESC);` *(safe)*
- **P1.11 (high):** **Compute upgrade required** (≥ Small/Medium) + switch Auth to percentage-based connections before IRESS writes.
- **P1.12 (high):** `stock_intraday_c` has **no retention/partitioning** (3.56M rows, growing) — add batched retention (~14 days) + consider partitioning.
- ✅ `idx_stock_intraday_sec_ts` (added this session) is **required** by the windowed fix — do **not** drop it despite the "unused" flag.

### Vercel / deploy / OEMS
- **P1.13 (high):** MINT `vercel.json` enables **clickjacking** (`frame-ancestors *`, `X-Frame-Options: ALLOWALL`) on the live wallet/KYC app → set `frame-ancestors 'none'` / `X-Frame-Options: DENY`. **Change in MINT-DEVELOPMENT before deploy.**
- **P1.14 (high):** the documented **dev→live force-push** (`reset --hard` + `push --force`) will **destroy 4 live-only commits** on MINT-LIVE. Merge those back into dev first, then sync. This is why the ×100 fix hasn't shipped: MINT-LIVE is stale and syncing is fragile.
- **P1.15 (OEMS — 7 confirmed blockers):** the order stack is **not** ready for real client money:
  - No real production order path — every send routes through the **UAT handler** and trades **UAT account 56378**.
  - Per-client naked-short/cash guard is **dormant** — orders validated against the **desk/omnibus** account, not the client's wallet/holdings.
  - Every order **hard-forced to MKT** with no price/limit.
  - **Client attribution gap** — no per-client reference reaches the broker.
  - `SEND_TO_MARKET` kill-switch **incomplete** (two routes bypass it; blotter submit lacks admin RBAC).
  - Worker `OrderCreate3` **ignores** `IRESS_WORKER_DRY_RUN`/`SUPABASE_ALLOW_WRITES` — the assumed dry-run does not stop live orders. Add an explicit `IRESS_ORDER_EXECUTION_ENABLED` gate.
  - Test account **56378 referenced across prod order/guard paths** (conflation risk).

---

## ⚙️ P2 — Optimization & hardening (post-blocker)
SECURITY DEFINER views (4 retail, 1 institutional) bypass RLS; 22 `function_search_path_mutable`; public bucket listing (`profile-images`, `MintAuthImages`); leaked-password protection off; 59 `auth_rls_initplan` (wrap `auth.uid()` in `(select …)`) — real but second-order; 47 `multiple_permissive_policies` (consolidate `user_onboarding`/`family_members`); 4 duplicate indexes on `family_members`; 46 unused indexes (batched drop after cutover); WN sets no security headers; `eod-save` runs before the day's tick (stale); WN `/api/quotes` defaults `USE_SUPABASE_QUOTES=false` vs data-policy `true` (divergence).

---

## ✅ What's already correct (verified)
- **Database data is clean** — prices, returns, and holdings are correct cents; the ×100 is display/deploy only.
- **Read-path sync confirmed** — WN and MINT read the same retail tables.
- **Yahoo write path is scale-safe** (writes `.JO` cents verbatim, ±20% anomaly guard).
- **Wealth Navigator crons are done right** — `CRON_SECRET`/admin auth, shadow-default writes, read-only validation.
- **Working trees clean**, `.env`/`supabase_creds` gitignored and untracked (the one exception is the key in the doc — P0.2).
- **WN admin studio + MINT current code compute P&L correctly** (÷100).

---

## Answers to your questions
1. **Vercel won't corrupt it again?** The ×100 was stale-deploy, not a cron. But MINT's crons are an *active* security hole (P0.3) and its headers enable clickjacking (P1.13) — both fixable in MINT-DEVELOPMENT. WN's crons are safe.
2. **Both on IRESS prod + in sync?** In sync: yes (read-path). On IRESS: **no — still Yahoo.** Safe cutover needs P1.1–P1.5.
3. **Supabase proper / CPU / security / everything?** No — P0.1/P0.4 (data exposure), P1.6–P1.8 (RLS/functions), and P1.9–P1.12 (CPU: unbounded reads + Micro tier + no retention).
4. **Production ready?** No. Clear the P0s immediately, then P1s, then re-audit.
5. **Changes to MINT-DEVELOPMENT before prod?** **Yes, now there are:** cron auth (P0.3) and CSP headers (P1.13) must be fixed in MINT-DEVELOPMENT, and the dev→live sync must preserve the 4 live-only commits (P1.14) or you'll lose data. The ×100 fix itself is already committed there.

---

## Recommended safe order
1. **P0 now** (rotate key; lock down MINT crons; RLS on financial/KYC tables via preview branch; fix buckets).
2. **Stabilize live** (deploy the stale MINT fix correctly preserving the 4 commits; the `stock_intraday_c` windowed read fix; compute upgrade).
3. **Then** the IRESS price cutover (single-writer + `scale_ref_cents` wiring + full columns) and OEMS order-path build.
4. **Re-run this audit** before flipping any write to production.

*Full raw findings + per-item remediation: workflow output `tasks/w3x276kpx.output` (182 KB, 14 agents).*
