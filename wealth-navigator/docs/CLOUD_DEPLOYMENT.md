# Cloud Deployment — Mint Wealth Navigator

Topology for **Vercel** (Next.js BFF + UI), **Supabase** (live Postgres + Auth), and **Railway** (IRESS long-running worker).

## Architecture

```
Browser → Vercel (Next.js 16)
            ├─ /api/* BFF routes (short-lived, mock auth today)
            ├─ /api/quotes (BFF) — DB-first when USE_SUPABASE_QUOTES=true, else live-queries
            └─ reads quotes from seed/mock OR Supabase (feature-flagged via USE_SUPABASE_QUOTES)

Railway worker (iress-ingest)
            ├─ owns ONE IRESS SOAP session (license seat)
            ├─ sticky ApplicationID → worker_session_metadata
            ├─ PricingQuoteGet → stock_intraday_c
            ├─ OrderPadGetByAccount (read-only) → oems_order_audit
            └─ heartbeat → integration_worker_health

Supabase (LIVE — mfxnghmuccevsxwcetej)
            ├─ Consumer app tables (profiles, wallets, securities_c, …)
            ├─ Worker tables (integration_worker_health, worker_session_metadata, oems_order_audit)
            ├─ View (securities_with_latest_quote) for DB-first reads
            └─ RLS per user; service_role for workers only; SELECT-only for anon/authenticated on stock_intraday_c / securities_c
```

## Environment checklist

### Vercel (Next.js app)

| Variable | Required | Notes |
|---|---|---|
| `IRESS_MODE` | Yes | `mock` for demo; `live` only with CT creds |
| `IRESS_USERNAME` / `IRESS_PASSWORD` / `IRESS_COMPANY_NAME` | Live only | SOAP session — **never** `NEXT_PUBLIC_*` |
| `IRESS_BASE_URL` | Live | Default CT: `https://webservices-ct.iress.co.za/v4` |
| `NEXT_PUBLIC_SUPABASE_URL` | When auth wired | Anon-safe |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | When auth wired | Anon-safe |
| `SUPABASE_SERVICE_ROLE_KEY` | Server only | API routes / future jobs — Vercel encrypted |
| `USE_SUPABASE_QUOTES` | No | Default `false` — keep OEMS on seed/live-queries until ready. When `true`, `live-queries.ts` + `GET /api/quotes` read from `stock_intraday_c` (worker is the source of truth). |

### Railway (IRESS worker)

| Variable | Required | Notes |
|---|---|---|
| `IRESS_MODE` | Yes | `live` in production |
| `IRESS_*` creds | Live | Same as Vercel server vars |
| `SUPABASE_URL` | Yes | Same project as consumer app |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | Worker writes bypass RLS |
| `IRESS_WORKER_DRY_RUN` | Yes | `0` in production |
| `SUPABASE_ALLOW_WRITES` | Yes | `1` in production — explicit opt-in |
| `WORKER_ID` | No | Default `iress-ingest-1` |
| `IRESS_WATCHLIST_SYMBOLS` | No | Comma-separated JSE tickers |

### Local

Copy `wealth-navigator/.env.example` → `.env.local` (gitignored).  
Worker vars: `workers/iress-ingest/.env.example`.

**Never commit** `supabase_creds` at repo root — it is in `.gitignore`.

## LIVE database warnings

- Project ref: `mfxnghmuccevsxwcetej` (`https://mfxnghmuccevsxwcetej.supabase.co`)
- **Do not** run `DROP`, `TRUNCATE`, or destructive migrations without review
- Migrations live in `supabase/migrations/` — apply manually via Supabase SQL editor or CLI after review
- Worker writes only when `SUPABASE_ALLOW_WRITES=1` **and** `IRESS_WORKER_DRY_RUN=0`
- Local tests default to dry-run

## Pre-flight — verify live schema (read-only)

Run in **Supabase → SQL Editor** before enabling `SUPABASE_ALLOW_WRITES=1`. These are `SELECT` only.

```sql
-- 1) Confirm ingest targets exist
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name IN ('securities_c', 'stock_intraday_c')
ORDER BY table_name, ordinal_position;

-- 2) Confirm watchlist symbols resolve to UUIDs (adjust symbols as needed)
SELECT id, symbol FROM public.securities_c
WHERE symbol IN ('NPN','PRX','FSR','SBK','AGL','BHG','MTN','SOL','SHP','CPI');

-- 3) After applying integration_worker_health migration
SELECT * FROM public.integration_worker_health LIMIT 5;
```

If step 2 returns fewer rows than your watchlist, fix `IRESS_WATCHLIST_SYMBOLS` or add missing `securities_c` rows **before** the worker writes.

## Testing order

1. `cd wealth-navigator && bun run test` — unit tests must pass
2. Worker dry-run: `IRESS_MODE=mock IRESS_WORKER_DRY_RUN=1 bun run worker:iress`
3. Worker mock + log: confirm `would upsert stock_intraday_c` lines
4. Apply `integration_worker_health` migration (review first)
5. Staging write test: `SUPABASE_ALLOW_WRITES=1` with one symbol against CT IRESS
6. Deploy Railway worker → verify `integration_worker_health` row
7. Deploy Vercel → smoke `/oems` with `IRESS_MODE=mock` (unchanged UX)
8. Later: `USE_SUPABASE_QUOTES=true` when read path is implemented

## Railway setup

1. New service, root directory `wealth-navigator`
2. Uses `workers/iress-ingest/Dockerfile`
3. Set env vars from table above
4. Single replica — **one worker = one IRESS license**

## Related docs

- `docs/STACK_ARCHITECTURE.md` — platform decisions
- `TABLES.md` (repo root) — live schema reference
- `workers/iress-ingest/README.md` — worker runbook
