# Provider Switch Runbook

> **Phase:** Mint OEM Finalisation Phase C1 (provider cutover).
> **Owners:** Backend / OEMS desk / IRESS integrations.
> **Source of truth:** `wealth-navigator/src/lib/data-policy.ts` and `wealth-navigator/src/lib/data/providers/`.

This runbook is the single place an operator needs to look when flipping the active
market-data provider between **IRESS**, **Yahoo**, **Mock**, and **IRIS** (stub). It
covers the env flags that drive the selector, the health-check endpoints used to
verify the cutover, the parity acceptance test, and the rollback path.

---

## 1 · Selector overview

`wealth-navigator/src/lib/data-policy.ts::getActiveProviderName()` resolves the
provider in this order:

1. Test override (`setActiveProviderForTesting(...)` — only callable from server-side tests).
2. `ACTIVE_MARKET_DATA_PROVIDER` env (`iress` | `yahoo` | `mock` | `iris`).
3. `yahoo` when `IRESS_MODE=mock` and `USE_SUPABASE_QUOTES=true` (Vercel production).
4. `mock` in all other dev / local cases.

The active provider is read by every BFF that talks to a market-data upstream —
`/api/quotes`, `/api/intraday/[sym]`, `/api/history/[sym]`, `/api/equities` — plus
internal callers via `getActiveProvider()` from `@/lib/data/providers`.

The DB-first quote path (`USE_SUPABASE_QUOTES=true`) **always** reads
`stock_intraday_c` from RETAIL Supabase regardless of the active provider, because
the worker is the source of truth in production. The provider name is then surfaced
to the UI as metadata for honest badges.

A new query-string override (`?provider=iress|yahoo|mock|iris`) was added to
`/api/quotes` as part of Phase C1 so the parity scan can hit each provider
explicitly. Unknown values return HTTP 400.

---

## 2 · Env flags

| Var | Where | Purpose | Default |
|---|---|---|---|
| `ACTIVE_MARKET_DATA_PROVIDER` | Vercel + Railway + local | Names the provider the BFFs call when DB-first is off. | `yahoo` on Vercel, `mock` otherwise |
| `USE_SUPABASE_QUOTES` | Vercel + Railway | When `true`, `/api/quotes` reads the worker-ingested `stock_intraday_c` instead of hitting an upstream. | `false` |
| `NEXT_PUBLIC_USE_SUPABASE_QUOTES` | Vercel + local | Browser mirror of the flag; gates the Cockpit polling + `DataSourceBadge` flip. | `false` |
| `IRESS_MODE` | All | `mock` / `live` / `wsdl-stub`. Only the Railway worker should ever run `live`. | `mock` |
| `IRESS_WORKER_URL` | Vercel + local | URL of the Railway `iress-ingest` worker (Path B passthroughs). Empty falls through to 503. | empty |
| `RAILWAY_SERVICE_URL` | Vercel | Fallback for `IRESS_WORKER_URL` when Railway auto-injects it. | empty |
| `IRESS_USERNAME` / `IRESS_PASSWORD` / `IRESS_COMPANY_NAME` | Railway worker only | SOAP session creds (`DFM@Mint`). Never set on Vercel. | empty |
| `IRESS_PRICE_OVERLAY` | All | When `false`, the equities board refuses to overlay IRESS `quote_snapshot_c` values on top of Yahoo reference. | unset (`true`) |
| `IRESS_WORKER_DRY_RUN` | Railway worker | When `1`, the worker logs would-be writes but does not upsert Supabase. | unset (`0`) |
| `SUPABASE_ALLOW_WRITES` | Railway worker | Master switch for any worker → Supabase write (`stock_intraday_c`, `worker_session_metadata`). | unset (`0`) |

See `wealth-navigator/.env.example` for the full annotated template.

---

## 3 · Pre-cutover: parity acceptance test

Before flipping `ACTIVE_MARKET_DATA_PROVIDER` in any environment, run the
20-symbol parity scan and confirm the diffs are within tolerance. This is the
acceptance criterion from the Phase C plan.

```bash
# From the repo root, against a running dev / preview server.
cd wealth-navigator

# Optional overrides:
#   PARITY_BASE_URL — defaults to http://localhost:3000
#   PARITY_TOLERANCE_PCT — defaults to 0.5
#   PARITY_SYMBOLS — comma-separated; default is the 20-symbol universe in the script
bun scripts/scan-provider-parity.ts
```

