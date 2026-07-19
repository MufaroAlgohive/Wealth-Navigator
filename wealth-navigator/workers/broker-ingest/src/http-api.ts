/**
 * Minimal HTTP API for the Railway `broker-ingest` worker.
 *
 * Endpoints (all require `WORKER_HTTP_TOKEN` if set):
 *   GET  /health                  — heartbeat shape (no broker call)
 *   GET  /state                   — current poll state (cursor + fills applied)
 *   POST /debug/inject-fill       — manual fill injection (test only)
 *
 * The Vercel BFF reverse-proxies /health from this server so Next.js
 * never holds the broker credential. /debug/inject-fill is test-only and
 * gated by `WORKER_HTTP_TOKEN` regardless of mode so an unauthenticated
 * client can't pollute the audit table.
 *
 * SECURITY (opt-in enforcement, mirrors iress-ingest): `checkAuth` fails
 * OPEN when `WORKER_HTTP_TOKEN` is unset so a forgetful deploy never bricks
 * the worker. Mutating requests served without a token log a loud CRITICAL
 * line, and setting `WORKER_REQUIRE_HTTP_TOKEN=1` (see index.ts) refuses to
 * start until the token is present — the deliberate way to close the hole.
 */

import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";

import type { WorkerEnv } from "./env";
import type { BrokerFill } from "./fills";
import { applyFills } from "./fills";
import { type WorkerSupabase, writeHeartbeat } from "./supabase";

export interface HttpApiState {
  cursor: string;
  pollsCompleted: number;
  fillsApplied: number;
  booksCompleted: string[];
  rebalanceRequestIdsExecuted: string[];
  lastError: string | null;
}

export interface HttpApiDeps {
  env: WorkerEnv;
  supabase: WorkerSupabase | null;
  /** Mutable state container so the loop + handler share it. */
  state: HttpApiState;
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
  const alt = req.headers["x-worker-token"];
  if (typeof alt === "string" && alt.trim() === expected) return true;
  return false;
}

/**
 * Mutating HTTP routes — the fill injector and the heartbeat writer. Used only
 * to decide whether to log a CRITICAL "served without auth" line when
 * WORKER_HTTP_TOKEN is unset (fail-open). Read/probe routes stay quiet.
 * Mirrors the iress-ingest worker so both surfaces harden the same way.
 */
function isMutatingRequest(method: string | undefined, path: string): boolean {
  const m = (method ?? "GET").toUpperCase();
  return m === "POST" && (path === "/debug/inject-fill" || path === "/heartbeat/refresh");
}

function send(res: ServerResponse, status: number, body: unknown, headers?: Record<string, string>): void {
  const json = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, {
    "content-type":
      typeof body === "string" ? "text/plain; charset=utf-8" : "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...(headers ?? {}),
  });
  res.end(json);
}

function sendError(
  res: ServerResponse,
  status: number,
  code: string,
  message: string,
  extra?: Record<string, unknown>,
): void {
  send(res, status, { ok: false, status, code, error: message, ...extra });
}

