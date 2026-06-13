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
 *   GET  /debug/ips-session       — IPS / IOSPlus / FIXPlus service session
 *                                    state (no IRESS call; reads the cached
 *                                    session). Used by the BFF
 *                                    `/api/integration/diagnostics` route.
 *   GET  /orders                  — `OrderPadGetByAccount` for ?account=...
 *   GET  /orders/stream           — SSE: re-polls orders and pushes deltas
 *   POST /debug/timeseries-probe  — single-shot `TimeSeriesGet2` with the
 *                                    caller-supplied `<Interval>` string
 *                                    (e.g. "Daily"). Used to verify a
 *                                    candidate V4 string against the live
 *                                    CT server.
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
import type { Order, IressService } from "../../../src/types/iress";
import { fetchLiveQuote } from "./quotes";

/** Services whose service-session state `/debug/ips-session` surfaces. */
const KNOWN_SERVICE_SESSIONS: ReadonlyArray<IressService> = ["IOSPlus", "IPS", "FIXPlus"];

/** Redact a session key to its first 8 chars (or null when absent). */
function redactServiceKey(key: string | undefined): string | null {
  if (!key) return null;
  return key.slice(0, 8);
}

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

interface TimeSeriesProbeResult {
  ok: boolean;
  code: string;
  exchange: string;
  interval: string | null;
  frequency: number | null;
  errorNumber: number | null;
  errorDescription: string | null;
  rawFault: string | null;
  dataRowCount: number;
  firstRow: Record<string, unknown> | null;
  iressMode: string;
  elapsedMs: number;
  probedAt: string;
}

/**
 * One-shot `TimeSeriesGet2` probe with the caller-supplied period
 * selector.
 *
 * The empirical truth (June 2026, see
 * `wealth-navigator/docs/TIMESERIES_PROBE_REPORT_FINAL.md`) is that
 * the live CT server honours `<Frequency>` (Long), NOT the
 * `<Interval>` string the V4 WSDL sample documents. Earlier Long
 * guesses (0, 8) returned
 *   `soap:Receiver — Invalid Parameter Value: <n> as Frequency`
 * because those specific values were wrong, not because the wire shape
 * was. The probe accepts either form so future debugging can run both
 * shapes against the live server without redeploying the worker.
 *
 * Caller body shape (POST /debug/timeseries-probe):
 *   { code: "J203", exchange?: "JSE", interval?: "Daily", frequency?: 5 }
 *
 * Precedence: when both `interval` and `frequency` are supplied, the
 * probe sends `Frequency` (the empirically-correct live shape). When
 * neither is supplied we return 400.
 *
 * The endpoint requires `WORKER_HTTP_TOKEN` when set (same auth as the
 * rest of the worker HTTP surface). The response is intentionally
 * 1:1 with the IRESS shape — no mapping, no fabrication — so the
 * caller can identify success/failure without trusting the worker.
 */