The script calls `/api/quotes?provider=iress` and `/api/quotes?provider=yahoo`
for the same symbol list, compares `last_price` and `prev_close` per symbol, and
exits non-zero when any pair diverges by more than the tolerance OR when either
leg is unreachable. Output is also written to
`wealth-navigator/docs/PROVIDER_PARITY_<YYYY-MM-DD>.json`.

Latest run (2026-07-09, dev server, no IRESS session active):

> **Note.** This run was executed against the local dev stack with
> `IRESS_MODE=mock` and `ACTIVE_MARKET_DATA_PROVIDER=yahoo`. The IRESS leg
> resolved through the mock adapter and Yahoo through the real HTTP client; the
> comparison therefore measures mock-vs-Yahoo, not live-vs-Yahoo. Re-run against
> a deployment with `IRESS_MODE=live` on the Railway worker and
> `ACTIVE_MARKET_DATA_PROVIDER=iress` on Vercel before any production cutover.
>
> See `wealth-navigator/docs/PROVIDER_PARITY_2026-07-09.json` for the raw
> stdout + structured rows from the dev run.

The 20-symbol universe (all bare JSE codes, Yahoo suffixes appended by the
provider itself):

`NPN, AGL, FSR, MTN, SBK, BHG, SOL, ANG, PRX, CFR, BIL, SHP, VOD, AMS, GFI,
REM, SLM, NED, INP, EXX`

Coverage is intentionally broad:

- **NPN, SOL, PRX, AMS, GFI** — bare `<Last>` row shape (no `LastPrice` field).
- **AGL, FSR, MTN, SBK, BIL, SHP, VOD, REM, SLM, NED, INP** — `LastPrice` /
  `PreviousClosePrice` integer cents.
- **BHG** — the hollow-row pattern the worker explicitly skips on stale
  `LastPrice`. Confirms the divergence guard fires.
- **ANG, CFR, EXX** — additional coverage for the remainder of the top-40.

---

## 4 · Cutover procedure

### 4.1 Vercel (production web)

```bash
# 1. Update env in the Vercel project (project = autonama-group/wealth-navigator,
#    scope = autonama-group, root dir = wealth-navigator).
vercel env rm ACTIVE_MARKET_DATA_PROVIDER production --scope autonama-group --yes
vercel env add ACTIVE_MARKET_DATA_PROVIDER production --scope autonama-group
# …type the new value when prompted.

# 2. Redeploy.
vercel --scope autonama-group --prod
```

Vercel keeps `USE_SUPABASE_QUOTES=true` so the BFF continues to read
`stock_intraday_c`; flipping `ACTIVE_MARKET_DATA_PROVIDER` here is metadata for
the UI badge, but it's still wired through every code path that bypasses the
DB-first read (intraday fallthrough, history, equities overlay guard).

### 4.2 Railway `Iress-Worker`

```bash
# Use the Railway MCP (registered as mcp.railway.com).
#   - List services → pick Iress-Worker.
#   - Update variables: ACTIVE_MARKET_DATA_PROVIDER=iress, IRESS_MODE=live,
#     IRESS_WORKER_DRY_RUN=0, SUPABASE_ALLOW_WRITES=1 (only when ready to write).
#   - Trigger redeploy.
```

Only flip `SUPABASE_ALLOW_WRITES` once the production parity check has run
clean for at least one trading session; the worker default of `0` keeps the
ingest in dry-run (logs only) so a misconfigured entitlement doesn't poison the
DB.

### 4.3 Local dev

```bash
# wealth-navigator/.env.local (gitignored):
ACTIVE_MARKET_DATA_PROVIDER=iress        # or yahoo / mock / iris
USE_SUPABASE_QUOTES=false                # usually false locally
IRESS_MODE=mock                          # never run live IRESS from a laptop
```

The provider override at the per-call level is also available — useful for
debugging one symbol at a time:

```bash
curl 'http://localhost:3000/api/quotes?provider=yahoo&symbols=NPN,AGL,FSR'
curl 'http://localhost:3000/api/quotes?provider=iress&symbols=NPN,AGL,FSR'
```

---

## 5 · Health checks

Two endpoints together describe the cutover state:

### 5.1 `/api/worker-health`

Reads the `integration_worker_health` Supabase row the worker upserts on every
heartbeat (audit trail). Best for spotting ghost-worker rows after Railway
restarts.

```bash
curl https://wealth-navigator-one.vercel.app/api/worker-health
```

### 5.2 `/api/integration/health`

