import { callWorker } from "@/lib/iress/worker-api";
import { isIressWorkerConfigured, isWorkerLiveMode } from "@/lib/data-policy";
import type { Order } from "@/types/iress";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/orders/live?account=ACC1&filter=1
 *
 * Path B BFF passthrough — reverse-proxies the Railway `iress-ingest`
 * worker's `/orders` endpoint, which calls `OrderPadGetByAccount` on
 * the IRESS license seat. The browser never sees IRESS credentials.
 *
 * When the worker is unreachable / not configured, this returns 503
 * (never 500) so the UI can degrade gracefully — the existing
 * `/api/orders` Supabase audit read remains the source of truth for
 * the historical blotter, while this endpoint surfaces the
 * working/open pad from the broker in near real-time.
 */
export async function GET(req: Request) {
  if (!isIressWorkerConfigured()) {
    return Response.json(
      {
        ok: false,
        status: 503,
        code: "not_configured",
        error:
          "Railway IRESS worker URL not configured (set IRESS_WORKER_URL or RAILWAY_SERVICE_URL on Vercel)",
        orders: [] as Order[],
        source: "unavailable",
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
          "Worker live mode disabled (USE_SUPABASE_QUOTES is off) — falling back to /api/orders audit read",
        orders: [] as Order[],
        source: "unavailable",
      },
      { status: 503 },
    );
  }

  const url = new URL(req.url);
  const account = url.searchParams.get("account")?.trim() ?? "";
  if (!account) {
    return Response.json(
      {
        ok: false,
        status: 400,
        code: "missing_account",
        error: "account query param required (e.g. ?account=ACC1)",
        orders: [] as Order[],
        source: "unavailable",
      },
      { status: 400 },
    );
  }
  const filter = url.searchParams.get("filter") ?? "1";

  const result = await callWorker<{
    ok: boolean;
    orders: Order[];
    source: "live" | "mock" | "unavailable";
    account: string;
    filter: number;
    workerId: string;
    iressMode: string;
    error?: { code: string; message: string };
    fetchedAt: string;
  }>({ path: `/orders?account=${encodeURIComponent(account)}&filter=${encodeURIComponent(filter)}` });

  if (!result.ok) {
    const body = {
      ok: false,
      status: result.status,
      code: result.code,
      error: result.error,
      orders: [] as Order[],
      source: "unavailable" as const,
      workerUrl: result.workerUrl,
      upstreamStatus: result.upstreamStatus,
      upstreamError: result.errorBody,
    };
    return Response.json(body, { status: result.status });
  }

  // Worker returns 200 with ok=false when it has an answer but it's a
  // documented "no live orders" / "mock mode" shape — bubble that up
  // verbatim. The UI distinguishes by `ok` and `source`.
  return Response.json(result.body, { status: 200 });
}
