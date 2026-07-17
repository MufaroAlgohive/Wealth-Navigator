/**
 * Read-only HTTP client for the Railway `iress-ingest` worker.
 *
 * Path B BFF passthroughs (live orders, integration health, SSE streams)
 * use this helper to reverse-proxy worker endpoints without exposing
 * IRESS credentials to the browser. The worker is the only process that
 * holds the IRESS license seat; Vercel never does.
 *
 * Failure semantics:
 * - Worker URL not configured → 503 "Worker not configured".
 * - Network / 5xx from worker → 503 "Worker unreachable" with the
 *   underlying error in `errorBody` so the UI can show a useful message
 *   (e.g. "Order account code not configured" bubbles up from the
 *   worker when `IRESS_ACCOUNT_CODE` is empty).
 * - Timeout (default 10 s) → 504 "Worker timeout".
 *
 * Never throws — every failure is shaped into a `WorkerApiResult` so the
 * route handler can `return` it directly. Server-side only; this module
 * imports no client-only code.
 */

import { getIressWorkerUrl } from "@/lib/data-policy";

/** Default per-call timeout for Path B BFF passthroughs. */
export const WORKER_API_TIMEOUT_MS = 10_000;

/** Standard error envelope shape for worker passthroughs. */
export interface WorkerApiError {
  ok: false;
  status: number;
  code:
    | "not_configured"
    | "unreachable"
    | "timeout"
    | "upstream_error";
  error: string;
  workerUrl?: string;
  upstreamStatus?: number;
  errorBody?: unknown;
}

export interface WorkerApiSuccess<T> {
  ok: true;
  status: number;
  body: T;
  contentType?: string;
}

export type WorkerApiResult<T> = WorkerApiSuccess<T> | WorkerApiError;

/** Options for a single worker call. */
export interface WorkerApiOptions {
  /** Method (default "GET"). */
  method?: "GET" | "POST";
  /** Query string, e.g. "?account=ACC1&filter=1" (no leading /). */
  path?: string;
  /** Optional JSON body for POST. */
  body?: unknown;
  /** Override default 10 s timeout. */
  timeoutMs?: number;
  /** Optional AbortSignal — when aborted, the call rejects with "aborted". */
  signal?: AbortSignal;
  /**
   * Extra headers (e.g. Authorization for shared secret). Avoid sending
   * IRESS credentials — those stay on the worker.
   */
  headers?: Record<string, string>;
}

/**
 * Normalize a possibly-misconfigured worker base URL. Railway shows the public
 * domain and the internal port ("Port 8765") on separate lines; the public URL
 * is HTTPS on 443 with no port, so the common paste mistakes are a missing
 * scheme and a stray " Port 8765" suffix. This repairs both so a slightly-wrong
 * IRESS_WORKER_URL still resolves. Returns "" when unset.
 */