async function readBodyJson(req: IncomingMessage, maxBytes = 32 * 1024): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    let total = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error(`Request body exceeds ${maxBytes} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf-8");
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch (err) {
        reject(new Error(`Invalid JSON body: ${(err as Error).message}`));
      }
    });
    req.on("error", reject);
  });
}

interface HealthSnapshot {
  ok: boolean;
  workerId: string;
  brokerMode: string;
  dryRun: boolean;
  allowWrites: boolean;
  brokerApiConfigured: boolean;
  pollIntervalMs: number;
  state: HttpApiState;
  uptimeSec: number;
  timestamp: string;
}

function buildHealthSnapshot(deps: HttpApiDeps): HealthSnapshot {
  return {
    ok: true,
    workerId: deps.env.workerId,
    brokerMode: deps.env.brokerMode,
    dryRun: deps.env.dryRun,
    allowWrites: deps.env.allowWrites,
    brokerApiConfigured: Boolean(deps.env.brokerApiUrl),
    pollIntervalMs: deps.env.pollIntervalMs,
    state: { ...deps.state },
    uptimeSec: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  };
}

/**
 * Internal request dispatcher — exported for unit tests. Production
 * `startHttpApi()` wraps this in a `node:http` server.
 */
export async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: HttpApiDeps,
  authToken: string | undefined,
): Promise<void> {
  if (!checkAuth(req, authToken)) {
    sendError(res, 401, "unauthorized", "Missing or invalid worker auth token");
    return;
  }
  const url = new URL(req.url ?? "/", "http://worker");
  const path = url.pathname;

  // SECURITY: checkAuth fails OPEN when WORKER_HTTP_TOKEN is unset (so an
  // auto-deploy that forgets the token never takes the worker down). Emit a
  // loud CRITICAL line on every mutating request served without auth so the
  // exposure is visible and the operator is nudged to set the token and flip
  // WORKER_REQUIRE_HTTP_TOKEN=1. Reads stay quiet to avoid log spam.
  if (!authToken && isMutatingRequest(req.method, path)) {
    console.error(
      JSON.stringify({
        level: "critical",
        event: "worker_http_unauthenticated_mutation",
        method: req.method ?? "GET",
        path,
        message:
          "Mutating worker HTTP request served WITHOUT auth (WORKER_HTTP_TOKEN unset). Set WORKER_HTTP_TOKEN on the worker + BFF, then WORKER_REQUIRE_HTTP_TOKEN=1 to enforce.",
      }),
    );
  }

  if (req.method === "GET" && path === "/health") {
    const snapshot = buildHealthSnapshot(deps);
    send(res, 200, snapshot);
    return;
  }

  if (req.method === "GET" && path === "/state") {
    send(res, 200, { ok: true, ...deps.state });
    return;
  }

  if (req.method === "POST" && path === "/heartbeat/refresh") {
    try {
      await writeHeartbeat(deps.supabase, deps.env, {
        workerId: deps.env.workerId,
        status: "healthy",
        brokerMode: deps.env.brokerMode,
        lastFillSyncAt: deps.state.cursor,
        fillsProcessed: deps.state.fillsApplied,
        metadata: { source: "http_api", at: new Date().toISOString() },
      });
      send(res, 200, { ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, 500, "heartbeat_failed", message);
    }
    return;
  }

  if (req.method === "POST" && path === "/debug/inject-fill") {
    let body: unknown;
    try {
      body = await readBodyJson(req);
    } catch (err) {
      sendError(res, 400, "bad_request", (err as Error).message);
      return;
    }
    if (!body || typeof body !== "object") {
      sendError(res, 400, "bad_request", "Body must be a JSON object");
      return;
    }
    const b = body as Record<string, unknown>;
    const orderId = typeof b["order_id"] === "string" ? b["order_id"].trim() : "";
    const symbol = typeof b["symbol"] === "string" ? b["symbol"].trim().toUpperCase() : "";
    const qty = Number(b["qty"] ?? 0);
    const avgCents = Number(b["avg_fill_price_cents"] ?? 0);
    if (!orderId || !symbol || qty <= 0 || avgCents <= 0) {
      sendError(res, 400, "bad_request", "order_id, symbol, qty>0, avg_fill_price_cents>0 are required");
      return;
    }
    const fill: BrokerFill = {
      order_id: orderId,
      symbol,
      qty,
      avg_fill_price_cents: Math.round(avgCents),
      fill_timestamp:
        typeof b["fill_timestamp"] === "string" ? b["fill_timestamp"] : new Date().toISOString(),
    };
    try {
      const apply = await applyFills(deps.env, deps.supabase, [fill]);
      deps.state.fillsApplied += apply.updatedAuditRows;
      deps.state.booksCompleted = Array.from(
        new Set([...deps.state.booksCompleted, ...apply.booksCompleted]),
      );
      deps.state.rebalanceRequestIdsExecuted = Array.from(
        new Set([...deps.state.rebalanceRequestIdsExecuted, ...apply.rebalanceRequestIdsExecuted]),
      );
      send(res, 200, { ok: true, applied: apply.updatedAuditRows, ...apply });
    } catch (err) {
      sendError(res, 500, "apply_failed", err instanceof Error ? err.message : String(err));
    }
    return;
  }

  sendError(res, 404, "not_found", `No route for ${req.method ?? "GET"} ${path}`);
}

export function startHttpApi(
  deps: HttpApiDeps,
): Promise<{ port: number; url: string; close: () => Promise<void> }> {
  const port = Number(process.env.WORKER_HTTP_PORT ?? "8766");
  const host = process.env.WORKER_HTTP_HOST ?? "0.0.0.0";
  const authToken = process.env.WORKER_HTTP_TOKEN ?? undefined;

  return new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      try {
        await handleRequest(req, res, deps, authToken);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[broker-ingest] http handler error: ${message}`);
        if (!res.headersSent) sendError(res, 500, "internal", "Unhandled worker error");
      }
    });
    server.once("error", (err) => reject(err));
    server.listen(port, host, () => {
      const addr = server.address() as AddressInfo;
      const url = `http://${host}:${addr.port}`;
      console.info(`[broker-ingest] http api listening on ${url} (auth=${authToken ? "on" : "off"})`);
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

void newRequestID; // currently unused in this stub but ready for live-mode prober routes
