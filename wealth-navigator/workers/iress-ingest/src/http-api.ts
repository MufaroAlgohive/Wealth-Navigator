/**
 * Read-only HTTP server for the Railway `iress-ingest` worker.
 *
 * The Vercel BFF reverse-proxies these endpoints so the Next.js app
 * can read live worker state (orders, integration health) without ever
 * holding the IRESS license seat itself. The server is intentionally
 * minimal — Bun's built-in `node:http` is enough for a few GET/POST
 * handlers plus one SSE stream.
 *
 * Endpoints (all require `WORKER_HTTP_TOKEN` if set):
 *   GET  /health                  — heartbeat shape (no IRESS call)
 *   GET  /orders                  — `OrderPadGetByAccount` for ?account=...
 *   GET  /orders/stream           — SSE: re-polls orders and pushes deltas
 *
 * Secrets policy:
 *   - The worker reads IRESS creds from env (`IRESS_USERNAME` etc.) — never
 *     echo them in responses.
 *   - `WORKER_HTTP_TOKEN`, when set, is the shared secret the BFF sends in
 *     `Authorization: Bearer …`. Default is "no auth" because the BFF
 *     runs in a trusted Vercel env and the worker is private. Flip on
 *     for shared deployments.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { loadWorkerEnv } from "./env";
import type { WorkerEnv } from "./env";
import { writeHeartbeat, type WorkerSupabase } from "./supabase";
import { WorkerSessionManager, type WorkerMintSession } from "./session";
import { getIressClient } from "../../../src/lib/iress/index";
import { IressError, isIressSessionDeadError } from "../../../src/lib/iress/errors";
import type { Order } from "../../../src/types/iress";

/** OrderFilter values (1=WORKING, 2=OPEN, 3=ALL, 4=AMENDED, 5=HISTORICAL). */
type OrderFilter = 1 | 2 | 3 | 4 | 5;
const VALID_FILTERS = new Set<OrderFilter>([1, 2, 3, 4, 5]);

export interface HttpApiDeps {
  env: WorkerEnv;
  sessions: WorkerSessionManager;
  supabase: WorkerSupabase | null;
  /** Override the auth token check (mainly for tests). */
  authToken?: string;
}

function newRequestID(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function checkAuth(req: IncomingMessage, expected: string | undefined): boolean {
  if (!expected) return true;
  const header = req.headers.authorization ?? "";
  if (header.startsWith("Bearer ")) {
    return header.slice("Bearer ".length).trim() === expected;
  }
  // Allow X-Worker-Token for clients that can't set Authorization
  // (e.g. browser EventSource). The BFF forwards the env value.
  const alt = req.headers["x-worker-token"];
  if (typeof alt === "string" && alt.trim() === expected) return true;
  return false;
}

function send(res: ServerResponse, status: number, body: unknown, headers?: Record<string, string>): void {
  const json = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, {
    "content-type": typeof body === "string" ? "text/plain; charset=utf-8" : "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...(headers ?? {}),
  });
  res.end(json);
}

function sendError(res: ServerResponse, status: number, code: string, message: string, extra?: Record<string, unknown>): void {
  send(res, status, { ok: false, status, code, error: message, ...extra });
}

interface OrdersGetResult {
  ok: boolean;
  orders: Order[];
  source: "live" | "mock" | "unavailable";
  account: string;
  filter: OrderFilter;
  workerId: string;
  iressMode: string;
  error?: { code: string; message: string };
  fetchedAt: string;
}

