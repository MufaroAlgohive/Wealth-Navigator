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

## UAT mode (`src/order-poller.ts`, `/uat/*` HTTP routes)

UAT mode (Mint OEM Finalisation Phase UAT) lets the desk exercise the full order pipeline — `OrderCreate3` → `OrderPadGetByAccount` → fill writes → SSE — against the MINT_CT IOS seat **without** touching real client books. Andre Pietersen (IRESS) confirmed `OrderCreate3` works on the seat on 2026-07-09; the UAT loop is the path UAT users use to give feedback on the entire execution loop.

### Enable

Set on Railway:

```
IRESS_UAT_MODE=1
IRESS_UAT_ACCOUNT_CODE=<separate broker account — must differ from IRESS_ACCOUNT_CODE>
IRESS_UAT_ORDER_POLL_SEC=30     # default 30s
```

The startup log will print:

```
{"event":"starting","uatMode":true,"uatAccountCode":"...","uatOrderPollSec":30}
[iress-ingest] UAT order poll ENABLED → account=... interval=30s
```

Refuse-conditions surfaced at boot (and on every request):

- `IRESS_UAT_MODE=1` but `IRESS_UAT_ACCOUNT_CODE` empty → `/uat/send-to-market` returns 503 `uat_account_not_configured` and the order poll loop logs a warning.
- `account_code` passed in the body matches `IRESS_ACCOUNT_CODE` (production) → 400 `wrong_account` so a misconfiguration cannot route UAT orders to a real client book.

### Endpoints (added to the existing `node:http` server)

| Method | Path                       | Purpose                                                                  | Auth                          |
| ------ | -------------------------- | ------------------------------------------------------------------------ | ----------------------------- |
| POST   | `/uat/send-to-market`      | Reads an `oems_order_audit` row, calls IRESS `OrderCreate3` on the UAT account, stamps the broker `OrderNumber` back onto the row. | `WORKER_HTTP_TOKEN` if set    |
| GET    | `/uat/execution-stream`    | SSE stream — pushes `{order_audit_id, state, filled, avg_fill_price_cents, …}` deltas to subscribed UIs. | `WORKER_HTTP_TOKEN` if set    |
| GET    | `/uat/status`              | UAT mode status snapshot (used by the BFF `/api/admin/orderbook/uat-status`). | `WORKER_HTTP_TOKEN` if set    |

### BFF fanout (Vercel)

The Vercel BFF reverse-proxies these via:

- `POST /api/admin/orderbook/send-to-market` — when `body.uat_test === true` AND `IRESS_UAT_MODE === "true"` on Vercel, fans out to the worker's `/uat/send-to-market` AFTER writing the audit rows. Existing audit-only path is preserved bit-for-bit.
- `GET /api/admin/orderbook/uat-status` — proxies worker `/uat/status` for the UI banner.
- `GET /api/admin/orderbook/stream` — SSE forwarder to `/uat/execution-stream` for the live fill indicators on `ExecutionView`.

### Safety

- UAT orders are stamped `payload.uat_test = true` and `result_payload.uat_test = true` in `oems_order_audit`, with `source = OB_SEND_TO_MARKET_UAT`. Filter them out of production reports with `SELECT * FROM oems_order_audit WHERE payload->>'uat_test' = 'true'`.
- The `UatExecutionHub` (in-process pub/sub) only fires on a state OR filled change, so the SSE stream doesn't spam subscribers with no-op updates.
- The UAT order poll never writes to `oems_position_c` (the production `pollAccountsForOrders` derives positions from the full book; the UAT loop is fill-only).
- `worker.tearDown` honours the same `LICENSE_RELEASE_DELAY_MS` for the UAT session — there's no separate seat.
- `IRESS_UAT_MODE=0` (default) keeps the worker in production mode: the new endpoints return 403 `uat_mode_disabled`, the UAT poll loop is a no-op, and the existing `orders.ts` order poll continues to mirror the production `IRESS_ACCOUNT_CODE`.

### End-to-end UAT flow

1. Operator clicks **Send to Market** in `/oems/order-book` with `UAT test` checked → BFF writes `oems_order_audit` rows tagged `uat_test=true`.
2. BFF fans out to worker `POST /uat/send-to-market` per row.
3. Worker calls IRESS `OrderCreate3` on the UAT IOS service session, stamps `payload.iress_order_number` + `payload.uatOrderTag` (UUID idempotency) back on the row.
4. Worker's UAT poll loop (`order-poller.ts`, every `IRESS_UAT_ORDER_POLL_SEC`) calls `OrderPadGetByAccount(IRESS_UAT_ACCOUNT_CODE, OrderFilter=WORKING)`, matches observed orders to audit rows by `order_id`, and updates `payload.filled` + `result_payload.avgFillPrice` + `status` (working → partial → filled).
5. Each poll cycle that finds a state or fill change publishes to the in-process `UatExecutionHub`; the `/uat/execution-stream` SSE endpoint forwards to the BFF `/api/admin/orderbook/stream`; the UI updates `ExecutionView` in place with a pulsing "LIVE" badge.
6. BFF `GET /api/admin/orderbook/execution?book_id=...` (the existing 30s poll) keeps the table hydrated even when SSE is offline.

### Disabling for production

Set `IRESS_UAT_MODE=0` on Railway and redeploy. The endpoints go 403, the loop is a no-op, the UI banner + test runner are self-gated off (`UatBanner` returns `null` when `/api/admin/orderbook/uat-status` reports `uat_mode: false`; same for `UatTestRunner`).

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
