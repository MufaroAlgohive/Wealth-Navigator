# Wealth Navigator — Deployment, Cutover Runbook, Env Vars, CI/CD

**Audience:** devs, on-call, ops, new joiners, CEO.
**Last reviewed:** 2026-08-15.
**Source of truth:** `wealth-navigator/docs/GO_LIVE_RUNBOOK.md` (authoritative), `wealth-navigator/docs/VERCEL_DEPLOY_SETUP.md`, `wealth-navigator/docs/CLOUD_DEPLOYMENT.md`, `wealth-navigator/docs/ENV_MIGRATION.md`, `wealth-navigator/docs/PHASE1_IRESS_RETAIL_CUTOVER.md`, `wealth-navigator/docs/ISSUES_LOG.md`, `wealth-navigator/vercel.json`, `wealth-navigator/.vercel/project.json`, `wealth-navigator/package.json`, `wealth-navigator/workers/iress-ingest/Dockerfile`.

> **Correction vs older handoffs:** The HTML runbook (`docs/MINT_GO_LIVE_RUNBOOK.html`) is **stale** — `docs/GO_LIVE_RUNBOOK.md` is the authoritative phased plan. **No GitHub Actions workflows exist** in this repo. The worker `WORKER_HTTP_TOKEN` literal is checked into `ISSUES_LOG.md` and needs rotation.

---

## 1. Branch strategy (root `AGENTS.md:1-8`)

- All code changes go on `MINT-DEVELOPMENT` only.
- Never edit `MINT-LIVE` directly (the dev team syncs DEV → LIVE; live edits get reverted or conflict).
- This repo follows `feature/<ticket>-slug → main → Vercel auto-deploy`.
- Cross-cutting changes that need to land in MINT-LIVE go through the MINT org-level DEV → LIVE syncer.

---

## 2. Build & dev

### Scripts (`wealth-navigator/package.json`)
- `dev` — `next dev`
- `build` — `next build`
- `start` — `next start`
- `lint` + `format` (Prettier)
- `test` + `test:watch` + `test:e2e`
- `typecheck` — `tsc --noEmit`
- `worker:iress` — `bun workers/iress-ingest/src/main.ts`
- `worker:iress:prod` — `bun workers/iress-ingest/src/main-prod.ts`
- `iress:logout` — `scripts/iress-logout.ts`
- `iress:probe-frequency`

### Engines
- `bun >= 1.1.0`
- `node >= 20.0.0`

### Worker Dockerfile
- Image: `oven/bun:1.1`.
- Copy `src/` + `.env.example`.
- Run via `bun src/main-prod.ts` (prod) or `bun src/main.ts` (UAT).

---

## 3. CI/CD

### Current state
- **No GitHub Actions workflows exist** in this repo or the parent monorepo. Verified via `git ls-files '.github/**'` — empty.
- No pre-commit hooks (`husky`, `lint-staged` absent).
- CI today = manual `bun run lint/typecheck/test/build` before pushing.
- Vercel auto-deploys on push to `main`. Previews are produced for every branch.
- Railway GitHub app integration was **missing** for the worker service (`ISSUES_LOG.md:0.5.4.b`) — broke worker redeploys on push; installed manually via `https://railway.com/account/integrations`.

### Recommended additions
- Add GitHub Actions workflow for `bun run lint/typecheck/test/build` on every PR.
- Add Railway GitHub app integration (already done for worker).
- Add pre-commit hook for `bun run format` + `bun run lint`.

---

## 4. Vercel deployment

### Project
- Project: `autonama-group/wealth-navigator` (per `wealth-navigator/.vercel/project.json`).
- Production URL: `https://wealth-navigator-one.vercel.app`.
- Root Directory: `wealth-navigator`.
- Build command: `next build` (auto-detected).
- Output: Next.js.

### Vercel cron (`wealth-navigator/vercel.json`)
```json
{
  "framework": "nextjs",
  "crons": [
    { "path": "/api/cron/yahoo-fundamentals",    "schedule": "*/5 * * * 1-5" },
    { "path": "/api/cron/iress-validation",     "schedule": "0 13 * * 1-5" },
    { "path": "/api/cron/position-reconciliation", "schedule": "30 15 * * 1-5" }
  ]
}
```