async function fetchLiveOrders(
  deps: HttpApiDeps,
  account: string,
  filter: OrderFilter,
): Promise<OrdersGetResult> {
  const isLive = deps.env.iressMode === "live" || deps.env.iressMode === "wsdl-stub";
  if (!isLive) {
    return {
      ok: false,
      orders: [],
      source: "unavailable",
      account,
      filter,
      workerId: deps.env.workerId,
      iressMode: deps.env.iressMode,
      error: {
        code: "mock_mode",
        message: "Worker is running in mock mode; no live orders available",
      },
      fetchedAt: new Date().toISOString(),
    };
  }

  try {
    const session = await deps.sessions.getSession();
    const iosKey = session.serviceKeys.IOSPlus;
    if (!iosKey) {
      return {
        ok: false,
        orders: [],
        source: "unavailable",
        account,
        filter,
        workerId: deps.env.workerId,
        iressMode: deps.env.iressMode,
        error: {
          code: "ios_unavailable",
          message: "IOSPlus service session not available; order pad not entitled",
        },
        fetchedAt: new Date().toISOString(),
      };
    }
    const client = getIressClient("live");
    const res = await client.orderPadGetByAccount({
      ServiceSessionKey: iosKey,
      AccountCode: account,
      OrderFilter: filter,
      RequestID: newRequestID(`pad-${account}`),
    });
    return {
      ok: true,
      orders: res.DataRows,
      source: "live",
      account,
      filter,
      workerId: deps.env.workerId,
      iressMode: deps.env.iressMode,
      fetchedAt: new Date().toISOString(),
    };
  } catch (err) {
    if (isIressSessionDeadError(err) || (err instanceof IressError && err.code === 25001)) {
      deps.sessions.invalidate();
    }
    const message = err instanceof Error ? err.message : String(err);
    const code = err instanceof IressError ? `iress_${err.code}` : "fetch_failed";
    return {
      ok: false,
      orders: [],
      source: "unavailable",
      account,
      filter,
      workerId: deps.env.workerId,
      iressMode: deps.env.iressMode,
      error: { code, message },
      fetchedAt: new Date().toISOString(),
    };
  }
}

interface HealthSnapshot {
  ok: boolean;
  workerId: string;
  iressMode: string;
  dryRun: boolean;
  allowWrites: boolean;
  session: {
    cached: boolean;
    expiresAt: number | null;
    services: string[];
    applicationId: string | null;
  };
  accounts: string[];
  watchlistSize: number;
  timestamp: string;
  uptimeSec: number;
  lastQuoteSyncAt: string | null;
}

function buildHealthSnapshot(
  deps: HttpApiDeps,
  session: WorkerMintSession | null,
  lastQuoteSyncAt: string | undefined,
): HealthSnapshot {
  const accounts = (deps.env.iressAccountCode ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    ok: true,
    workerId: deps.env.workerId,
    iressMode: deps.env.iressMode,
    dryRun: deps.env.dryRun,
    allowWrites: deps.env.allowWrites,
    session: {
      cached: session !== null,
      expiresAt: session?.expiresAt ?? null,
      services: session ? Object.keys(session.serviceKeys) : [],
      applicationId: session?.applicationId ?? null,
    },
    accounts,
    watchlistSize: deps.env.watchlistSymbols.length,
    timestamp: new Date().toISOString(),
    uptimeSec: Math.round(process.uptime()),
    lastQuoteSyncAt: lastQuoteSyncAt ?? null,
  };
}

export interface HttpApiHandle {
  port: number;
  url: string;
  close: () => Promise<void>;
}

/**
 * Internal request dispatcher — exported for unit tests. The production
 * `startHttpApi()` wraps this in a `node:http` server; tests can call
 * it directly with a fake req/res pair to assert handler behavior
 * without binding a port.
 */
