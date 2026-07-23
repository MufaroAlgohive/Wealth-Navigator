import { isIressWorkerConfigured, isWorkerLiveMode } from "@/lib/data-policy";
import { iressConfig } from "@/lib/iress";
import { callWorker } from "@/lib/iress/worker-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/iress/news?vendor=SENS&pageSize=50[&dateFrom=…&dateTo=…&symbol=NPN&includeBody=1]
 *
 * Path B BFF passthrough for the worker's `/debug/news-vendor-probe`.
 * The worker is the only process that holds the IRESS license seat;
 * this route reverse-proxies its `NewsHeadlineGet` so the UI can show
 * real headlines & bodies without ever seeing IRESS credentials.
 *
 * T5 vendor content — the route does **NOT** persist to Supabase.
 * "Seed until contracted" is the standing policy; the
 * `workers/iress-ingest/src/news-ingest.ts::syncNewsHeadlines` loop
 * persists to `news_item_c` on the prod worker, and the OEMS UI can
 * switch to `/api/news` for the historical read. This route is the
 * live passthrough for "what's on the IRESS wire right now".
 *
 * Default vendor is `"SENS"` (real-time) per the 2026-07-22 prod
 * worker plan. The worker auto-falls-back to `SENSD` (delayed) on
 * 25010 / 25018 entitlement faults. `SENSD` is still accepted as an
 * explicit override.
 *
 * Failure modes (every one returns a typed envelope — never 500 — so the
 * UI renders the honest empty state):
 *   - `IRESS_MODE === "mock"` on Vercel  → 200 `{ source: "unconfigured", tier: "T5" }`
 *   - worker URL not configured          → 503 `not_configured`
 *   - `USE_SUPABASE_QUOTES` off          → 503 `worker_mode_off`
 *   - vendor missing                     → 400 `bad_request`
 *   - worker 25010 / 25034               → 503 `upstream_error` (entitlement)
 *   - worker unreachable / 5xx           → 503 `unreachable` / `upstream_error`
 *   - worker 429 (probe rate-limited)    → 503 `upstream_error`
 */
