import { callWorker } from "@/lib/iress/worker-api";
import { iressConfig } from "@/lib/iress";
import {
  isIressWorkerConfigured,
  isWorkerLiveMode,
} from "@/lib/data-policy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/iress/news?vendor=SENS&pageSize=50
 *
 * Path B BFF passthrough for the worker's `/debug/news-vendor-probe`. The
 * worker is the only process that holds the IRESS license seat; this
 * route reverse-proxies its `NewsVendorGet` so the UI can show real
 * headlines & bodies without ever seeing IRESS credentials.
 *
 * T5 vendor content — the route does **NOT** persist to Supabase.
 * "Seed until contracted" is the standing policy; once a vendor
 * contract is in place the worker can ingest to `news_item_c` and the
 * UI can switch to `/api/news`. Until then this is a pure read.
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
    // Vercel BFF stays on mock — never call IRESS from Vercel directly.
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
  const vendorRaw = url.searchParams.get("vendor") ?? "SENS";
  const vendor = vendorRaw.trim();
  if (!vendor) {
    return Response.json(
      {
        ok: false,
        source: "unconfigured",
        tier: "T5",
        error: { code: "bad_request", message: "`vendor` query param required (e.g. ?vendor=SENS)" },
        headlines: [],
      },
      { status: 400 },
    );
  }
  const pageSizeRaw = Number(url.searchParams.get("pageSize") ?? "50");
  const pageSize = Number.isFinite(pageSizeRaw)
    ? Math.min(1000, Math.max(1, Math.trunc(pageSizeRaw)))
    : 50;
  const timeoutRaw = Number(url.searchParams.get("timeout") ?? "25");
  const timeout = Number.isFinite(timeoutRaw)
    ? Math.min(25, Math.max(1, Math.trunc(timeoutRaw)))
    : 25;
  const includeBody = url.searchParams.get("includeBody") === "1";

  // Forward to the worker probe. The worker is the only process that
  // actually speaks SOAP to IRESS for this method; the Vercel BFF is a
  // dumb reverse-proxy.
  const query = `vendor=${encodeURIComponent(vendor)}&pageSize=${pageSize}&timeout=${timeout}${
    includeBody ? "&includeBody=1" : ""
  }`;
  const result = await callWorker<{
    ok: boolean;
    vendor: string;
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
  }>({ path: `/debug/news-vendor-probe?${query}` });

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

  // Bubble the worker's full envelope through. The UI distinguishes
  // `ok=false` (entitlement/rate-limited/etc.) from `ok=true` (real
  // headlines) by `dataRowCount` and the per-row shape.
  return Response.json(
    { source: result.body.ok ? "live" : "unavailable", tier: "T5", ...result.body },
    { status: 200 },
  );
}