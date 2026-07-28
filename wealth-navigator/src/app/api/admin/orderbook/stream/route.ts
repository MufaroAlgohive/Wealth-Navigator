import { isIressWorkerConfigured } from "@/lib/data-policy";
import { streamWorkerSse } from "@/lib/iress/worker-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/admin/orderbook/stream
 *
 * SSE forwarder to the Railway worker's
 * `/uat/execution-stream` endpoint. Pipes `status` / `delta` events from
 * the worker's UAT order-pad poll back to the browser so the ExecutionView
 * can update fills in real time without polling.
 *
 * Aborting `req.signal` (client disconnect) tears down the upstream fetch
 * via `AbortController`, so Vercel doesn't keep streaming into a dead
 * socket.
 *
 * Returns 503 with the standard error envelope when the worker is not
 * configured — never 500. The UI handles 503 by falling back to its poll of
 * `/api/admin/orderbook/execution`.
 */
export async function GET(req: Request) {
  if (!isIressWorkerConfigured()) {
    return Response.json(
      {
        ok: false,
        status: 503,
        code: "not_configured",
        error: "Railway IRESS worker URL not configured (set IRESS_WORKER_URL on Vercel)",
      },
      { status: 503, headers: { "content-type": "application/json" } },
    );
  }

  /* No UAT gate. This is a read-only feed of execution deltas from our own
     order pad, and the worker's fill poller runs on the production lane too. The
     UAT gate here meant that with IRESS_UAT_MODE off — i.e. in production, where
     the real orders are — the stream 503'd, the UI fell back to polling, and a
     fill took a poll cycle to appear instead of arriving as it happened. */

  const target = streamWorkerSse({ path: "/uat/execution-stream" });
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