### Vercel env vars
See `wealth-navigator/docs/VERCEL_DEPLOY_SETUP.md:1-318` for the full table. Categories:
- IRESS-side (server-only): `IRESS_MODE`, `IRESS_BASE_URL`, `IRESS_ACCOUNT_CODE`, etc.
- Worker passthrough: `IRESS_WORKER_URL`, `WORKER_HTTP_TOKEN`.
- Supabase 3-DB split: `RETAIL_SUPABASE_URL`, `RETAIL_SUPABASE_SERVICE_ROLE_KEY`, `INSTITUTIONAL_SUPABASE_URL`, `INSTITUTIONAL_SUPABASE_SERVICE_ROLE_KEY`, `STAGING_SUPABASE_*`.
- Supabase Auth (browser-exposed): `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`.
- App env (browser-exposed): `NEXT_PUBLIC_APP_NAME`, `NEXT_PUBLIC_APP_REGION`, `NEXT_PUBLIC_TICK_STREAM`, `NEXT_PUBLIC_TICK_INTERVAL_MS`, `NEXT_PUBLIC_USE_SUPABASE_QUOTES`.
- Server-side: `USE_SUPABASE_QUOTES`, `CRON_SECRET`, `BROKER_WORKER_URL`, `RESEND_API_KEY`, `YAHOO_FUNDAMENTALS_WRITE`.

### Production posture
- `IRESS_MODE=mock` (Vercel never opens a live IRESS session).
- `USE_SUPABASE_QUOTES=true` (Path A — DB-first reads).
- `IRESS_BASE_URL=https://webservices.iress.co.za/v4` (post-cutover, 2026-07-23).
- `IRESS_IOS_SERVER=MINT`.
- `IRESS_NEWS_VENDOR=SENSD`.

---

## 5. Railway worker deployment

### Project
- Service: `Iress-Worker-PROD` on Railway.
- Single replica (multi-replica = 25008 collision).
- Public domain: `https://iress-worker-production.up.railway.app`.
- Health check: `/health`.

### Dockerfile
- `workers/iress-ingest/Dockerfile`.
- Image: `oven/bun:1.1`.
- Run command: `bun src/main-prod.ts`.

### Railway env vars
See `workers/iress-ingest/.env.example`. Categories:
- IRESS-side: `IRESS_MODE=live`, `IRESS_BASE_URL=https://webservices.iress.co.za/v4`, `IRESS_USERNAME`, `IRESS_PASSWORD`, `IRESS_COMPANY_NAME`, `IRESS_IOS_SERVER=MINT`, `IRESS_NEWS_VENDOR=SENSD`, `IRESS_ACCOUNT_CODE=43448`.
- Safety gates: `IRESS_WORKER_DRY_RUN`, `SUPABASE_ALLOW_WRITES`, `IRESS_PRODUCTION_ORDERS`, `IRESS_PER_CLIENT_GUARD`, `RETAIL_SETTLEMENT_ENABLED`, `IRESS_NEWS_ALLOW_WRITES`, `IRESS_RETAIL_INGEST`.
- Worker HTTP API: `WORKER_HTTP_PORT=8765`, `WORKER_HTTP_TOKEN`.
- Supabase: `INSTITUTIONAL_SUPABASE_URL`, `INSTITUTIONAL_SUPABASE_SERVICE_ROLE_KEY`, `RETAIL_SUPABASE_URL`, `RETAIL_SUPABASE_SERVICE_ROLE_KEY`.
- Loop intervals: `IRESS_WORKER_HEARTBEAT_SEC=30`, `IRESS_WORKER_QUOTE_INTERVAL_SEC=15`, `IRESS_WORKER_ORDER_POLL_SEC=60`, `IRESS_WORKER_TIMESERIES_INTERVAL_SEC=300`, `IRESS_WORKER_INDEX_INTRADAY_INTERVAL_SEC=120`, `IRESS_NEWS_INGEST_INTERVAL_SEC=21600`.

### Deploy process
- Railway auto-deploys on push to `main` (via GitHub app integration).
- Health check: `/health` returns 200 within 30s.
- Worker boot: `IRESS_SVC_START_TIMEOUT_MS=30_000`.
- Single replica: `REPLICAS=1`.

---

## 6. Cutover runbook (`docs/GO_LIVE_RUNBOOK.md`)

The authoritative phased plan. The HTML version (`MINT_GO_LIVE_RUNBOOK.html`) is **stale** — ignore it.

### Phase 0 — Local safety
1. Verify env vars on `.env.example` match current contract.
2. `bun install` + `bun run lint/typecheck/test/build` clean.
3. `bun run dev` boots Next.js without errors.
4. `bun run worker:iress` boots worker (UAT) without errors.

### Phase 1 — Supabase LIVE read-only checks
1. Verify RETAIL DB (`mfxng…`) read-only via service-role.
2. Verify INSTITUTIONAL DB (`nnwz…`) read-only via service-role.
3. Verify STAGING DB (when created) — full migration applied.

### Phase 2 — Schema migrations
1. Apply pending migrations to INSTITUTIONAL via `supabase db push` or `apply_migration` MCP.
2. Apply pending migrations to RETAIL via `supabase db push` or `apply_migration` MCP.
3. Apply pending migrations to STAGING (mirror of both).
4. Verify all migrations idempotent (no `DROP` / `TRUNCATE` in shipped migrations).