export async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: HttpApiDeps,
  getLastQuoteSyncAt: () => string | undefined,
  authToken: string | undefined,
): Promise<void> {
  if (!checkAuth(req, authToken)) {
    sendError(res, 401, "unauthorized", "Missing or invalid worker auth token");
    return;
  }
  const url = new URL(req.url ?? "/", "http://worker");
  const path = url.pathname;

  if (req.method === "GET" && path === "/health") {
    const snapshot = buildHealthSnapshot(deps, deps.sessions.peekSession(), getLastQuoteSyncAt());
    send(res, 200, snapshot);
    return;
  }

  if (req.method === "POST" && path === "/heartbeat/refresh") {
    try {
      await writeHeartbeat(deps.supabase, deps.env, {
        workerId: deps.env.workerId,
        status: "healthy",
        iressMode: deps.env.iressMode,
        lastQuoteSyncAt: getLastQuoteSyncAt(),
        symbolsCovered: deps.env.watchlistSymbols,
        metadata: { source: "http_api", at: new Date().toISOString() },
      });
      send(res, 200, { ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, 500, "heartbeat_failed", message);
    }
    return;
  }

  if (req.method === "GET" && path === "/orders") {
    const account = url.searchParams.get("account")?.trim() || deps.env.iressAccountCode.split(",")[0]?.trim() || "";
    if (!account) {
      sendError(
        res,
        503,
        "account_not_configured",
        "Order account code not configured (set IRESS_ACCOUNT_CODE on the worker)",
        { hint: "Pass ?account=ACC1 or configure IRESS_ACCOUNT_CODE on the worker" },
      );
      return;
    }
    const filterParam = Number(url.searchParams.get("filter") ?? "1");
    const filter: OrderFilter = (VALID_FILTERS.has(filterParam as OrderFilter)
      ? filterParam
      : 1) as OrderFilter;
    const result = await fetchLiveOrders(deps, account, filter);
    // 200 with ok=false when the worker has an answer but it's "no
    // orders" / "mock mode" / "session not ready" — those are real
    // answers the UI should display, not failures.
    send(res, 200, result);
    return;
  }

  if (req.method === "GET" && path === "/orders/stream") {
    await streamOrders(req, res, deps, getLastQuoteSyncAt, url);
    return;
  }

  sendError(res, 404, "not_found", `No route for ${req.method ?? "GET"} ${path}`);
}

/**
 * Bind a `node:http` server. Returns the bound port so the caller
 * can log it; the server is fire-and-forget after that. Pass
 * `authToken` (or set `WORKER_HTTP_TOKEN` in env) to require it.
 */
export function startHttpApi(
  deps: HttpApiDeps,
  getLastQuoteSyncAt: () => string | undefined,
): Promise<HttpApiHandle> {
  const port = Number(process.env.WORKER_HTTP_PORT ?? "8765");
  const host = process.env.WORKER_HTTP_HOST ?? "0.0.0.0";
  const authToken = deps.authToken ?? process.env.WORKER_HTTP_TOKEN ?? undefined;

  return new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      try {
        await handleRequest(req, res, deps, getLastQuoteSyncAt, authToken);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[iress-ingest] http handler error: ${message}`);
        if (!res.headersSent) sendError(res, 500, "internal", "Unhandled worker error");
      }
    });
    server.once("error", (err) => reject(err));
    server.listen(port, host, () => {
      const addr = server.address() as AddressInfo;
      const url = `http://${host}:${addr.port}`;
      console.info(
        `[iress-ingest] http api listening on ${url} (auth=${authToken ? "on" : "off"})`,
      );
      resolve({
        port: addr.port,
        url,
        close: () =>
          new Promise<void>((resolveClose) => {
            server.close(() => resolveClose());
          }),
      });
    });
  });
}

async function streamOrders(
  req: IncomingMessage,
  res: ServerResponse,
  deps: HttpApiDeps,
  getLastQuoteSyncAt: () => string | undefined,
  url: URL,
): Promise<void> {
  const account = url.searchParams.get("account")?.trim() || deps.env.iressAccountCode.split(",")[0]?.trim() || "";
  if (!account) {
    sendError(
      res,
      503,
      "account_not_configured",
      "Order account code not configured (set IRESS_ACCOUNT_CODE on the worker)",
    );
    return;
  }
  const filterParam = Number(url.searchParams.get("filter") ?? "1");
  const filter: OrderFilter = (VALID_FILTERS.has(filterParam as OrderFilter)
    ? filterParam
    : 1) as OrderFilter;
  const intervalSec = Math.max(2, Number(url.searchParams.get("interval") ?? "5"));

  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store, no-transform",
    "connection": "keep-alive",
    "x-accel-buffering": "no",
  });
  res.write(`retry: 5000\n\n`);

  let closed = false;
  const onClose = () => {
    closed = true;
  };
  req.on("close", onClose);
  req.on("aborted", onClose);

  const push = (event: string, data: unknown) => {
    if (closed) return;
    try {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch {
      closed = true;
    }
  };

  const initial = await fetchLiveOrders(deps, account, filter);
  push("snapshot", { ...initial, lastQuoteSyncAt: getLastQuoteSyncAt() ?? null });
  if (closed) return;

  while (!closed) {
    await new Promise((resolve) => setTimeout(resolve, intervalSec * 1000));
    if (closed) break;
    const next = await fetchLiveOrders(deps, account, filter);
    push("update", { ...next, lastQuoteSyncAt: getLastQuoteSyncAt() ?? null });
  }
  res.end();
}