export async function GET(req: Request) {
  if (iressConfig.mode === "mock") {
    return Response.json(
      {
        ok: false,
        source: "unconfigured",
        tier: "T5",
        mode: "mock",
        vendor: null,
        pageSize: 0,
        timeout: 0,
        headlines: [],
        dataRowCount: 0,
        error: {
          code: "T5_NOT_PERSISTED",
          message:
            "News is T5 vendor content — passthrough-only until a vendor contract is in place. No IRESS call is made from the Vercel BFF in mock mode.",
        },
      },
      { status: 200 },
    );
  }

  if (!isIressWorkerConfigured()) {
    return Response.json(
      {
        ok: false,
        source: "unconfigured",
        tier: "T5",
        error: {
          code: "not_configured",
          message:
            "Railway IRESS worker URL not configured (set IRESS_WORKER_URL or RAILWAY_SERVICE_URL on Vercel)",
        },
        headlines: [],
      },
      { status: 503 },
    );
  }
  if (!isWorkerLiveMode()) {
    return Response.json(
      {
        ok: false,
        source: "unconfigured",
        tier: "T5",
        error: {
          code: "worker_mode_off",
          message:
            "Worker live mode disabled (USE_SUPABASE_QUOTES is off) — falling back to seed/empty news panel",
        },
        headlines: [],
      },
      { status: 503 },
    );
  }

  const url = new URL(req.url);
  // Default vendor: SENS (real-time) — the prod catalog carries it
  // (per Andre's WSDL browser 2026-07-22). CT/UAT was SENSD; the
  // forward path is SENS on prod, with SENSD as the explicit fallback
  // on entitlement faults inside the worker.
  const vendorRaw = url.searchParams.get("vendor") ?? "SENS";
  const vendor = vendorRaw.trim();
  if (!vendor) {
    return Response.json(
      {
        ok: false,
        source: "unconfigured",
        tier: "T5",
        error: { code: "bad_request", message: "`vendor` query param required (e.g. ?vendor=SENS or ?vendor=SENSD)" },
        headlines: [],
      },
      { status: 400 },
    );
  }
  const pageSizeRaw = Number(url.searchParams.get("pageSize") ?? "50");
  const pageSize = Number.isFinite(pageSizeRaw) ? Math.min(1000, Math.max(1, Math.trunc(pageSizeRaw))) : 50;
  const timeoutRaw = Number(url.searchParams.get("timeout") ?? "25");
  const timeout = Number.isFinite(timeoutRaw) ? Math.min(25, Math.max(1, Math.trunc(timeoutRaw))) : 25;
  const includeBody = url.searchParams.get("includeBody") === "1";
  const dateFrom = url.searchParams.get("dateFrom")?.trim() ?? "";
  const dateTo = url.searchParams.get("dateTo")?.trim() ?? "";
  // `?symbol=NPN` — per-symbol filter on `NewsHeadlineGet`. The CT
  // build WSDL browser (Andre, 2026-07-22) exposes a `SecurityCode`
  // column on the NewsHeadlineGet row grid, suggesting the verb
  // accepts a per-symbol parameter. Forwarded to the worker for
  // confirmation; if the prod build doesn't honour it, the worker
  // ignores the param and returns the vendor-broadcast (today's
  // effective behaviour — the worker's paging loop uses
  // `DateTimeStart`/`DateTimeEnd` only).
  const symbol = url.searchParams.get("symbol")?.trim() ?? "";
  // `?vendorCatalog=1` — return the entitled vendor catalog persisted
  // by the worker at startup, alongside the headlines. Cheap to ship
  // both at once; saves the UI a second round-trip.
  const includeCatalog = url.searchParams.get("vendorCatalog") === "1";

  const queryParts = [
    `vendor=${encodeURIComponent(vendor)}`,
    `pageSize=${pageSize}`,
    `timeout=${timeout}`,
  ];
  if (includeBody) queryParts.push("includeBody=1");
  if (dateFrom) queryParts.push(`dateFrom=${encodeURIComponent(dateFrom)}`);
  if (dateTo) queryParts.push(`dateTo=${encodeURIComponent(dateTo)}`);
  if (symbol) queryParts.push(`symbol=${encodeURIComponent(symbol)}`);
  if (includeCatalog) queryParts.push("vendorCatalog=1");
  const result = await callWorker<{
    ok: boolean;
    vendor: string;
    dateTimeStart: string;
    dateTimeEnd: string;
    pageSize: number;
    timeout: number;
    errorNumber: number | null;
    errorDescription: string | null;
    rawFault: string | null;
    dataRowCount: number;
    firstRow: Record<string, unknown> | null;
    headlines: Array<{
      storyId: string;
      headline: string;
      source: string;
      timestamp: string;
      ts: number;
      category: string | null;
      relatedCodes: string[] | null;
      storyPreview: string | null;
    }>;
    iressMode: string;
    elapsedMs: number;
    probedAt: string;
    build: string;
    /** Echoed when the BFF asked `?symbol=NPN`. */
    symbolFilterRequested?: string;
    /** Vendor catalog persisted by the worker at startup (when `?vendorCatalog=1`). */
    vendorCatalog?: Array<{ vendorCode: string; vendorDescription: string }>;
  }>({ path: `/debug/news-vendor-probe?${queryParts.join("&")}` });

  if (!result.ok) {
    return Response.json(
      {
        ok: false,
        source: "unavailable",
        tier: "T5",
        vendor,
        error: {
          code: result.code,
          message: result.error,
          upstreamStatus: result.upstreamStatus,
          upstreamBody: result.errorBody,
        },
        headlines: [],
      },
      { status: result.status },
    );
  }

  return Response.json(
    { source: result.body.ok ? "live" : "unavailable", tier: "T5", ...result.body },
    { status: 200 },
  );
}