### Phase 3 — Railway IRESS worker setup
1. `workers/iress-ingest/Dockerfile` builds.
2. Railway service `Iress-Worker-PROD` deployed.
3. Health check: `GET https://iress-worker-production.up.railway.app/health` returns 200.
4. Worker boot logs show:
   - `CONFIG: IRESS_MODE=live`
   - `CONFIG: IRESS_BASE_URL=https://webservices.iress.co.za/v4`
   - `CONFIG: IRESS_ACCOUNT_CODE=43448`
   - `CONFIG: WORKER_ID=iress-ingest-prod-1`

### Phase 4 — Vercel UI configuration
1. Verify Vercel env vars set per `VERCEL_DEPLOY_SETUP.md`.
2. `IRESS_MODE=mock` (Vercel posture).
3. `USE_SUPABASE_QUOTES=true`.
4. `IRESS_WORKER_URL=https://iress-worker-production.up.railway.app`.
5. `WORKER_HTTP_TOKEN` set on both Vercel and Railway (same value).

### Phase 5 — Hardening
1. Enable RLS on 28 retail tables (P0.1).
2. Rotate `service_role` JWT and purge from `docs/TWO_DATABASE_STRATEGY.md` (P0.2).
3. Add `CRON_SECRET` to all `/api/cron/*` routes (P0.3).
4. Rotate `WORKER_HTTP_TOKEN` and purge from `ISSUES_LOG.md` (P1.4.b).
5. Add explicit `IRESS_ORDER_EXECUTION_ENABLED` flag (P1.15.5).
6. Force `IRESS_PRODUCTION_ORDERS=1` + `IRESS_PER_CLIENT_GUARD=1` for production (P1.15).
7. Push 9 unpushed commits (P1.4.c).
8. Remove stale HTML runbook (P1.4.d).

### Phase 6 — Production cutover (2026-07-23)
1. Set `IRESS_BASE_URL=https://webservices.iress.co.za/v4` on Vercel.
2. Set `IRESS_IOS_SERVER=MINT` on Vercel.
3. Set `IRESS_NEWS_VENDOR=SENSD` on Vercel.
4. Set `IRESS_ACCOUNT_CODE=43448` on Vercel.
5. Verify Vercel `/oems/integration` shows green health.

---

## 7. Recovery procedures

### 25008 (license seat contention)
1. `bun run iress:logout` (local script — calls `IRESSSessionEnd`).
2. Set `IRESS_SESSION_NUMBER_TO_KICK=<n>` on Railway + redeploy.
3. Set `IRESS_FORCE_KICK_ALL=1` on Railway + redeploy + unset after recovery.
4. Set `IRESS_FORCE_ORPHAN_CLEAR=1` on Railway + redeploy + unset after recovery.

### Worker crash
1. Check Railway logs for stack trace.
2. Verify `worker_session_metadata` row exists for the worker_id.
3. If session is stale, `IRESS_FORCE_KICK_ALL=1` + redeploy.
4. Worker restart: Railway auto-restarts.

### Vercel deploy failure
1. Check Vercel build logs.
2. Verify env vars set.
3. Roll back to previous deploy via Vercel dashboard.

### DB migration failure
1. Identify failing migration via `supabase db push --dry-run`.
2. Fix migration (idempotent pattern).
3. Re-apply.

---

## 8. Monitoring & alerting

### Health checks
- Vercel: `/api/integration/health`.
- Railway: `GET /health` on port 8765.
- Cron: `/api/cron/yahoo-fundamentals`, `/api/cron/iress-validation`, `/api/cron/position-reconciliation`.

### Alerts (TODO)
- Worker heartbeat missing > 5 min → operator alert.
- Quote sync staleness > 5 min → operator alert.
- Order lifecycle stuck in `pending_ack` > 5 min → operator alert.
- Vercel deploy failure → engineer alert.
- DB migration failure → engineer alert.

### Dashboards
- `/oems/integration` — endpoint health + IRESS v4 → OEMS surface map.
- `/oems/iress-migration` — Yahoo → IRESS(PROD) cutover console.
- `/admin/finance` — AUM fees + Day-1 P&L.
- `/admin/cyber-compliance` — audit + API health.

---

## 9. Disaster recovery

### Vercel down
- Vercel status: https://vercel-status.com.
- If extended downtime, operator manually switches DNS to a backup Cloudflare Pages deploy.

### Railway down
- Railway status: https://railway.app/status.
- If extended downtime, operator must hold off on order submission (no live IRESS seat).

### Supabase down
- Supabase status: https://status.supabase.com.
- If extended downtime, all read paths fail; UI renders `unavailable` data-source badges.

