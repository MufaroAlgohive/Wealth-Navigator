# IRESS Ingest Worker (Railway)

Persistent process that owns **one** IRESS Web Services license seat, polls `PricingQuoteGet` for a watchlist, writes snapshots to Supabase (`stock_intraday_c`, `integration_worker_health`), and mirrors observed orders into `oems_order_audit`.

Reuses `src/lib/iress/*` via relative imports (`../../../src/lib/iress/...`) — no duplicated SOAP logic. Run from `wealth-navigator/` root so Bun resolves `@/` inside the shared IRESS modules.

## Prerequisites

- Bun ≥ 1.1 (same as the Next.js app)
- Dependencies installed at `wealth-navigator/` root (`bun install`)
- For live IRESS: `IRESS_USERNAME`, `IRESS_PASSWORD`, `IRESS_COMPANY_NAME`
- For Supabase writes: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, plus explicit opt-in flags (see below)
- Applied migrations on the LIVE Supabase project:
  - `20260611000000_integration_worker_health.sql` (heartbeat table)
  - `20260612000001_worker_session_metadata.sql` (sticky ApplicationID per replica)
  - `20260612000002_oems_order_audit.sql` (order audit mirror)
  - `20260612000003_intraday_read_policies.sql` (RLS SELECT for UI)
  - `20260612000004_iress_instrument_enrichment.sql` (helper view)

## Default safety posture (production)

The `.env.example` shipped with this worker targets the **production** deployment — `IRESS_MODE=live`, `IRESS_WORKER_DRY_RUN=0`, `SUPABASE_ALLOW_WRITES=1`. The worker logs an explicit `WRITES ENABLED — TARGETING LIVE SUPABASE` warning at boot so a missed flip does not silently write.

For local mocks and staging, set `IRESS_WORKER_DRY_RUN=1` and / or `SUPABASE_ALLOW_WRITES=0`. The worker refuses to start with `IRESS_MODE=live` and any of `IRESS_USERNAME` / `IRESS_PASSWORD` / `IRESS_COMPANY_NAME` missing.

## Local run

From `wealth-navigator/`:

```bash
# Mock IRESS + dry-run (no Supabase writes) — safe default for tests / debugging
IRESS_MODE=mock IRESS_WORKER_DRY_RUN=1 SUPABASE_ALLOW_WRITES=0 bun run worker:iress

# Live IRESS CT (needs creds) — still dry-run on Supabase
IRESS_MODE=live IRESS_WORKER_DRY_RUN=1 SUPABASE_ALLOW_WRITES=0 \
  IRESS_USERNAME=... IRESS_PASSWORD=... IRESS_COMPANY_NAME=Mint \
  IRESS_BASE_URL=https://webservices-ct.iress.co.za/v4 \
  bun run worker:iress

# Live writes to Supabase (LIVE DB — use with care; worker logs WRITES ENABLED warning)
IRESS_MODE=live IRESS_WORKER_DRY_RUN=0 SUPABASE_ALLOW_WRITES=1 \
  IRESS_USERNAME=... IRESS_PASSWORD=... IRESS_COMPANY_NAME=Mint \
  IRESS_BASE_URL=https://webservices-ct.iress.co.za/v4 \
  SUPABASE_URL=https://nnwzhxfjpjbzujevwzlh.supabase.co \
  SUPABASE_SERVICE_ROLE_KEY=... \
  bun run worker:iress
```

Railway `SUPABASE_URL` must match Vercel (same MyMint project).

Copy `.env.example` to `.env` in this folder or export vars in your shell. **Do not commit secrets.** The repo-root `.gitignore` covers `supabase_creds`.

## Sticky ApplicationID (worker_session_metadata)

IRESS recovers the SOAP session for the same `(UserName + CompanyName + ApplicationID)` triple. The worker:

1. On start, looks up its `worker_id` row in `worker_session_metadata` and reuses the persisted `application_id`. If no row exists, it mints a stable one (`Mint-OEMS-Worker-<HOSTNAME or WORKER_ID>`).
2. Persists the new `application_id` + session key + expires_at + hostname + label into `worker_session_metadata` so a Railway restart reuses the same seat.
3. On `SIGTERM` / `SIGINT`, calls `ServiceSessionEnd` (each open service) → `IRESSSessionEnd` → waits `LICENSE_RELEASE_DELAY_MS = 3000`, and stamps the row's `expires_at = now()`. Orphaned seats: `bun run iress:logout` from `wealth-navigator/`.

This is what makes a Railway rolling deploy safe: the new replica inherits the same `ApplicationID` and the IRESS side reconnects to the previous session (modulo its 2 h `SessionTimeout`).

