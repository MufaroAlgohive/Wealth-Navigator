# Broker Ingest Worker (Railway)

Persistent process that polls a broker API for execution reports and
writes them as fills to the INSTITUTIONAL Supabase DB. Companion to
`workers/iress-ingest/`; the architecture is intentionally mirrored so
operators familiar with one worker can run the other.

> **Status (2026-07-09): MOCK ONLY.** Real broker integration is blocked
> on Lonwabo confirming the vendor. The worker runs in mock mode by
> default, synthesises one fill per `status='working'` audit row, and
> exposes `POST /debug/inject-fill` for manual injection during
> verification.

## Responsibilities

1. Poll every `BROKER_POLL_INTERVAL_MS` (default 60 s).
2. Fetch fills since the last successful poll.
3. Write fills to `oems_order_audit` (keyed by `order_id` + `symbol`).
4. Mark an audit row `status='filled'` when its quantity is fully covered.
5. When every row of a book is `filled`, flip the matching
   `rebalance_request_c.status='executed'` and stamp `executed_at`.
6. Compute `result_payload.dayOnePnlCents` per fill
   (`qty × (limit - avgFill)`) so the Finance tab can surface the daily
   slip.
7. Heartbeat into `integration_worker_health` keyed by
   `service_name='broker-ingest'`.

## Run from wealth-navigator root

```bash
# Default (mock + dry-run + writes disabled)
bun run workers/broker-ingest/src/index.ts

# Mock mode that actually writes (flips both safety gates)
BROKER_WORKER_DRY_RUN=0 SUPABASE_ALLOW_WRITES=1 \
INSTITUTIONAL_SUPABASE_URL=https://nnwzhxfjpjbzujevwzlh.supabase.co \
INSTITUTIONAL_SUPABASE_SERVICE_ROLE_KEY=... \
bun run workers/broker-ingest/src/index.ts

# Live mode (vendor still pending — call falls back to empty + warns)
BROKER_MODE=live BROKER_API_URL=https://broker.example.com BROKER_API_KEY=... \
bun run workers/broker-ingest/src/index.ts
```

## HTTP API

Defaults to port 8766. All endpoints honour `WORKER_HTTP_TOKEN` when set.

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Heartbeat snapshot + state (mirrors `/api/integration/health`) |
| GET | `/state` | Raw poll state (cursor, fills applied, books completed) |
| POST | `/heartbeat/refresh` | Force-refresh the integration_worker_health row |
| POST | `/debug/inject-fill` | Manual fill injection (mock verification) |

### Manual fill injection

```bash
curl -X POST http://localhost:8766/debug/inject-fill \
  -H "Content-Type: application/json" \
  -d '{
    "order_id": "REBAL-uuid-from-push-payload",
    "symbol": "NPN",
    "qty": 100,
    "avg_fill_price_cents": 245000,
    "fill_timestamp": "2026-07-09T11:30:00Z"
  }'
```

The worker looks up the matching `oems_order_audit` row, stamps the
fill, and (when every row in the book is filled) flips the matching
`rebalance_request_c.status='executed'`.

## Tables touched

| Table | Operation | Source file |
|---|---|---|
| `oems_order_audit` | Update `payload.filled`, `payload.avgPx`, `result_payload.dayOnePnlCents`, `result_payload.slippageBps`, `status` | `fills.ts` |
| `rebalance_request_c` | `status='executed'` + `executed_at` when book is 100% filled | `fills.ts` |
| `integration_worker_health` | Heartbeat upsert keyed on `service_name='broker-ingest'` | `supabase.ts` |

## Migration pre-reqs

The worker is a no-op until the desk trading book schema lands on the
INSTITUTIONAL DB. Apply (via the user's SQL editor per AGENTS.md):

- `20260612000002_oems_order_audit.sql`
- `20260710000004_rebalance_request_c.sql`

## Railway deploy

1. Create a Railway service linked to this repo; set **root directory**
   to `wealth-navigator` (not `workers/broker-ingest`). The Dockerfile
   path `workers/broker-ingest/Dockerfile` is read from `railway.toml`.
2. Set environment variables (see `.env.example`). The defaults already
   target safety (mock + dry-run + writes disabled).
3. Replicas: keep at 1. Mock mode doesn't conflict on the broker side,
   but multiple replicas would race on `integration_worker_health`
   upserts.
4. Deploy. The worker logs `[broker-ingest] http api listening on…` on
   boot. Confirm via `curl <service-url>/health`.