async function probeTimeSeriesInterval(
  deps: HttpApiDeps,
  code: string,
  exchange: string,
  interval: string | null,
  frequency: number | null,
): Promise<TimeSeriesProbeResult> {
  const started = Date.now();
  const hasFrequency = typeof frequency === "number" && Number.isFinite(frequency);
  const hasInterval = typeof interval === "string" && interval.trim() !== "";
  try {
    const session = await deps.sessions.getSession();
    const client = getIressClient("live");
    const res = await client.timeSeriesGet2({
      Header: {
        SessionKey: session.iressSessionKey,
        RequestID: newRequestID(`probe-${hasFrequency ? `f${frequency}` : `i${interval}`}`),
        Timeout: 15,
      },
      Code: code,
      Exchange: exchange,
      From: new Date(Date.now() - 14 * 86400_000).toISOString().slice(0, 10),
      To: new Date().toISOString().slice(0, 10),
      ...(hasFrequency ? { Frequency: frequency } : {}),
      ...(hasInterval ? { Interval: interval } : {}),
    });
    return {
      ok: res.Header.ErrorNumber === 0,
      code,
      exchange,
      interval,
      frequency,
      errorNumber: res.Header.ErrorNumber ?? null,
      errorDescription: res.Header.ErrorDescription ?? null,
      rawFault: null,
      dataRowCount: res.DataRows?.length ?? 0,
      firstRow: (res.DataRows?.[0] as Record<string, unknown> | undefined) ?? null,
      iressMode: deps.env.iressMode,
      elapsedMs: Date.now() - started,
      probedAt: new Date().toISOString(),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const faultCode = err instanceof IressError ? err.code : null;
    return {
      ok: false,
      code,
      exchange,
      interval,
      frequency,
      errorNumber: faultCode,
      errorDescription: null,
      rawFault: msg,
      dataRowCount: 0,
      firstRow: null,
      iressMode: deps.env.iressMode,
      elapsedMs: Date.now() - started,
      probedAt: new Date().toISOString(),
    };
  }
}

interface CoverageRow {
  /** Symbol exactly as supplied by the caller (e.g. "MTN.JO"). */
  symbol: string;
  /** Bare IRESS code actually queried (".JO"/".JSE" stripped). */
  iressCode: string;
  /** True when IRESS returned a usable price (outcome ok or closed-with-data). */
  ok: boolean;
  outcome: string;
  last: number | null;
  marketState: string | null;
  currency: string | null;
  error: string | null;
}

interface CoverageResult {
  ok: boolean;
  exchange: string;
  requested: number;
  covered: number;
  rows: CoverageRow[];
  iressMode: string;
  elapsedMs: number;
  probedAt: string;
}

/**
 * Dry-run coverage probe: ask IRESS `PricingQuoteGet` for each supplied
 * symbol and report which ones it can actually price. Used to decide how
 * much of the existing (Yahoo-sourced) retail universe IRESS can replace
 * before any cutover. Strips a trailing `.JO` / `.JSE` to get the bare
 * IRESS code. Reuses the worker's own `fetchLiveQuote` classification so
 * the report matches what the ingest loop would capture. Writes nothing.
 */
async function probeCoverage(
  deps: HttpApiDeps,
  symbols: string[],
  exchange: string,
): Promise<CoverageResult> {
  const started = Date.now();
  const rows: CoverageRow[] = [];
  let session: WorkerMintSession;
  try {
    session = await deps.sessions.getSession();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const code = err instanceof IressError ? err.code : null;
    return {
      ok: false,
      exchange,
      requested: symbols.length,
      covered: 0,
      rows: symbols.map((s) => ({
        symbol: s,
        iressCode: s.replace(/\.(JO|JSE)$/i, ""),
        ok: false,
        outcome: "session_error",
        last: null,
        marketState: null,
        currency: null,
        error: code ? `${code}: ${msg}` : msg,
      })),
      iressMode: deps.env.iressMode,
      elapsedMs: Date.now() - started,
      probedAt: new Date().toISOString(),
    };
  }

  for (const sym of symbols) {
    const iressCode = sym.replace(/\.(JO|JSE)$/i, "");
    try {
      const { row, outcome } = await fetchLiveQuote(session, iressCode, exchange);
      const covered = outcome === "ok" || outcome === "closed-with-data";
      rows.push({
        symbol: sym,
        iressCode,
        ok: covered,
        outcome,
        last: row?.last ?? null,
        marketState: row?.marketState ?? null,
        currency: row?.currency ?? null,
        error: null,
      });
    } catch (err) {
      if (isIressSessionDeadError(err)) deps.sessions.invalidate();
      const msg = err instanceof Error ? err.message : String(err);
      const code = err instanceof IressError ? err.code : null;
      rows.push({
        symbol: sym,
        iressCode,
        ok: false,
        outcome: "error",
        last: null,
        marketState: null,
        currency: null,
        error: code ? `${code}: ${msg}` : msg,
      });
    }
  }

  return {
    ok: true,
    exchange,
    requested: symbols.length,
    covered: rows.filter((r) => r.ok).length,
    rows,
    iressMode: deps.env.iressMode,
    elapsedMs: Date.now() - started,
    probedAt: new Date().toISOString(),
  };
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

interface OrderCancelResult {
  ok: boolean;
  orderId: string;
  account: string;
  cancelledAt: string;
  workerId: string;
  iressMode: string;
  error?: { code: string; message: string };
}

/**
 * Forward an `OrderDelete` to IRESS via the IOS+ service session.
 * Same live-only gate as `fetchLiveOrders`: in mock / non-live modes
 * the route returns 200 with `ok: false` and `error.code: "mock_mode"`.
 * Session-death detection invalidates the cached session so the next
 * call gets a fresh one.
 */
async function cancelLiveOrder(
  deps: HttpApiDeps,
  account: string,
  orderId: string,
): Promise<OrderCancelResult> {
  const baseError = (code: string, message: string): OrderCancelResult => ({
    ok: false,
    orderId,
    account,
    cancelledAt: new Date().toISOString(),
    workerId: deps.env.workerId,
    iressMode: deps.env.iressMode,
    error: { code, message },
  });
  const isLive = deps.env.iressMode === "live" || deps.env.iressMode === "wsdl-stub";
  if (!isLive) {
    return baseError("mock_mode", "Worker is running in mock mode; no live orders available");
  }
  try {
    const session = await deps.sessions.getSession();
    const iosKey = session.serviceKeys.IOSPlus;
    if (!iosKey) {
      return baseError(
        "ios_unavailable",
        "IOSPlus service session not available; order pad not entitled",
      );
    }
    const client = getIressClient("live");
    // OrderDelete signature is the V4 minimum: session key + the
    // broker-assigned order number. The full method shape is defined
    // on the live IressClient (`orderDelete`).
    await client.orderDelete({
      ServiceSessionKey: iosKey,
      OrderNumber: orderId,
    });
    return {
      ok: true,
      orderId,
      account,
      cancelledAt: new Date().toISOString(),
      workerId: deps.env.workerId,
      iressMode: deps.env.iressMode,
    };
  } catch (err) {
    if (isIressSessionDeadError(err) || (err instanceof IressError && err.code === 25001)) {
      deps.sessions.invalidate();
    }
    const message = err instanceof Error ? err.message : String(err);
    const code = err instanceof IressError ? `iress_${err.code}` : "cancel_failed";
    return baseError(code, message);
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

  if (req.method === "GET" && path === "/debug/ips-session") {
    // Read-only snapshot of the cached IRESS service-session state. No
    // SOAP call, no IRESS login — answers "which IOSPlus/IPS/FIXPlus
    // keys are currently in the worker's memory" so the BFF
    // `/api/integration/diagnostics` route can surface it without
    // round-tripping IRESS. The IPS service session is the one the
    // IPSAccountGetAll1 / IPSPositionGetAll1 / IPSTransactionGetByAccount5
    // entitlement ask is centred on; the route name is intentionally
    // broader (`/debug/ips-session`) so the same endpoint reports the
    // IOSPlus / FIXPlus entitlement state too.
    const session = deps.sessions.peekSession();
    const lastError = deps.sessions.peekLastSessionError();
    const serviceKeys: Record<string, string | null> = {};
    const services: string[] = [];
    for (const svc of KNOWN_SERVICE_SESSIONS) {
      const raw = session?.serviceKeys[svc];
      const redacted = redactServiceKey(raw);
      serviceKeys[svc] = redacted;
      if (raw) services.push(svc);
    }
    // The "primary" service key the BFF should highlight — IOSPlus is
    // what OrderPadGetByAccount uses, so it's the one operators usually
    // want to see first. Falls back to the first cached service key,
    // then null.
    const primaryCached = session?.serviceKeys.IOSPlus;
    send(res, 200, {
      ok: true,
      serviceKeyCached: redactServiceKey(primaryCached),
      services,
      serviceKeys,
      applicationId: session?.applicationId ?? null,
      iressMode: deps.env.iressMode,
      lastError,
    });
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

  if (req.method === "POST" && path === "/orders/cancel") {
    let cancelBody: unknown;
    try {
      cancelBody = await readBodyJson(req);
    } catch (err) {
      sendError(res, 400, "bad_request", (err as Error).message);
      return;
    }
    if (!cancelBody || typeof cancelBody !== "object") {
      sendError(res, 400, "bad_request", "Body must be JSON with `orderId` (and optional `account`)");
      return;
    }
    const cb = cancelBody as Record<string, unknown>;
    const orderIdRaw = cb["orderId"];
    const orderId = typeof orderIdRaw === "string" ? orderIdRaw.trim() : "";
    if (!orderId) {
      sendError(res, 400, "bad_request", "`orderId` is required");
      return;
    }
    const accountRaw = cb["account"];
    const account =
      (typeof accountRaw === "string" && accountRaw.trim()) ||
      deps.env.iressAccountCode.split(",")[0]?.trim() ||
      "";
    if (!account) {
      sendError(
        res,
        503,
        "account_not_configured",
        "Order account code not configured (set IRESS_ACCOUNT_CODE on the worker)",
      );
      return;
    }
    const cancelResult = await cancelLiveOrder(deps, account, orderId);
    // Same envelope as /orders: 200 with ok=false when the broker
    // answered "not entitled" / "order not found" / "session dead" —
    // those are real answers, not failures.
    send(res, 200, cancelResult);
    return;
  }

  if (req.method === "POST" && path === "/debug/timeseries-probe") {
    let body: unknown;
    try {
      body = await readBodyJson(req);
    } catch (err) {
      sendError(res, 400, "bad_request", (err as Error).message);
      return;
    }
    if (!body || typeof body !== "object") {
      sendError(res, 400, "bad_request", "Body must be JSON with `code` and `interval`/`frequency`");
      return;
    }
    const b = body as Record<string, unknown>;
    const code = typeof b["code"] === "string" ? b["code"].trim().toUpperCase() : "";
    const exchange = typeof b["exchange"] === "string" ? b["exchange"].trim().toUpperCase() : "JSE";
    const intervalRaw = b["interval"];
    const interval = typeof intervalRaw === "string" ? intervalRaw.trim() : "";
    // Parse the Frequency Long candidate. Accepts a JSON number OR a
    // numeric string (curl/script-friendliness). Negative / non-integer
    // values are coerced to the closest integer.
    const frequencyRaw = b["frequency"];
    let frequency: number | null = null;
    if (typeof frequencyRaw === "number" && Number.isFinite(frequencyRaw)) {
      frequency = Math.trunc(frequencyRaw);
    } else if (typeof frequencyRaw === "string" && frequencyRaw.trim() !== "") {
      const n = Number(frequencyRaw.trim());
      if (Number.isFinite(n)) frequency = Math.trunc(n);
    }
    if (!code) {
      sendError(res, 400, "bad_request", "`code` is required (e.g. \"J203\")");
      return;
    }
    // Precedence: `frequency` wins over `interval` when both are supplied.
    // Either one is sufficient on its own (we don't need both).
    if (frequency === null && !interval) {
      sendError(
        res,
        400,
        "bad_request",
        "Supply one of: `frequency` (Long, e.g. 5) or `interval` (V4 string, e.g. \"Daily\"). `frequency` wins if both are present.",
      );
      return;
    }
    const isLive = deps.env.iressMode === "live" || deps.env.iressMode === "wsdl-stub";
    if (!isLive) {
      sendError(
        res,
        503,
        "iress_mode_not_live",
        `Cannot probe in iressMode=${deps.env.iressMode}; switch the worker to live`,
        { iressMode: deps.env.iressMode },
      );
      return;
    }
    const result = await probeTimeSeriesInterval(
      deps,
      code,
      exchange,
      frequency !== null ? null : interval,
      frequency,
    );
    // Always 200 — the IRESS response (success or fault) IS the answer.
    // `ok` and `errorNumber` describe the result, not the HTTP envelope.
    send(res, 200, result);
    return;
  }

  if (req.method === "POST" && path === "/debug/coverage") {
    let body: unknown;
    try {
      body = await readBodyJson(req);
    } catch (err) {
      sendError(res, 400, "bad_request", (err as Error).message);
      return;
    }
    if (!body || typeof body !== "object") {
      sendError(res, 400, "bad_request", "Body must be JSON with `symbols` (string[]) and optional `exchange`");
      return;
    }
    const b = body as Record<string, unknown>;
    const rawSymbols = b["symbols"];
    if (!Array.isArray(rawSymbols) || rawSymbols.length === 0) {
      sendError(res, 400, "bad_request", "`symbols` must be a non-empty array of strings");
      return;
    }
    const symbols = rawSymbols.map((s) => String(s).trim()).filter(Boolean);
    if (symbols.length > 80) {
      sendError(res, 400, "too_many", "Send at most 80 symbols per request (batch the rest) to avoid SOAP timeout", {
        max: 80,
        got: symbols.length,
      });
      return;
    }
    const exchange = typeof b["exchange"] === "string" ? b["exchange"].trim().toUpperCase() : "JSE";
    const isLive = deps.env.iressMode === "live" || deps.env.iressMode === "wsdl-stub";
    if (!isLive) {
      sendError(res, 503, "iress_mode_not_live", `Cannot probe coverage in iressMode=${deps.env.iressMode}; switch the worker to live`, {
        iressMode: deps.env.iressMode,
      });
      return;
    }
    const result = await probeCoverage(deps, symbols, exchange);
    send(res, 200, result);
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