## Health loop (`src/health.ts`)

A dedicated heartbeat loop writes to `integration_worker_health` every `IRESS_WORKER_HEARTBEAT_SEC` seconds (default 30). The payload includes `status` (`healthy` once the first successful quote sync has happened, `degraded` otherwise), `iress_mode`, `last_heartbeat_at`, `last_quote_sync_at`, `symbols_covered`, and a `metadata` jsonb blob. The loop is separate from the quote sync so a transient SOAP error doesn't silence the heartbeat.

## Order audit (`src/orders.ts`)

A read-only `OrderPadGetByAccount` poll runs every `IRESS_WORKER_ORDER_POLL_SEC` seconds (default 60) for each `IRESS_ACCOUNT_CODE` entry (comma-separated). Observed orders are upserted into `oems_order_audit` keyed by `order_id`. The stub is **dry-run safe** — when `IRESS_WORKER_DRY_RUN=1` or `SUPABASE_ALLOW_WRITES=0` it logs the would-be upsert and never touches Supabase. The worker never POSTs orders in v1; the blotter stays on the Vercel BFF.

## Tables touched

| Table | Operation | Source file |
|---|---|---|
| `integration_worker_health` | Upsert heartbeat (worker-specific) | `supabase.ts` + `health.ts` |
| `worker_session_metadata` | Upsert sticky ApplicationID on start; mark expired on shutdown | `session.ts` |
| `securities_c` | Read `id` by `symbol`; `last_price` update on each tick; optional instrument upsert when `IRESS_WORKER_INSTRUMENT_SYNC=1` | `quotes.ts` |
| `stock_intraday_c` | Insert intraday snapshot (`current_price` in **cents**) | `quotes.ts` |
| `oems_order_audit` | Upsert observed order rows from `OrderPadGetByAccount` | `orders.ts` |

## npm script

```bash
bun run worker:iress
```

(from `wealth-navigator/package.json`)

## Railway deploy

**Critical:** In Railway → Settings → set **Root Directory** to `wealth-navigator` (not `workers/iress-ingest`).  
Dockerfile path: `workers/iress-ingest/Dockerfile`.  
If build fails with `"/src": not found` or `"/workers/iress-ingest": not found`, the root directory is wrong.

1. Create a Railway service linked to this repo; set **root directory** to `wealth-navigator`.
2. Railway reads `wealth-navigator/railway.toml` (Dockerfile build).
3. Set environment variables (see `.env.example`). The defaults in `.env.example` already target LIVE; flip `IRESS_WORKER_DRY_RUN=1` / `SUPABASE_ALLOW_WRITES=0` for staging.
4. **Replicas: 1** — the worker holds a single IRESS license. Scaling out would create `25008` collisions. Document the constraint in the service description.
5. Deploy — the worker registers SIGTERM → `IRESSSessionEnd` + 3 s license release delay.

### 25008 orphan recovery

If Railway crashes without `SIGTERM`, the CT license seat can stay occupied. The worker **auto-kicks on first `25008`** when `worker_session_metadata` has no `iress_session_key` (never held a successful session). After a graceful run, restarts reuse the sticky `application_id` without kicking.

Manual recovery from your laptop:

```bash
# Kick orphan seat (no Supabase metadata required)
IRESS_FORCE_KICK_ALL=1 bun run iress:logout

# Verify seat is free
bun scripts/probe-iress-login.ts
```

### Stale `stock_intraday_c` cleanup (bad LastTrade rows)

If the UI shows absurd prices (e.g. AGL 120,003) after a `mapQuote` fix, the
worker may already be healthy but old bad rows remain in Supabase. The quote loop
runs immediately on boot (no warm-up delay) and inserts fresh ticks each poll —
deleting bad rows lets the next sync repopulate.

Run in the **MyMint** Supabase SQL editor (idempotent):

```sql
-- Remove intraday ticks for the worker watchlist so the next poll repopulates.
DELETE FROM stock_intraday_c i
USING securities_c s
WHERE i.security_id = s.id
  AND s.symbol IN ('NPN','BHG','AGL','PRX','FSR','SBK','MTN','SHP','SOL','CPI');
```

Redeploy the Railway worker after pulling the `mapQuote` / `resolveQuoteLast`
fix so new rows use `<Close>` when `<Last>` is absent post-close.

Railway one-time recovery (optional — worker first-boot auto-kick usually suffices):

1. Set `IRESS_FORCE_KICK_ALL=1` on the Railway service.
2. Redeploy once; confirm `[iress-ingest] quote sync complete` in logs.
3. **Remove** `IRESS_FORCE_KICK_ALL` and redeploy again so normal restarts do not kick other sessions.
