import { streamWorkerSse } from "@/lib/iress/worker-api";
import { isIressWorkerConfigured, isWorkerLiveMode } from "@/lib/data-policy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/orders/stream?account=ACC1&filter=1&interval=5
 *
 * Path B SSE forwarder — opens a streaming fetch to the Railway worker's
 * `/orders/stream` endpoint and pipes events back to the browser as
 * `text/event-stream`. Aborting the route's `request.signal` (client
 * disconnect) tears down the upstream fetch via `AbortController`.
 *
 * The worker re-polls `OrderPadGetByAccount` every `interval` seconds
 * and emits `snapshot` (first batch) followed by `update` events.
 *
 * Returns 503 with the standard error envelope when the worker URL is
 * not configured or `USE_SUPABASE_QUOTES` is off — never 500.
 */
export async function GET(req: Request) {
  if (!isIressWorkerConfigured() || !isWorkerLiveMode()) {
    const code = !isIressWorkerConfigured() ? "not_configured" : "worker_mode_off";
    const error = !isIressWorkerConfigured()
      ? "Railway IRESS worker URL not configured (set IRESS_WORKER_URL or RAILWAY_SERVICE_URL on Vercel)"
      : "Worker live mode disabled (USE_SUPABASE_QUOTES is off)";
    return Response.json(
      { ok: false, status: 503, code, error },
      { status: 503, headers: { "content-type": "application/json" } },
    );
  }

  const url = new URL(req.url);
  const account = url.searchParams.get("account")?.trim();
  if (!account) {
    return Response.json(
      {
        ok: false,
        status: 400,
        code: "missing_account",
        error: "account query param required (e.g. ?account=ACC1)",
      },
      { status: 400 },
    );
  }
  const filter = url.searchParams.get("filter") ?? "1";
  const interval = url.searchParams.get("interval") ?? "5";
  const path = `/orders/stream?account=${encodeURIComponent(account)}&filter=${encodeURIComponent(filter)}&interval=${encodeURIComponent(interval)}`;

  const target = streamWorkerSse({ path });
  if (!target) {
    return Response.json(
      { ok: false, status: 503, code: "not_configured", error: "Worker not configured" },
      { status: 503 },
    );
  }

  const upstream = await fetch(target.url, {
    method: "GET",
    headers: { Accept: "text/event-stream", ...target.headers },
    signal: req.signal,
    cache: "no-store",
  });

  if (!upstream.ok || !upstream.body) {
    // Try to surface the upstream error body for debugging (still capped).
    const text = upstream.body ? await upstream.text() : "";
    return Response.json(
      {
        ok: false,
        status: 502,
        code: "upstream_error",
        error: `Worker SSE returned ${upstream.status}`,
        upstreamStatus: upstream.status,
        upstreamBody: text.slice(0, 4096),
      },
      { status: 502 },
    );
  }

  // Forward SSE verbatim. Vercel edge functions (node runtime) can hold
  // long-lived streams as long as the function is allowed to run; we
  // surface `retry: 5000` from the worker so the browser reconnect
  // cadence is sane if we drop the connection.
  return new Response(upstream.body, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