Path B passthrough to the worker's `/health` endpoint — surfaces the in-process
IRESS session state, `iressMode`, dry-run flag, and the live quote-sync
timestamp.

```bash
curl https://wealth-navigator-one.vercel.app/api/integration/health
```

Returns 503 when `IRESS_WORKER_URL` is unset, or when the worker is unreachable.
A healthy response looks like:

```json
{
  "ok": true,
  "workerId": "iress-worker-…",
  "iressMode": "live",
  "sessionCached": true,
  "services": ["IOSPLUSAPI", "IPSAPI", "FIXPLUSAPI"],
  "accounts": ["MINT-LIVE-001"],
  "lastQuoteSyncAt": "2026-07-09T09:14:22.000Z",
  "uptimeSec": 12345
}
```

### 5.3 `/api/admin/vendor-health`

Phase C addition — aggregates every vendor integration (IRESS, SENS, fixed-income,
MM, macro, IRIS stub) into one envelope. See
`wealth-navigator/src/app/api/admin/vendor-health/route.ts`. Use it as the single
status page for the `/oems/integration` cockpit surface.

---

## 6 · Rollback

If the new provider starts returning bad data after a cutover:

1. Revert the env flag immediately (`ACTIVE_MARKET_DATA_PROVIDER=yahoo` is the
   safe default for Vercel because it works alongside
   `USE_SUPABASE_QUOTES=true`).
2. Verify with `/api/worker-health` and `/api/integration/health` — the worker
   should still be heartbeating; the rollback only flips the BFF selector.
3. Re-run the parity scan to confirm the rollback path is healthy.
4. If the failure was upstream (e.g. an entitlement flip in IRESS broke
   `TimeSeriesGet2`), apply the per-vendor gate from
   `wealth-navigator/docs/VENDOR_ENTITLEMENT_STATUS.md` to surface the failure
   as a `data-source="blocked-vendor"` empty state rather than letting it bleed
   through as fabricated numbers.

The selector default (`yahoo` when `USE_SUPABASE_QUOTES=true` + `IRESS_MODE=mock`,
`mock` otherwise) means a missing or empty `ACTIVE_MARKET_DATA_PROVIDER` always
lands on a working provider — there's no scenario where the BFF returns a
500 because the flag was unset.

---

## 7 · Broker feed mock

The automated fill ingest that backs `/admin/order-book`'s **basket fill logic**
is currently a mock endpoint, gated by Supabase Auth + the `admin` role:

- `POST /api/admin/orderbook/fills` — accepts a broker-style fill report keyed
  by `order_id`. Updates `oems_order_audit.payload.filled` /
  `payload.avgPx` / `result_payload.avgFillPrice`, flips `status` to
  `filled` / `partial` / `rejected`, and advertises
  `book_ready_for_confirmation: true` once every row of the book hits 100%.

Example payload:

```json
{
  "order_id": "BOOK-2026-07-09-001",
  "fills": [
    { "symbol": "NPN", "qty": 120, "avg_fill_price_cents": 284050, "timestamp": "2026-07-09T09:14:00Z" },
    { "symbol": "AGL", "qty": 350, "avg_fill_price_cents": 53120 }
  ]
}
```

In production this will be replaced by a real broker feed (Phase C4 — gated on
Lonwabo confirming the vendor). Until then, the test scripts in
`wealth-navigator/scripts/` (e.g. `scan-strategy-holdings.ts`) can be reused as
a template for staging the broker-side payload.

The route lives at
`wealth-navigator/src/app/api/admin/orderbook/fills/route.ts`. The schema
requirements (table `oems_order_audit`) are owned by
`supabase/migrations/20260612000002_oems_order_audit.sql` on the institutional DB.

---

## 8 · See also

- `wealth-navigator/docs/VENDOR_ENTITLEMENT_STATUS.md` — the vendor-by-vendor
  entitlement state and the conditions for unblocking each feed.
- `wealth-navigator/docs/MINT_GO_LIVE_RUNBOOK.html` — the higher-level go-live
  runbook; this document is the data-layer slice.
- `wealth-navigator/docs/STACK_ARCHITECTURE.md` — the provider-abstraction
  architecture and the IRESS-first overlay policy.
- `wealth-navigator/scripts/scan-provider-parity.ts` — the script.
- `wealth-navigator/docs/PROVIDER_PARITY_<YYYY-MM-DD>.json` — the most recent
  parity report.

---

_Last updated: 2026-07-09, as part of the Mint OEM Finalisation Phase C cutover._