### IRESS down
- IRESS status: (private).
- If extended downtime, worker logs faults; UI falls back to Supabase snapshot (Path A); alerts surface stale data.

---

## 10. Env migration (`docs/ENV_MIGRATION.md`)

### Old env vars (deprecated)
- `SUPABASE_URL` → `RETAIL_SUPABASE_URL` + `INSTITUTIONAL_SUPABASE_URL`.
- `SUPABASE_SERVICE_ROLE_KEY` → `RETAIL_SUPABASE_SERVICE_ROLE_KEY` + `INSTITUTIONAL_SUPABASE_SERVICE_ROLE_KEY`.
- `NEXT_PUBLIC_SUPABASE_URL` → kept (browser).
- `NEXT_PUBLIC_SUPABASE_ANON_KEY` → kept (browser).

### New env vars (3-DB topology)
- `RETAIL_SUPABASE_URL` / `RETAIL_SUPABASE_SERVICE_ROLE_KEY` → `mfxng…`
- `INSTITUTIONAL_SUPABASE_URL` / `INSTITUTIONAL_SUPABASE_SERVICE_ROLE_KEY` → `nnwz…`
- `STAGING_SUPABASE_URL` / `STAGING_SUPABASE_SERVICE_ROLE_KEY` → staging project.

### Migration steps
1. Set new env vars on Vercel.
2. Verify `createRetailServiceRoleClient()` resolves correctly.
3. Verify `createInstitutionalServiceRoleClient()` resolves correctly.
4. Verify `createAuthAdminClient()` matches the right project ref.
5. Remove old env vars (after 7-day observation).

---

## 11. Cloud deployment (`docs/CLOUD_DEPLOYMENT.md`)

### Architecture
- Vercel: `wealth-navigator-one.vercel.app` (BFF + UI).
- Railway: `Iress-Worker-PROD` (worker).
- Supabase: 3-DB topology.

### Cost (post-cutover)
- Vercel: free tier until 100 GB-hr / month.
- Railway: ~$5/month per service (single replica).
- Supabase: free tier until 500 MB DB + 1 GB bandwidth.

### Scaling
- Vercel: auto-scales.
- Railway: single replica (multi-replica unsafe today).
- Supabase: free tier; upgrade when DB > 500 MB.

---

## 12. Production readiness (`docs/PRODUCTION_READINESS.md`)

### Pre-prod checklist
- [ ] `IRESS_PRODUCTION_ORDERS=1`
- [ ] `IRESS_PER_CLIENT_GUARD=1`
- [ ] `IRESS_ACCOUNT_CODE=43448`
- [ ] `IRESS_BASE_URL=https://webservices.iress.co.za/v4`
- [ ] `IRESS_WORKER_DRY_RUN=false`
- [ ] `SUPABASE_ALLOW_WRITES=1`
- [ ] `RETAIL_SETTLEMENT_ENABLED=1` (only when ready)
- [ ] `IRESS_NEWS_ALLOW_WRITES=1` (only when ready)
- [ ] `IRESS_RETAIL_INGEST=1` (only when ready)
- [ ] `IRESS_ORDER_EXECUTION_ENABLED=1` (once added)
- [ ] All 5 readiness gate blockers cleared

### Post-prod monitoring
- Worker heartbeat every 30s.
- Quote sync every 15s.
- Order poll every 60s.
- Vercel health check every 5 min.
- Cron jobs per `vercel.json`.

---

## 13. Open gaps

### CI/CD
- **No GitHub Actions** — manual `bun run lint/typecheck/test/build` today.
- **No pre-commit hooks**.
- **Railway GitHub app integration was missing** — now installed.

### Env migration
- Old `SUPABASE_*` env vars still present (compat fallback).
- 7-day observation period before removal.

### Disaster recovery
- No automated failover for Vercel / Railway / Supabase.
- Manual DNS switch only.

### Monitoring
- No automated alerts for worker heartbeat missing.
- No automated alerts for stale data.
- No automated alerts for order lifecycle stuck.

### Pre-prod hardening (P0/P1)
- P0.1 — RLS on 28 retail tables.
- P0.2 — Rotate `service_role` JWT.
- P0.3 — `CRON_SECRET` on cron routes.
- P1.4 — Move Qentari pusher under ops.
- P1.4.b — Rotate `WORKER_HTTP_TOKEN`.
- P1.4.c — Push 9 unpushed commits.
- P1.4.d — Remove HTML runbook.
- P1.15 — Add `IRESS_ORDER_EXECUTION_ENABLED`.

---

*This doc is the deployment + cutover reference. Pair with Doc 4 (IRESS adapter), Doc 5 (Railway worker), and Doc 10 (risk/compliance) for the full posture.*
