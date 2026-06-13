/**
 * POST /api/orders/cancel
 *
 * Path B BFF passthrough — forward an OrderDelete request to the
 * Railway `iress-ingest` worker, which holds the IRESS license seat
 * and is the only process that can call `OrderDelete` on the broker.
 * Vercel never holds IRESS credentials.
 *
 * Body:
 *   { orderId: string, account?: string }
 *
 * Failure semantics:
 *   - Worker URL not configured / `USE_SUPABASE_QUOTES` off → 503 with
 *     the standard `code: "not_configured" | "worker_mode_off"` envelope.
 *   - Missing `orderId` → 400.
 *   - Worker unreachable / 5xx / 4xx → 503 with the upstream body
 *     preserved in `upstreamError` so the UI can surface it.
 *   - Worker returns 200 with `{ ok: true }` → 200, body forwarded.
 */
import { callWorker } from "@/lib/iress/worker-api";
import { isIressWorkerConfigured, isWorkerLiveMode } from "@/lib/data-policy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (!isIressWorkerConfigured()) {
    return Response.json(
      {
        ok: false,
        status: 503,
        code: "not_configured",
        error:
          "Railway IRESS worker URL not configured (set IRESS_WORKER_URL or RAILWAY_SERVICE_URL on Vercel)",
      },
      { status: 503 },
    );
  }
  if (!isWorkerLiveMode()) {
    return Response.json(
      {
        ok: false,
        status: 503,
        code: "worker_mode_off",
        error:
          "Worker live mode disabled (USE_SUPABASE_QUOTES is off) — refusing to forward an OrderDelete to the broker",
      },
      { status: 503 },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json(
      { ok: false, status: 400, code: "bad_request", error: "Request body must be JSON" },
      { status: 400 },
    );
  }
  if (!body || typeof body !== "object") {
    return Response.json(
      { ok: false, status: 400, code: "bad_request", error: "Request body must be a JSON object" },
      { status: 400 },
    );
  }
  const b = body as Record<string, unknown>;
  const orderIdRaw = b["orderId"];
  const orderId = typeof orderIdRaw === "string" ? orderIdRaw.trim() : "";
  if (!orderId) {
    return Response.json(
      { ok: false, status: 400, code: "missing_order_id", error: "`orderId` is required" },
      { status: 400 },
    );
  }
  const accountRaw = b["account"];
  const account = typeof accountRaw === "string" ? accountRaw.trim() : "";

  const result = await callWorker<{
    ok: boolean;
    orderId?: string;
    account?: string;
    cancelledAt?: string;
    error?: { code: string; message: string };
  }>({
    method: "POST",
    path: "/orders/cancel",
    body: { orderId, account: account || undefined },
  });

  if (!result.ok) {
    return Response.json(
      {
        ok: false,
        status: result.status,
        code: result.code,
        error: result.error,
        workerUrl: result.workerUrl,
        upstreamStatus: result.upstreamStatus,
        upstreamError: result.errorBody,
      },
      { status: result.status },
    );
  }

  return Response.json(result.body, { status: 200 });
}