function resolvedBase(): string {
  let base = (getIressWorkerUrl() ?? "").trim();
  if (!base) return "";
  base = base.replace(/\s+port\s+\d+/gi, ""); // drop a stray " Port 8765"
  base = base.replace(/\s+/g, ""); // a URL never contains whitespace
  if (!/^https?:\/\//i.test(base)) base = `https://${base}`;
  base = base.replace(/\/+$/, ""); // no trailing slash
  return base;
}

function buildUrl(path: string | undefined): string {
  const base = resolvedBase();
  if (!base) return "";
  if (!path) return base;
  if (path.startsWith("?")) return `${base}${path}`;
  if (path.startsWith("/")) return `${base}${path}`;
  return `${base}/${path}`;
}

/**
 * Read the response body as either JSON or text. Worker endpoints return
 * JSON for orders/health and `text/event-stream` for SSE — we never want
 * to attempt `res.json()` on the latter.
 */
async function readBody(
  res: Response,
): Promise<{ contentType: string; json: <T>() => Promise<T>; text: () => Promise<string> }> {
  const contentType = res.headers.get("content-type") ?? "";
  return {
    contentType,
    json: async <T>() => (await res.json()) as T,
    text: async () => await res.text(),
  };
}

function notConfigured(): WorkerApiError {
  return {
    ok: false,
    status: 503,
    code: "not_configured",
    error:
      "Railway IRESS worker URL not configured (set IRESS_WORKER_URL or RAILWAY_SERVICE_URL on Vercel)",
  };
}

function timeoutResult(workerUrl: string, timeoutMs: number): WorkerApiError {
  return {
    ok: false,
    status: 504,
    code: "timeout",
    error: `Worker request timed out after ${timeoutMs}ms`,
    workerUrl,
  };
}

function unreachable(workerUrl: string, message: string): WorkerApiError {
  return {
    ok: false,
    status: 503,
    code: "unreachable",
    error: `Worker unreachable: ${message}`,
    workerUrl,
  };
}

function upstreamError(
  workerUrl: string,
  upstreamStatus: number,
  body: unknown,
): WorkerApiError {
  return {
    ok: false,
    status: 503,
    code: "upstream_error",
    error: `Worker returned ${upstreamStatus}`,
    workerUrl,
    upstreamStatus,
    errorBody: body,
  };
}

/**
 * Call the worker. Returns a discriminated result — the caller never
 * has to catch network / timeout errors.
 */
export async function callWorker<T = unknown>(
  opts: WorkerApiOptions = {},
): Promise<WorkerApiResult<T>> {
  const base = resolvedBase();
  if (!base) return notConfigured();
  const url = buildUrl(opts.path);
  const timeoutMs = opts.timeoutMs ?? WORKER_API_TIMEOUT_MS;

  const ac = new AbortController();
  const timeout = setTimeout(() => ac.abort(new Error("worker-timeout")), timeoutMs);
  // Forward caller's signal so the route handler can short-circuit SSE
  // disconnects (otherwise the AbortController leaks and the worker
  // keeps writing into a dead socket).
  if (opts.signal) {
    if (opts.signal.aborted) ac.abort(opts.signal.reason);
    else opts.signal.addEventListener("abort", () => ac.abort(opts.signal?.reason), { once: true });
  }

  try {
    const res = await fetch(url, {
      method: opts.method ?? "GET",
      headers: {
        Accept: "application/json",
        ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
        // Forward the worker HTTP token when configured so the worker's checkAuth
        // accepts BFF-proxied order calls once WORKER_HTTP_TOKEN is set on BOTH
        // sides. Unset token = no header = worker fail-open (today's behavior);
        // this must be wired BEFORE the token is set on the worker, else every
        // BFF->worker order call would 401.
        ...(process.env.WORKER_HTTP_TOKEN
          ? { Authorization: `Bearer ${process.env.WORKER_HTTP_TOKEN}` }
          : {}),
        ...(opts.headers ?? {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: ac.signal,
      // No `next.revalidate` / cache — every worker call is fresh.
      cache: "no-store",
    });
    const reader = await readBody(res);
    if (!res.ok) {
      // Surface the worker's body verbatim when available — many endpoints
      // encode useful messages ("Order account code not configured",
      // "no IRESS session"). Strip password-shaped fields defensively.
      const text = await reader.text();
      const trimmed = text.slice(0, 16 * 1024);
      let parsed: unknown = trimmed;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        /* not JSON — keep text */
      }
      return upstreamError(base, res.status, parsed);
    }
    const body = (await reader.json()) as T;
    return { ok: true, status: res.status, body, contentType: reader.contentType };
  } catch (err) {
    if (ac.signal.aborted && ac.signal.reason instanceof Error && ac.signal.reason.message === "worker-timeout") {
      return timeoutResult(base, timeoutMs);
    }
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof Error && (err.name === "AbortError" || message.includes("aborted"))) {
      // Caller-driven abort (e.g. SSE client disconnected) — bubble up as
      // a 503 unreachable with the abort reason, NOT a 504 timeout, so the
      // client knows to stop retrying.
      return unreachable(base, message || "aborted");
    }
    return unreachable(base, message);
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Stream an SSE response from the worker back to the browser.
 *
 * The Vercel response keeps the underlying `ReadableStream` flowing
 * while piping events through `enqueue` — aborting the route's
 * `request.signal` tears down the upstream `fetch` and the controller
 * closes cleanly. Used by `/api/orders/stream` for live order updates.
 *
 * Returns `null` when the worker is not configured (caller should
 * respond 503 with the standard error envelope).
 */
export function streamWorkerSse(opts: {
  path?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}): { url: string; headers: Record<string, string> } | null {
  const base = resolvedBase();
  if (!base) return null;
  return {
    url: buildUrl(opts.path),
    headers: { Accept: "text/event-stream" },
  };
}

/**
 * Internal helper exported for tests — returns the resolved worker URL
 * for diagnostic endpoints. Never expose to clients.
 */
export function debugResolvedWorkerUrl(): string {
  return resolvedBase();
}
