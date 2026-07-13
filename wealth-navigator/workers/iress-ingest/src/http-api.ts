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

import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { randomUUID } from "node:crypto";
import { getIressCredentialsFromEnv, getIressProdCredentialsFromEnv } from "../../../src/lib/iress/config";
import { IressError, isIressSessionDeadError } from "../../../src/lib/iress/errors";
import { createLiveIressClient, getIressClient } from "../../../src/lib/iress/index";
import { createSoapTransport, makeHeader } from "../../../src/lib/iress/transport";
import type { IressService, Order, OrderState } from "../../../src/types/iress";
import { loadWorkerEnv } from "./env";
import type { WorkerEnv } from "./env";
import { type UatExecutionDelta, getLastUatPollAt, uatExecutionHub } from "./order-poller";
import {
  getMarketDataSession,
  invalidateMarketDataSession,
  marketDataBaseUrl,
  marketDataProdEnabled,
} from "./market-data";
import { fetchLiveQuote } from "./quotes";
import type { WorkerMintSession, WorkerSessionManager } from "./session";
import { type WorkerSupabase, writeHeartbeat } from "./supabase";

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
  build: string;
}

interface NewsProbeRow {
  storyId: string;
  headline: string;
  source: string;
  timestamp: string;
  ts: number;
  category: string | null;
  relatedCodes: string[] | null;
  storyPreview: string | null;
  /** First 200 chars of the story body — to confirm headline-only vs full body without dumping the entire row. */
}

interface NewsProbeResult {
  ok: boolean;
  vendor: string;
  pageSize: number;
  timeout: number;
  errorNumber: number | null;
  errorDescription: string | null;
  rawFault: string | null;
  dataRowCount: number;
  firstRow: Record<string, unknown> | null;
  /** First N headlines (truncated body previews) for log-friendly inspection. */
  headlines: NewsProbeRow[];
  iressMode: string;
  elapsedMs: number;
  probedAt: string;
  build: string;
}

/**
 * Per-process rate limiter for `*VendorGet` / `*Probe` debug endpoints.
 *
 * The CT license seat is a single, contended resource — the standing user
 * rule is "1-hour rate-limit; batch probes carefully and never hammer the
 * CT seat". We enforce a minimum gap between consecutive probes (default
 * `NEWS_PROBE_MIN_GAP_MS` = 10 s) so a misconfigured client or a CI loop
 * can't burn the seat by accident. Bumped via env when operators need a
 * tighter / looser gap.
 */
const NEWS_PROBE_MIN_GAP_MS = Number(process.env.NEWS_PROBE_MIN_GAP_MS ?? "10000");
let lastNewsProbeAt = 0;

function newsProbeThrottleOrError(): { throttled: false } | { throttled: true; retryAfterMs: number } {
  const now = Date.now();
  const since = now - lastNewsProbeAt;
  if (since < NEWS_PROBE_MIN_GAP_MS) {
    return { throttled: true, retryAfterMs: NEWS_PROBE_MIN_GAP_MS - since };
  }
  lastNewsProbeAt = now;
  return { throttled: false };
}

// Bump on every deploy that touches the TimeSeriesGet2 wire shape so a probe
// response confirms WHICH code is live (Railway deploy timing was opaque).
const PROBE_BUILD = "ts-2026-06-16-news";

/**
 * One-shot `TimeSeriesGet2` probe with the caller-supplied period
 * selector.
 *
 * Per the V4 spec + IRESS confirmation (Andre, 2026-06-15), TimeSeriesGet2
 * runs on the base IRIS session and takes `<Interval>` (string: "Daily",
 * "Weekly", …) with `<DateFrom>`/`<DateTo>` — NOT `<Frequency>` (Long), which
 * the live CT server rejects ("Invalid Parameter Value: <n> as Frequency").
 * The probe still accepts either form so a candidate can be checked against
 * the live server without redeploying.
 *
 * Caller body shape (POST /debug/timeseries-probe):
 *   { code: "J203", exchange?: "JSE", interval?: "Daily", frequency?: 5 }
 *
 * Precedence: when both `interval` and `frequency` are supplied, the client
 * sends `Interval` (the documented live shape). When neither is supplied we
 * return 400.
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
  dateFrom?: string,
  dateTo?: string,
  noDates?: boolean,
  numberOfPoints?: number,
  date?: string,
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
      // Caller-overridable so date FORMAT can be probed live; `noDates` omits
      // the range entirely (to test the NumberOfPoints path).
      From: noDates
        ? undefined
        : (dateFrom ?? new Date(Date.now() - 14 * 86400_000).toISOString().slice(0, 10)),
      To: noDates ? undefined : (dateTo ?? new Date().toISOString().slice(0, 10)),
      ...(typeof date === "string" && date.trim() !== "" ? { Date: date.trim() } : {}),
      ...(typeof numberOfPoints === "number" ? { NumberOfPoints: numberOfPoints } : {}),
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
      build: PROBE_BUILD,
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
      build: PROBE_BUILD,
    };
  }
}

/**
 * One-shot `NewsVendorGet` probe — Charles Ntjana confirmed 2026-06-25
 * that this is the V4 verb for Market Data / News. Runs on the base
 * IRIS session (no IOS+/IPS/FIX+ service session required).
 *
 * Wire shape mirrors `probeTimeSeriesInterval`:
 *   - caller supplies `vendor` (default `IRESS` — broker-sourced
 *     general market news; override with `SENS`, `Reuters`, `Bloomberg`,
 *     `Moneyweb`, `Dow Jones`, `Business Day`)
 *   - `pageSize` capped at 1000 (the CT max per Charles' example)
 *   - `timeout` capped at 25 (the CT ceiling for this method)
 *   - per-process throttle (10s default — see `newsProbeThrottleOrError`)
 *     so a runaway loop can't burn the CT license seat.
 *
 * The probe is read-only — it does NOT persist to Supabase (T5 vendor
 * content is passthrough-only). It DOES count as one live call against
 * the CT rate-limit budget; that's why the throttle exists.
 */
async function probeNewsVendor(
  deps: HttpApiDeps,
  vendor: string,
  pageSize: number,
  timeout: number,
  includeBody: boolean,
): Promise<NewsProbeResult> {
  const started = Date.now();
  try {
    const session = await deps.sessions.getSession();
    // News is market data: use the PROD market-data session when the split is
    // on, else the UAT session.
    const md = await getMarketDataSession();
    if (!md && marketDataProdEnabled()) {
      // Split on but prod momentarily down: skip UAT (no market-data IDS there).
      return {
        ok: false,
        vendor,
        pageSize,
        timeout,
        errorNumber: null,
        errorDescription: "Prod market-data session unavailable; news skipped (UAT has no market-data IDS).",
        rawFault: null,
        dataRowCount: 0,
        firstRow: null,
        headlines: [],
        iressMode: deps.env.iressMode,
        elapsedMs: Date.now() - started,
        probedAt: new Date().toISOString(),
        build: PROBE_BUILD,
      };
    }
    const client = md ? md.client : getIressClient("live");
    const res = await client.newsVendorGet({
      Header: {
        SessionKey: md ? md.sessionKey : session.iressSessionKey,
        RequestID: newRequestID(`news-${vendor}`),
        WaitForResponse: true,
        Updates: false,
        PagingBookmark: "",
        PagingDirection: 0,
        PageSize: pageSize,
        Timeout: timeout,
      },
      Vendor: vendor,
    });
    const headlines: NewsProbeRow[] = res.DataRows.slice(0, 10).map((s) => ({
      storyId: s.StoryId,
      headline: s.Headline,
      source: s.Source,
      timestamp: s.Timestamp,
      ts: s.ts,
      category: s.Category ?? null,
      relatedCodes: s.RelatedCodes ?? null,
      storyPreview: includeBody && s.Story ? s.Story.slice(0, 200) : null,
    }));
    return {
      ok: res.Header.ErrorNumber === 0,
      vendor,
      pageSize,
      timeout,
      errorNumber: res.Header.ErrorNumber ?? null,
      errorDescription: res.Header.ErrorDescription ?? null,
      rawFault: null,
      dataRowCount: res.DataRows?.length ?? 0,
      firstRow: (res.DataRows?.[0] as unknown as Record<string, unknown> | undefined) ?? null,
      headlines,
      iressMode: deps.env.iressMode,
      elapsedMs: Date.now() - started,
      probedAt: new Date().toISOString(),
      build: PROBE_BUILD,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const faultCode = err instanceof IressError ? err.code : null;
    return {
      ok: false,
      vendor,
      pageSize,
      timeout,
      errorNumber: faultCode,
      errorDescription: null,
      rawFault: msg,
      dataRowCount: 0,
      firstRow: null,
      headlines: [],
      iressMode: deps.env.iressMode,
      elapsedMs: Date.now() - started,
      probedAt: new Date().toISOString(),
      build: PROBE_BUILD,
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

interface IressMethodStatus {
  method: string;
  service: "Iress" | "IOS+" | "IPS" | "FIX+";
  status: "ok" | "fault" | "blocked" | "not-implemented";
  detail: string;
}

/**
 * Read-only IRESS method matrix — calls each entitled method once (never a
 * mutating order method) and records the exact outcome, so we can tell the
 * provider with certainty which methods work vs are blocked. Service-gated
 * methods (orders/IPS/FIX+) are reported `blocked` whenever their service
 * session is absent (the root cause), since that is what actually stops them.
 */
async function probeIressMethods(deps: HttpApiDeps): Promise<{
  ok: boolean;
  iressMode: string;
  probedAt: string;
  session: { iressSessionKey: boolean; services: string[]; lastError: unknown };
  methods: IressMethodStatus[];
}> {
  const methods: IressMethodStatus[] = [];
  let session: WorkerMintSession | null = null;
  try {
    session = await deps.sessions.getSession();
  } catch (err) {
    methods.push({
      method: "IRESSSessionStart",
      service: "Iress",
      status: "fault",
      detail: err instanceof Error ? err.message : String(err),
    });
  }
  const svc = (session?.serviceKeys ?? {}) as Record<string, string | undefined>;
  const hasIOS = Boolean(svc.IOSPlus);
  const hasIPS = Boolean(svc.IPS);
  const hasFIX = Boolean(svc.FIXPlus);
  const client = getIressClient("live");

  if (session?.iressSessionKey) {
    methods.push({
      method: "IRESSSessionStart",
      service: "Iress",
      status: "ok",
      detail: "Iress session established",
    });
  }
  methods.push({
    method: "ServiceSessionStart(IOSPlus)",
    service: "IOS+",
    status: hasIOS ? "ok" : "fault",
    detail: hasIOS
      ? "session key present"
      : "no IOS+ session — ServiceSessionStart failed (HTTP 500 / not entitled / wrong Server name)",
  });
  methods.push({
    method: "ServiceSessionStart(IPS)",
    service: "IPS",
    status: hasIPS ? "ok" : "fault",
    detail: hasIPS
      ? "session key present"
      : "no IPS session — ServiceSessionStart failed (HTTP 500 / not entitled / wrong Server name)",
  });
  methods.push({
    method: "ServiceSessionStart(FIXPlus)",
    service: "FIX+",
    status: hasFIX ? "ok" : "fault",
    detail: hasFIX
      ? "session key present"
      : "no FIX+ session — ServiceSessionStart failed (HTTP 500 / not entitled / wrong Server name)",
  });

  if (session) {
    // Iress-Pro methods need only the Iress session key.
    try {
      const q = await fetchLiveQuote(session, "NPN", "JSE");
      const ok = q.outcome === "ok" || q.outcome === "closed-with-data";
      methods.push({
        method: "PricingQuoteGet",
        service: "Iress",
        status: ok ? "ok" : "fault",
        detail: `NPN outcome=${q.outcome} last=${q.row?.last ?? "—"} state=${q.row?.marketState ?? "—"}`,
      });
    } catch (err) {
      methods.push({
        method: "PricingQuoteGet",
        service: "Iress",
        status: "fault",
        detail: err instanceof Error ? err.message : String(err),
      });
    }

    const exGet = (client as unknown as { pricingQuoteExGet?: unknown }).pricingQuoteExGet;
    if (typeof exGet === "function") {
      try {
        const r = (await (exGet as (req: unknown) => Promise<unknown>).call(client, {
          Header: { SessionKey: session.iressSessionKey, RequestID: newRequestID("ex-NPN"), Timeout: 20 },
          SecurityCode: "NPN",
          Exchange: "JSE",
        })) as { DataRows?: unknown[] };
        const n = r.DataRows?.length ?? 0;
        methods.push({
          method: "PricingQuoteExGet (L2)",
          service: "Iress",
          status: n > 0 ? "ok" : "fault",
          detail: `returned ${n} rows`,
        });
      } catch (err) {
        const code = err instanceof IressError ? err.code : null;
        methods.push({
          method: "PricingQuoteExGet (L2)",
          service: "Iress",
          status: "fault",
          detail: code
            ? `${code}: ${err instanceof Error ? err.message : ""}`
            : err instanceof Error
              ? err.message
              : String(err),
        });
      }
    } else {
      methods.push({
        method: "PricingQuoteExGet (L2)",
        service: "Iress",
        status: "not-implemented",
        detail: "L2 depth not wired in the client — confirm with IRESS whether L2 is exposed in V4",
      });
    }

    const ts = await probeTimeSeriesInterval(deps, "J203", "JSE", "Daily", null);
    methods.push({
      method: "TimeSeriesGet2",
      service: "Iress",
      status: ts.ok ? "ok" : "fault",
      detail: ts.rawFault ?? ts.errorDescription ?? `errorNumber=${ts.errorNumber}`,
    });
  }

  // Service-gated methods: blocked while their service session is unavailable.
  const gated = (method: string, service: "IOS+" | "IPS" | "FIX+", has: boolean): void => {
    methods.push({
      method,
      service,
      status: has ? "ok" : "blocked",
      detail: has
        ? `${service} session present — callable`
        : `blocked: requires ${service} service session (currently unavailable)`,
    });
  };
  gated("OrderPadGetByAccount", "IOS+", hasIOS);
  gated("OrderCreate3 / OrderAmend2 / OrderDelete", "IOS+", hasIOS);
  gated("BookingGetByOrganisation2", "IOS+", hasIOS);
  gated("IPSAccountGetAll1", "IPS", hasIPS);
  gated("IPSPositionGetAll1", "IPS", hasIPS);
  gated("IPSTransactionGetByAccount5", "IPS", hasIPS);
  gated("TargetIDGet / TargetIDStatusGet", "FIX+", hasFIX);

  return {
    ok: true,
    iressMode: deps.env.iressMode,
    probedAt: new Date().toISOString(),
    session: {
      iressSessionKey: Boolean(session?.iressSessionKey),
      services: Object.keys(svc).filter((k) => svc[k]),
      lastError: deps.sessions.peekLastSessionError(),
    },
    methods,
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
      return baseError("ios_unavailable", "IOSPlus service session not available; order pad not entitled");
    }
    const client = getIressClient("live");
    // OrderDelete signature is the V4 minimum: session key + the
    // broker-assigned order number. The full method shape is defined
    // on the live IressClient (`orderDelete`).
    await client.orderDelete({
      ServiceSessionKey: iosKey,
      OrderNumber: orderId,
    });
    const cancelledAt = new Date().toISOString();
    // Reflect the cancel in the audit trail so the UI stops showing WORKING.
    // Match both representations: the poller's source=IRESS mirror row
    // (order_id = the IRESS number) and the BFF/ticket row
    // (payload.iress_order_number). This is best-effort; the OrderDelete
    // already succeeded.
    //
    // 2026-07-13 (Andre + Juan): Andre clicked cancel on Hermes and Juan
    // sat watching the UI for "30 seconds waiting for it to tick". The
    // original code assumed the poller would catch the transition on its
    // next cycle. The poller is now filter=3 (ALL) so it CAN see INACTIVE
    // rows, but cancelling through Hermes means there's no local row
    // change to surface until then — bad UX. So we publish an SSE delta
    // here immediately AND stamp the audit row, so the UI updates
    // within the same round-trip as the broker cancel.
    let cancelledAuditId: string | null = null;
    let cancelledFilled: number | null = null;
    let cancelledAvgFillCents: number | null = null;
    if (deps.supabase) {
      try {
        // Read the existing audit row(s) so the SSE delta carries the
        // pre-cancel filled / avg fill values (the row had fills that
        // should be preserved). Match both representations.
        const { data: existing } = await deps.supabase
          .from("oems_order_audit")
          .select("id, payload")
          .or(`order_id.eq.${orderId},payload->>iress_order_number.eq.${orderId}`)
          .limit(1);
        if (existing && existing.length > 0) {
          const ex = existing[0] as { id: string; payload: Record<string, unknown> | null };
          cancelledAuditId = ex.id;
          const p = ex.payload ?? {};
          if (typeof p.filled === "number") cancelledFilled = p.filled;
          if (typeof p.avgPx === "number") cancelledAvgFillCents = Math.round(p.avgPx * 100);
        }
        await deps.supabase
          .from("oems_order_audit")
          // 2026-07-13 — Transcript gap #2 (26:21): Andre flagged
          // "last action" as a key field. Stamp a one-liner on every
          // cancel so the UI's new Action column updates without
          // needing a poll cycle.
          .update({
            status: "cancelled",
            payload: {
              lastAction: "Cancelled by trader (OrderDelete)",
              lastActionAt: cancelledAt,
            },
          })
          .eq("order_id", orderId);
        await deps.supabase
          .from("oems_order_audit")
          .update({
            status: "cancelled",
            payload: {
              lastAction: "Cancelled by trader (OrderDelete)",
              lastActionAt: cancelledAt,
            },
          })
          .eq("payload->>iress_order_number", orderId);
      } catch {
        /* audit stamp is best-effort; the broker cancel already succeeded */
      }

      // Publish the SSE delta so subscribed UIs flip to "CANCELLED"
      // immediately — without waiting for the next 30s poll. The hub
      // suppresses no-op deltas (state didn't change), but "cancelled"
      // is always a state change relative to anything pre-cancel.
      try {
        uatExecutionHub.publish({
          iressOrderNumber: orderId,
          orderAuditId: cancelledAuditId,
          state: "cancelled",
          filled: cancelledFilled ?? 0,
          avgFillPrice: cancelledAvgFillCents != null ? cancelledAvgFillCents / 100 : null,
          lastFillTimestamp: cancelledAt,
          // 2026-07-13 — Transcript gap #2 (26:21): explicitly carry the
          // last-action text so the UI's new Action column updates
          // without needing a poll cycle.
          lastAction: "Cancelled by trader (OrderDelete)",
          lastActionAt: cancelledAt,
          raw: {
            id: orderId,
            account,
            strategy: "",
            side: "BUY",
            symbol: "",
            isin: "",
            type: "LMT",
            tif: "DAY",
            destination: "JSE",
            qty: 0,
            filled: cancelledFilled ?? 0,
            limit: null,
            stop: null,
            avgPx: cancelledAvgFillCents != null ? cancelledAvgFillCents / 100 : null,
            vwap: null,
            trader: "",
            ts: Date.parse(cancelledAt) || Date.now(),
            state: "CANCELLED" as OrderState,
            orderTag: "",
            slippageBps: null,
            arrivalMid: 0,
            brokerState: "INACTIVE",
            actionStatus: "Cancelled",
            internalOrderStatus: "Cancelled",
            stateDescription: "Cancelled by trader",
            remainingVolume: 0,
            remainingValueCents: 0,
            orderValueCents: null,
          },
          bookId: null,
          observedAt: cancelledAt,
        });
      } catch (hubErr) {
        // Hub publish failures are best-effort; the cancel succeeded at
        // the broker and the audit row is stamped.
        console.warn(`[iress-ingest] cancel hub publish failed: ${String(hubErr)}`);
      }
    }
    return {
      ok: true,
      orderId,
      account,
      cancelledAt,
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

  if (req.method === "GET" && path === "/debug/order-state-probe") {
    // Operator-only diagnostic for "where exactly is this stuck on Hermes?".
    //
    // Accepts ?account=56378&orderNumber=12345 — pulls the live OrderPad row,
    // surfaces the raw IRESS Hermes fields (OrderState, ActionStatus,
    // InternalOrderStatus, StateDescription, DoneVolumeTotal vs OrderVolume,
    // RemainingVolume, RemainingValue, OrderValue) AND the worker's mapped
    // lifecycle state. Used by the BFF passthrough (`/api/admin/...`) and by
    // curl from a desk operator when an order is sitting on the wrong state.
    //
    // Added 2026-07-13 after Andre demonstrated that a fully-filled CARE
    // order collapsed to "Working" in the OEMS while Hermes showed it
    // inactive + done. The BFF now has enough state to render correctly,
    // but the operator still needs a way to ask "what does IRESS say right
    // now?" without tailing worker logs.
    const account = url.searchParams.get("account")?.trim();
    const orderNumber = url.searchParams.get("orderNumber")?.trim();
    if (!account || !orderNumber) {
      sendError(
        res,
        400,
        "bad_request",
        "account and orderNumber query params required (?account=56378&orderNumber=12345)",
      );
      return;
    }
    // Use filter=1 (ALL — Hermes UI default) so cancelled / filled / expired
    // rows are also returned, not just currently working ones.
    const fetched = await fetchLiveOrders(deps, account, 1);
    if (!fetched.ok) {
      send(res, 200, {
        ok: false,
        account,
        orderNumber,
        iressMode: deps.env.iressMode,
        fetchedAt: fetched.fetchedAt,
        error: fetched.error ?? {
          code: "fetch_failed",
          message: "fetchLiveOrders returned ok:false",
        },
      });
      return;
    }
    // fetched.orders is `Order[]` from the route contract, but at the wire layer
    // each row is actually the raw IRESS OrderPad record (the mapper in
    // live.ts converts it before the rest of the pipeline sees it). Cast to
    // Record<string, unknown> via unknown so we can read the Hermes-side
    // fields directly without colliding with the typed `Order` shape.
    const rawRows = fetched.orders as unknown as Record<string, unknown>[];
    const match = rawRows.find((row) => String(row["OrderNumber"] ?? "") === orderNumber);
    if (!match) {
      send(res, 200, {
        ok: true,
        found: false,
        account,
        orderNumber,
        orderPadRows: fetched.orders.length,
        iressMode: deps.env.iressMode,
        fetchedAt: fetched.fetchedAt,
        hint:
          fetched.orders.length === 0
            ? "OrderPad returned no rows — check that the account has open orders on the IRESS Hermes OrderPad"
            : `OrderPad returned ${fetched.orders.length} row(s) but none match OrderNumber=${orderNumber}. The order may have purged, or it sits on a different account.`,
      });
      return;
    }
    // Surface the raw IRESS row + every Hermes-side lifecycle field the
    // OEMS now reasons about. We deliberately do NOT run the worker mapper
    // here — the operator needs to see Hermes's view, not ours — but we do
    // echo the values the new mapper reads (brokerState, actionStatus,
    // internalOrderStatus, stateDescription) so the discrepancy (if any)
    // between raw IRESS and what the worker stamped is visible at a glance.
    const safe = (k: string) => String(match[k] ?? "");
    const ordVol = Number(match["OrderVolume"] ?? 0);
    const done = Number(match["DoneVolumeTotal"] ?? 0);
    send(res, 200, {
      ok: true,
      found: true,
      account,
      orderNumber,
      iressMode: deps.env.iressMode,
      fetchedAt: fetched.fetchedAt,
      raw: match,
      lifecycleFields: {
        orderState: safe("OrderState"),
        actionStatus: safe("ActionStatus"),
        internalOrderStatus: safe("InternalOrderStatus"),
        stateDescription: safe("StateDescription"),
        lifetime: safe("Lifetime"),
        pricingInstructions: safe("PricingInstructions"),
      },
      fillMath: {
        orderVolume: ordVol,
        doneVolumeTotal: done,
        remainingVolume: Number(match["RemainingVolume"] ?? Math.max(ordVol - done, 0)),
        remainingValue: Number(match["RemainingValue"] ?? 0),
        orderValue: Number(match["OrderValue"] ?? 0),
        averagePrice: Number(match["AveragePrice"] ?? 0),
        fillPct: ordVol > 0 ? Math.min(100, (done / ordVol) * 100) : 0,
      },
      timestamps: {
        createDateTime: safe("CreateDateTime"),
        updateDateTime: safe("UpdateDateTime"),
      },
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
    const account =
      url.searchParams.get("account")?.trim() || deps.env.iressAccountCode.split(",")[0]?.trim() || "";
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
    const filter: OrderFilter = (
      VALID_FILTERS.has(filterParam as OrderFilter) ? filterParam : 1
    ) as OrderFilter;
    const result = await fetchLiveOrders(deps, account, filter);
    // 200 with ok=false when the worker has an answer but it's "no
    // orders" / "mock mode" / "session not ready" — those are real
    // answers the UI should display, not failures.
    send(res, 200, result);
    return;
  }

  if (req.method === "GET" && path === "/history") {
    // Daily price history for the Security page chart ranges (5D … All) via
    // IRESS TimeSeriesGet2. 1D stays on the intraday tick path; this serves the
    // longer windows. Read-only.
    const isLive = deps.env.iressMode === "live" || deps.env.iressMode === "wsdl-stub";
    if (!isLive) {
      sendError(res, 503, "iress_mode_not_live", `Cannot fetch history in iressMode=${deps.env.iressMode}`);
      return;
    }
    const sym = (url.searchParams.get("sym") ?? "")
      .trim()
      .toUpperCase()
      .replace(/\.(JO|JSE)$/i, "");
    if (!sym) {
      sendError(res, 400, "bad_request", "sym query param required (e.g. ?sym=NPN)");
      return;
    }
    const days = Math.min(3700, Math.max(5, Number(url.searchParams.get("days") ?? "365")));
    const exchange = (url.searchParams.get("exchange") ?? "JSE").trim() || "JSE";
    const dataSource =
      (url.searchParams.get("ds") ?? process.env.IRESS_TS_DATASOURCE ?? "zax").trim() || "zax";
    // Frequency: caller-overridable via ?frequency=Daily|IntraDay|Tick|...
    // Default is Daily for the /history route. The per-symbol intraday path
    // (/intraday below) tries Tick / IntraDay / 1-Minute in order.
    const frequency = (url.searchParams.get("frequency") ?? "Daily").trim() || "Daily";
    const from = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
    const to = new Date().toISOString().slice(0, 10);
    const started = Date.now();
    try {
      const session = await deps.sessions.getSession();
      const client = getIressClient("live");
      const res2 = await client.timeSeriesGet2({
        Header: { SessionKey: session.iressSessionKey, RequestID: newRequestID(`hist-${sym}`), Timeout: 30 },
        Code: sym,
        Exchange: exchange,
        DataSource: dataSource,
        From: from,
        To: to,
        Interval: frequency,
      });
      send(res, 200, {
        ok: res2.Header.ErrorNumber === 0,
        sym,
        exchange,
        dataSource,
        frequency,
        points: res2.DataRows, // [{ t: ms, v: close }]
        count: res2.DataRows.length,
        elapsedMs: Date.now() - started,
      });
    } catch (err) {
      if (isIressSessionDeadError(err)) deps.sessions.invalidate();
      send(res, 200, { ok: false, sym, points: [], error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }

  if (req.method === "GET" && path === "/intraday") {
    // Intraday-tick time series via IRESS TimeSeriesGet2. Andre's 2026-07-09
    // unblock email proved the entitlement is live for `DataSource=zax,
    // Exchange=jse, Frequency=Monthly`; per-symbol intraday (Tick / 1-Minute)
    // is NOT yet proven — see wealth-navigator/docs/TIMESERIES_UNBLOCK_PLAN.md.
    //
    // This endpoint tries the candidate intraday frequencies in order and
    // returns the first one that returns data. If all candidates fault
    // (25010/25034 entitlement missing, or "Invalid Parameter Value"), the
    // response is `ok=false` with the last fault in `error` so the BFF
    // can fall back to the Supabase `stock_intraday_c` path.
    //
    // Candidate list — Andre's email is silent on the exact V4 string for
    // intraday, so we try the documented enum values in the order most
    // likely to be accepted: `IntraDay` (the V4 WSDL canonical), then
    // `1-Minute` (the more common IRESS alias), then `Tick` (the JSE
    // sub-second feed). Operator can pin the right one via the probe.
    const isLive = deps.env.iressMode === "live" || deps.env.iressMode === "wsdl-stub";
    if (!isLive) {
      sendError(res, 503, "iress_mode_not_live", `Cannot fetch intraday in iressMode=${deps.env.iressMode}`);
      return;
    }
    const sym = (url.searchParams.get("sym") ?? "")
      .trim()
      .toUpperCase()
      .replace(/\.(JO|JSE)$/i, "");
    if (!sym) {
      sendError(res, 400, "bad_request", "sym query param required (e.g. ?sym=NPN)");
      return;
    }
    const days = Math.min(30, Math.max(1, Number(url.searchParams.get("days") ?? "5")));
    const exchange = (url.searchParams.get("exchange") ?? "JSE").trim() || "JSE";
    // Per-call DataSource override for non-JSE bond/curve paths. Default
    // to the new SA-equity default (`zax`) so a JSE symbol with no override
    // works against Andre's unblock.
    const dataSource = (url.searchParams.get("ds") ?? "zax").trim() || "zax";
    // Candidate frequencies — caller can pin one via ?frequency=… for the
    // probe; otherwise we walk the list.
    const requestedFrequency = (url.searchParams.get("frequency") ?? "").trim();
    const candidates = requestedFrequency ? [requestedFrequency] : ["IntraDay", "1-Minute", "Tick"];
    const from = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
    const to = new Date().toISOString().slice(0, 10);
    const started = Date.now();
    let lastError: string | null = null;
    let lastFault: {
      frequency: string;
      errorNumber: number | null;
      errorDescription: string | null;
      rawFault: string | null;
    } | null = null;
    try {
      const session = await deps.sessions.getSession();
      const client = getIressClient("live");
      for (const frequency of candidates) {
        try {
          const r = await client.timeSeriesGet2({
            Header: {
              SessionKey: session.iressSessionKey,
              RequestID: newRequestID(`intra-${sym}-${frequency}`),
              Timeout: 30,
            },
            Code: sym,
            Exchange: exchange,
            DataSource: dataSource,
            From: from,
            To: to,
            Interval: frequency,
          });
          if (r.Header.ErrorNumber === 0 && r.DataRows.length > 0) {
            send(res, 200, {
              ok: true,
              sym,
              exchange,
              dataSource,
              frequency,
              points: r.DataRows, // [{ t: ms, v: close }]
              count: r.DataRows.length,
              attemptedFrequencies: candidates,
              elapsedMs: Date.now() - started,
            });
            return;
          }
          // Empty / faulted — record and try the next candidate.
          lastFault = {
            frequency,
            errorNumber: r.Header.ErrorNumber ?? null,
            errorDescription: r.Header.ErrorDescription ?? null,
            rawFault: null,
          };
          lastError = r.Header.ErrorDescription ?? `TimeSeriesGet2(${frequency}) returned 0 points`;
        } catch (candErr) {
          // 25010 / 25034 entitlement faults (and any other IressError) get
          // captured here; we keep walking the candidate list. Other errors
          // (session death, transport) bubble out.
          if (candErr instanceof IressError && (candErr.code === 25010 || candErr.code === 25034)) {
            lastFault = {
              frequency,
              errorNumber: candErr.code,
              errorDescription: candErr.message,
              rawFault: candErr.message,
            };
            lastError = `${frequency}: ${candErr.code} ${candErr.message}`;
            continue;
          }
          if (isIressSessionDeadError(candErr)) deps.sessions.invalidate();
          throw candErr;
        }
      }
      // All candidates exhausted — surface the last fault as the failure.
      send(res, 200, {
        ok: false,
        sym,
        exchange,
        dataSource,
        attemptedFrequencies: candidates,
        lastFault,
        points: [],
        count: 0,
        error: lastError,
        elapsedMs: Date.now() - started,
      });
    } catch (err) {
      if (isIressSessionDeadError(err)) deps.sessions.invalidate();
      send(res, 200, {
        ok: false,
        sym,
        points: [],
        attemptedFrequencies: candidates,
        error: err instanceof Error ? err.message : String(err),
      });
    }
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
      sendError(res, 400, "bad_request", '`code` is required (e.g. "J203")');
      return;
    }
    // Precedence: `frequency` wins over `interval` when both are supplied.
    // Either one is sufficient on its own (we don't need both).
    if (frequency === null && !interval) {
      sendError(
        res,
        400,
        "bad_request",
        'Supply one of: `frequency` (Long, e.g. 5) or `interval` (V4 string, e.g. "Daily"). `frequency` wins if both are present.',
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
    const dateFrom =
      typeof b["dateFrom"] === "string" && b["dateFrom"].trim() !== "" ? b["dateFrom"].trim() : undefined;
    const dateTo =
      typeof b["dateTo"] === "string" && b["dateTo"].trim() !== "" ? b["dateTo"].trim() : undefined;
    const noDates = b["noDates"] === true;
    const numberOfPoints =
      typeof b["numberOfPoints"] === "number" && Number.isFinite(b["numberOfPoints"])
        ? Math.trunc(b["numberOfPoints"] as number)
        : undefined;
    const date = typeof b["date"] === "string" && b["date"].trim() !== "" ? b["date"].trim() : undefined;
    const result = await probeTimeSeriesInterval(
      deps,
      code,
      exchange,
      frequency !== null ? null : interval,
      frequency,
      dateFrom,
      dateTo,
      noDates,
      numberOfPoints,
      date,
    );
    // Always 200 — the IRESS response (success or fault) IS the answer.
    // `ok` and `errorNumber` describe the result, not the HTTP envelope.
    send(res, 200, result);
    return;
  }

  /**
   * `GET /debug/news-vendor-probe` — one-shot `NewsVendorGet` verifier.
   *
   * Mirrors `/debug/timeseries-probe`'s shape but uses GET + query string
   * (the only call site is the BFF passthrough / a curl from the operator,
   * so the URL-as-config ergonomics of GET win over the POST body for a
   * probe).
   *
   * Query params (all optional):
   *   - `vendor`       default "IRESS" (broker-sourced general market news;
   *                    override with `SENS`, `Reuters`, `Bloomberg`,
   *                    `Moneyweb`, `Dow Jones`, `Business Day`)
   *   - `pageSize`     default 50, capped at 1000 (CT max)
   *   - `timeout`      default 25, capped at 25 (CT ceiling)
   *   - `includeBody`  "1" to include a 200-char preview of each story body
   *                    (default off — the body may be large; keep responses
   *                    bounded)
   *
   * Rate-limit: the per-process `newsProbeThrottleOrError()` enforces a
   * minimum 10s gap between probes (env-overridable via
   * `NEWS_PROBE_MIN_GAP_MS`). This protects the single CT license seat.
   *
   * The probe is read-only — it does NOT persist to Supabase. T5 news is
   * passthrough-only and the standing policy is "seed until contracted".
   */
  if (req.method === "GET" && path === "/debug/news-vendor-probe") {
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
    const throttle = newsProbeThrottleOrError();
    if (throttle.throttled) {
      sendError(
        res,
        429,
        "rate_limited",
        `News probe throttled — wait ${throttle.retryAfterMs}ms before retrying (NEWS_PROBE_MIN_GAP_MS=${NEWS_PROBE_MIN_GAP_MS})`,
        { retryAfterMs: throttle.retryAfterMs, minGapMs: NEWS_PROBE_MIN_GAP_MS },
      );
      return;
    }
    const vendorRaw = url.searchParams.get("vendor") ?? "SENS";
    const vendor = vendorRaw.trim();
    if (!vendor) {
      sendError(res, 400, "bad_request", "`vendor` query param required (e.g. ?vendor=IRESS)");
      return;
    }
    const pageSizeRaw = Number(url.searchParams.get("pageSize") ?? "50");
    const pageSize = Number.isFinite(pageSizeRaw) ? Math.min(1000, Math.max(1, Math.trunc(pageSizeRaw))) : 50;
    const timeoutRaw = Number(url.searchParams.get("timeout") ?? "25");
    const timeout = Number.isFinite(timeoutRaw) ? Math.min(25, Math.max(1, Math.trunc(timeoutRaw))) : 25;
    const includeBody = url.searchParams.get("includeBody") === "1";
    const result = await probeNewsVendor(deps, vendor, pageSize, timeout, includeBody);
    send(res, 200, result);
    return;
  }

  // Raw SOAP prober — send EXACT wire parameters for any method, using the
  // worker's current live session key. Bypasses the typed client's field-name
  // logic entirely so we can A/B field names, date formats, etc. against the
  // live CT server without a redeploy per experiment.
  //   Body: { method: "TimeSeriesGet2", parameters: {...}, headerKind?: "iress"|"service", service?: "IOSPlus", timeout?: 20 }
  // The response is 1:1 with the IRESS reply (header row + sample data rows) or
  // the raw fault string — no mapping, no fabrication.
  if (req.method === "GET" && path === "/debug/market-data") {
    // Reports the prod-market-data / UAT-orders split status so the operator can
    // confirm it before trusting prod prices. `?live=1&sym=AGL` also fetches a
    // live quote from the PROD session to prove the feed is real market data.
    const enabled = marketDataProdEnabled();
    const ordersEndpoint = process.env.IRESS_BASE_URL ?? "https://webservices-ct.iress.co.za/v4";
    const mdEndpoint = enabled ? marketDataBaseUrl() : ordersEndpoint;
    let sessionUp = false;
    let sessionKeyPrefix: string | null = null;
    let liveQuote: { sym: string; last: number | null } | null = null;
    let error: string | null = null;
    try {
      const md = await getMarketDataSession();
      sessionUp = Boolean(md);
      sessionKeyPrefix = md ? md.sessionKey.slice(0, 8) : null;
      if (md && url.searchParams.get("live") === "1") {
        const sym = (url.searchParams.get("sym") ?? "AGL").trim().replace(/\.(JO|JSE)$/i, "") || "AGL";
        const q = await md.client.pricingQuoteGet({
          Header: { SessionKey: md.sessionKey, RequestID: newRequestID("md-check"), Timeout: 20 },
          SecurityCode: sym,
          Exchange: "JSE",
        });
        liveQuote = { sym, last: q.DataRows[0]?.last ?? null };
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    send(res, 200, {
      ok: true,
      marketDataProdEnabled: enabled,
      marketDataEndpoint: mdEndpoint,
      ordersEndpoint,
      split: enabled ? "market data = PROD, orders = UAT" : "single endpoint (both on IRESS_BASE_URL)",
      prodSession: { up: sessionUp, keyPrefix: sessionKeyPrefix, error },
      liveQuote,
      hint:
        "Set IRESS_MARKET_DATA_PROD=1 (and optionally IRESS_MARKETDATA_BASE_URL / IRESS_PROD_USERNAME+PASSWORD) on the worker to enable. If prodSession.up is false, the prod login failed (no seat / not entitled) and market data safely stays on Yahoo; orders are unaffected.",
    });
    return;
  }

  if (path === "/debug/release-md-seat") {
    // RECOVERY: kick + end any lingering PROD market-data session so DFM@Mint's
    // data server (IDS) releases back to CT/UAT. Needed after the prod split ran
    // on the shared single seat and left the CT session stuck "No IDS is online":
    // the old prod session holds the IDS until its ~2h timeout, so orders cannot
    // place until it is released. This connects to prod with the SAME market-data
    // ApplicationID, force-kicks that session, then ends the new one immediately
    // so nothing keeps holding the prod IDS. It touches ONLY the market-data seat
    // (never orders / positions). Requires ?confirm=release-md-seat so it is not
    // triggered by accident. Safe to run with the split off.
    if (url.searchParams.get("confirm") !== "release-md-seat") {
      send(res, 400, {
        ok: false,
        error: "add ?confirm=release-md-seat to run (kicks + ends the lingering prod market-data session so CT/UAT reclaims its IDS)",
      });
      return;
    }
    const prodUrl = marketDataBaseUrl();
    try {
      const creds = getIressProdCredentialsFromEnv();
      if (!creds.userName || !creds.password) {
        send(res, 200, { ok: false, error: "no prod credentials in env (IRESS_PROD_USERNAME/PASSWORD or shared IRESS_USERNAME/PASSWORD)" });
        return;
      }
      const client = createLiveIressClient({ baseUrl: prodUrl });
      const node =
        (process.env.WORKER_ID ?? process.env.RAILWAY_SERVICE_NAME ?? "railway").trim() || "railway";
      const applicationId = `Mint-OEMS-MarketData-${node}`;
      // Force-kick the lingering prod market-data session (same login+app id),
      // returning a fresh key that now holds the IDS...
      const started = await client.iressSessionStart({
        UserName: creds.userName,
        CompanyName: creds.company,
        Password: creds.password,
        ApplicationID: applicationId,
        ApplicationLabel: "Mint-OEMS-MarketData",
        SessionNumberToKick: -1,
        SessionTimeout: 5,
        Locale: "en-ZA",
      });
      // ...then end it right away so the prod IDS is fully released and CT can
      // reclaim it on the orders session's next start.
      await client.iressSessionEnd({ IRESSSessionKey: started.IRESSSessionKey });
      invalidateMarketDataSession();
      // Nudge the orders session to re-establish now that the IDS should be free.
      deps.sessions.invalidate();
      send(res, 200, {
        ok: true,
        endpoint: prodUrl,
        applicationId,
        message:
          "Kicked + ended the lingering prod market-data session; CT/UAT should reclaim its IDS on the next orders-session start (watch /debug/ips-session for IOSPlus=up).",
      });
    } catch (err) {
      send(res, 200, {
        ok: false,
        endpoint: prodUrl,
        error: err instanceof Error ? err.message : String(err),
        note: "If this errors 'No sessions to kick', the prod session already timed out; CT should recover on its own.",
      });
    }
    return;
  }

  if (req.method === "GET" && path === "/debug/method-ref") {
    // Read-only: drive the IRESS "Method Reference" / "WSDL" ASP.NET WebForm
    // server-side, using the worker's own env credentials, to fetch the
    // authoritative schema for a method on THIS CT build (the reconstructed
    // docs do not match it). Never echoes the password. Uses the IRESS licence
    // transiently (like any WSDL pull); the worker's session self-recovers.
    const docKind = (url.searchParams.get("doc") ?? "reference").toLowerCase();
    const service = (url.searchParams.get("service") ?? "IOSPlus").trim() || "IOSPlus";
    const server =
      (url.searchParams.get("server") ?? process.env.IRESS_IOS_SERVER ?? "MINT_CT").trim() || "MINT_CT";
    const methodFilter = (url.searchParams.get("method") ?? "OrderCreate3").trim();
    // freeSeat: briefly release the worker's IRESS seat so the form's own login
    // succeeds (the single licence is otherwise held by the worker). Gated by
    // IRESS_ALLOW_MUTATIONS since it interrupts the live worker session.
    const freeSeat = url.searchParams.get("freeSeat") === "1" && process.env.IRESS_ALLOW_MUTATIONS === "1";
    const pauseMs = Math.min(180000, Math.max(30000, Number(url.searchParams.get("pauseMs") ?? "90000")));
    const base = (process.env.IRESS_BASE_URL ?? "https://webservices-ct.iress.co.za/v4").replace(/\/+$/, "");
    const aspx = docKind === "wsdl" ? "WSDLForm.aspx" : "Documentation/MethodReference.aspx";
    const formUrl = `${base}/${aspx}`;
    const decodeEntities = (s: string): string =>
      s
        .replaceAll("&amp;", "&")
        .replaceAll("&lt;", "<")
        .replaceAll("&gt;", ">")
        .replaceAll("&quot;", '"')
        .replaceAll("&#39;", "'");
    let seatFreed = false;
    try {
      const creds = getIressCredentialsFromEnv();
      const ua = { "User-Agent": "Mozilla/5.0 (mint-worker method-ref probe)" };
      if (freeSeat) {
        // Pause the worker's re-acquisition, then end its wire session so the
        // licence is free for the form's transient login.
        deps.sessions.pauseAcquisition(pauseMs);
        seatFreed = await deps.sessions.tearDown();
      }
      // 1) GET the form to harvest hidden fields, cookies, and control names.
      const getRes = await fetch(formUrl, { headers: ua, signal: AbortSignal.timeout(20000) });
      const getHtml = await getRes.text();
      const setCookies =
        typeof (getRes.headers as { getSetCookie?: () => string[] }).getSetCookie === "function"
          ? (getRes.headers as { getSetCookie: () => string[] }).getSetCookie()
          : ((getRes.headers.get("set-cookie") ?? "").split(/,(?=[^;]+=)/) as string[]);
      const cookie = setCookies
        .map((c) => c.split(";")[0]?.trim())
        .filter(Boolean)
        .join("; ");
      const body = new URLSearchParams();
      const attrOf = (t: string, a: string): string | undefined =>
        (t.match(new RegExp(`${a}="([^"]*)"`, "i")) ?? [])[1];
      let serverName: string | undefined;
      let userName: string | undefined;
      let companyName: string | undefined;
      let passwordName: string | undefined;
      let filterName: string | undefined;
      let submitName: string | undefined;
      let submitVal = "Submit";
      for (const m of getHtml.matchAll(/<input\b[^>]*>/gi)) {
        const t = m[0];
        const name = attrOf(t, "name");
        if (!name) continue;
        const type = (attrOf(t, "type") ?? "text").toLowerCase();
        const value = decodeEntities(attrOf(t, "value") ?? "");
        if (type === "hidden") {
          body.set(name, value);
          continue;
        }
        const low = name.toLowerCase();
        if (low.includes("textboxserver")) serverName = name;
        else if (low.includes("textboxusername")) userName = name;
        else if (low.includes("textboxcompany")) companyName = name;
        else if (low.includes("textboxpassword")) passwordName = name;
        else if (low.includes("textboxmethodfilter")) filterName = name;
        else if (type === "submit") {
          submitName = name;
          submitVal = attrOf(t, "value") ?? "Submit";
        }
      }
      const selName = (getHtml.match(/<select[^>]*name="([^"]*DropDownListService[^"]*)"/i) ?? [])[1];
      body.set("__EVENTTARGET", "");
      body.set("__EVENTARGUMENT", "");
      if (selName) body.set(selName, service);
      if (serverName) body.set(serverName, server);
      if (userName) body.set(userName, creds.userName);
      if (companyName) body.set(companyName, creds.company);
      if (passwordName) body.set(passwordName, creds.password);
      if (filterName) body.set(filterName, methodFilter);
      if (submitName) body.set(submitName, submitVal);
      // 2) POST the filled form and return the raw response text (the schema).
      const postRes = await fetch(formUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          ...ua,
          ...(cookie ? { Cookie: cookie } : {}),
        },
        body: body.toString(),
        signal: AbortSignal.timeout(35000),
      });
      const text = await postRes.text();
      res.writeHead(postRes.status, { "content-type": "text/plain; charset=utf-8" });
      res.end(
        `# form=${aspx} service=${service} server=${server} method=${methodFilter} ` +
          `freeSeat=${freeSeat} seatFreed=${seatFreed} ` +
          `httpStatus=${postRes.status} fieldsFound=[server:${Boolean(serverName)} user:${Boolean(userName)} ` +
          `company:${Boolean(companyName)} pw:${Boolean(passwordName)} filter:${Boolean(filterName)} ` +
          `service:${Boolean(selName)} submit:${Boolean(submitName)}]\n\n${text.slice(0, 500000)}`,
      );
    } catch (err) {
      sendError(res, 502, "method_ref_failed", err instanceof Error ? err.message : String(err));
    }
    return;
  }

  if (req.method === "POST" && path === "/debug/soap-raw") {
    let body: unknown;
    try {
      body = await readBodyJson(req);
    } catch (err) {
      sendError(res, 400, "bad_request", (err as Error).message);
      return;
    }
    const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
    const method = typeof b["method"] === "string" ? b["method"].trim() : "";
    if (!method) {
      sendError(res, 400, "bad_request", '`method` is required (e.g. "TimeSeriesGet2")');
      return;
    }
    // Safety: this endpoint is auth-off. Block order-mutating / session-ending
    // methods unless explicitly allowed, so it can never place/cancel orders or
    // tear down the worker's session once IOS+ is live. Read/probe methods
    // (TimeSeriesGet2, PricingQuoteGet, ServiceSessionStart, …) stay open.
    if (
      /order(create|amend|delete|cancel)|sessionend|sessionrequestend|ipsupload/i.test(method) &&
      process.env.IRESS_ALLOW_MUTATIONS !== "1"
    ) {
      sendError(
        res,
        403,
        "mutation_blocked",
        `Mutating method "${method}" is blocked on /debug/soap-raw (set IRESS_ALLOW_MUTATIONS=1 to override)`,
      );
      return;
    }
    const parameters =
      b["parameters"] && typeof b["parameters"] === "object" && !Array.isArray(b["parameters"])
        ? (b["parameters"] as Record<string, unknown>)
        : {};
    const headerKind = b["headerKind"] === "service" ? "service" : "iress";
    const timeout =
      typeof b["timeout"] === "number" && Number.isFinite(b["timeout"])
        ? Math.trunc(b["timeout"] as number)
        : 20;
    // How many DataRows to echo back in `sampleRows` (default 3, cap 200) so a
    // probe can inspect list results like DestinationGet / AttributeGetByUser.
    const sampleLimit =
      typeof b["rows"] === "number" && Number.isFinite(b["rows"])
        ? Math.min(200, Math.max(1, Math.trunc(b["rows"] as number)))
        : 3;
    const isLive = deps.env.iressMode === "live" || deps.env.iressMode === "wsdl-stub";
    if (!isLive) {
      sendError(res, 503, "iress_mode_not_live", `Cannot probe in iressMode=${deps.env.iressMode}`);
      return;
    }
    const started = Date.now();
    try {
      const session = await deps.sessions.getSession();
      // Placeholder substitution so we can probe putting the live session key in
      // <Parameters> (some V4 methods read it there, not just the header):
      //   "$IRESS_SESSION_KEY" → the live IRESSSessionKey
      //   "$SERVICE_KEY:IOSPlus" → the cached IOS+ ServiceSessionKey (if any)
      for (const k of Object.keys(parameters)) {
        const v = parameters[k];
        if (v === "$IRESS_SESSION_KEY") parameters[k] = session.iressSessionKey;
        else if (typeof v === "string" && v.startsWith("$SERVICE_KEY:")) {
          parameters[k] = session.serviceKeys[v.slice("$SERVICE_KEY:".length) as IressService] ?? "";
        }
      }
      const transport = createSoapTransport({
        baseUrl: process.env.IRESS_BASE_URL ?? "https://webservices-ct.iress.co.za/v4",
      });
      const serviceKey =
        headerKind === "service" && typeof b["service"] === "string"
          ? session.serviceKeys[b["service"] as IressService]
          : undefined;
      const header = makeHeader(
        headerKind === "service"
          ? { serviceSessionKey: serviceKey, requestID: newRequestID("raw"), timeout, waitForResponse: true }
          : {
              sessionKey: session.iressSessionKey,
              requestID: newRequestID("raw"),
              timeout,
              waitForResponse: true,
            },
      );
      const result = await transport.call({ method, header, parameters });
      const headerRow = (result.header ?? {}) as Record<string, unknown>;
      const errNo = Number(headerRow["ErrorNumber"] ?? headerRow["errorNumber"] ?? 0);
      send(res, 200, {
        ok: errNo === 0,
        method,
        parameters,
        errorNumber: Number.isFinite(errNo) ? errNo : null,
        headerRow,
        dataRowCount: Array.isArray(result.dataRows) ? result.dataRows.length : 0,
        firstRow: result.firstRow ?? (Array.isArray(result.dataRows) ? (result.dataRows[0] ?? null) : null),
        sampleRows: Array.isArray(result.dataRows) ? result.dataRows.slice(0, sampleLimit) : [],
        elapsedMs: Date.now() - started,
        build: PROBE_BUILD,
      });
    } catch (err) {
      send(res, 200, {
        ok: false,
        method,
        parameters,
        error: err instanceof Error ? err.message : String(err),
        code: err instanceof IressError ? err.code : null,
        elapsedMs: Date.now() - started,
        build: PROBE_BUILD,
      });
    }
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
      sendError(
        res,
        400,
        "bad_request",
        "Body must be JSON with `symbols` (string[]) and optional `exchange`",
      );
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
      sendError(
        res,
        400,
        "too_many",
        "Send at most 80 symbols per request (batch the rest) to avoid SOAP timeout",
        {
          max: 80,
          got: symbols.length,
        },
      );
      return;
    }
    const exchange = typeof b["exchange"] === "string" ? b["exchange"].trim().toUpperCase() : "JSE";
    const isLive = deps.env.iressMode === "live" || deps.env.iressMode === "wsdl-stub";
    if (!isLive) {
      sendError(
        res,
        503,
        "iress_mode_not_live",
        `Cannot probe coverage in iressMode=${deps.env.iressMode}; switch the worker to live`,
        {
          iressMode: deps.env.iressMode,
        },
      );
      return;
    }
    const result = await probeCoverage(deps, symbols, exchange);
    send(res, 200, result);
    return;
  }

  if (req.method === "GET" && path === "/debug/iress-methods") {
    const isLive = deps.env.iressMode === "live" || deps.env.iressMode === "wsdl-stub";
    if (!isLive) {
      sendError(res, 503, "iress_mode_not_live", `Cannot probe in iressMode=${deps.env.iressMode}`, {
        iressMode: deps.env.iressMode,
      });
      return;
    }
    const result = await probeIressMethods(deps);
    send(res, 200, result);
    return;
  }

  // ──────────────────────────────────────────────────────────────────
  // UAT mode — Mint OEM Finalisation Phase UAT.
  //
  // Two endpoints, both gated on `IRESS_UAT_MODE=1`:
  //   POST /uat/send-to-market   — call IRESS OrderCreate3 on the UAT
  //                                account and stamp the OrderNumber back
  //                                onto the matching oems_order_audit row
  //   GET  /uat/execution-stream — SSE stream of execution deltas from
  //                                the UAT order poll loop (see
  //                                `./order-poller.ts`)
  //
  // UAT orders go to `IRESS_UAT_ACCOUNT_CODE` — a *separate* IRESS
  // AccountCode, not the production `IRESS_ACCOUNT_CODE`. This is what
  // lets UAT users exercise the full order pipeline without touching
  // real client books.
  // ──────────────────────────────────────────────────────────────────

  if (path === "/uat/send-to-market" || path === "/uat/execution-stream" || path === "/uat/status") {
    if (!deps.env.uatMode) {
      sendError(
        res,
        403,
        "uat_mode_disabled",
        "UAT mode is not enabled on this worker (set IRESS_UAT_MODE=1)",
        { uatMode: false },
      );
      return;
    }
  }

  if (req.method === "POST" && path === "/uat/send-to-market") {
    if (!deps.env.uatAccountCode) {
      sendError(
        res,
        503,
        "uat_account_not_configured",
        "IRESS_UAT_ACCOUNT_CODE is not set; refusing to send orders without an explicit UAT account",
        { hint: "Set IRESS_UAT_ACCOUNT_CODE on the worker (must differ from IRESS_ACCOUNT_CODE)" },
      );
      return;
    }
    const isLive = deps.env.iressMode === "live" || deps.env.iressMode === "wsdl-stub";
    if (!isLive) {
      sendError(
        res,
        503,
        "iress_mode_not_live",
        `Cannot place UAT orders in iressMode=${deps.env.iressMode}`,
        {
          iressMode: deps.env.iressMode,
          hint: "Set IRESS_MODE=live on the worker (requires IRESS_USERNAME/PASSWORD/COMPANY_NAME)",
        },
      );
      return;
    }
    let body: unknown;
    try {
      body = await readBodyJson(req);
    } catch (err) {
      sendError(res, 400, "bad_request", (err as Error).message);
      return;
    }
    if (!body || typeof body !== "object") {
      sendError(
        res,
        400,
        "bad_request",
        "Body must be JSON with `order_audit_id` and (optionally) `account_code` and `broker_destination`",
      );
      return;
    }
    const b = body as Record<string, unknown>;
    const orderAuditId =
      typeof b["order_audit_id"] === "string" ? (b["order_audit_id"] as string).trim() : "";
    if (!orderAuditId) {
      sendError(res, 400, "bad_request", "`order_audit_id` is required");
      return;
    }
    const accountCode =
      (typeof b["account_code"] === "string" && (b["account_code"] as string).trim()) ||
      deps.env.uatAccountCode;
    // Refuse to send to the production account by accident, but ONLY on the
    // production endpoint. On the CT test endpoint (webservices-ct) the trading
    // account IS the test account (MINT_CT, no real money), so single-account
    // UAT testing is allowed. "webservices.iress" (no -ct) = prod.
    const iressBaseUrl = process.env.IRESS_BASE_URL ?? "https://webservices-ct.iress.co.za/v4";
    const onProdEndpoint = /webservices\.iress/.test(iressBaseUrl);
    if (onProdEndpoint && accountCode === deps.env.iressAccountCode && deps.env.iressAccountCode) {
      sendError(
        res,
        400,
        "wrong_account",
        "On the production endpoint, UAT orders must target IRESS_UAT_ACCOUNT_CODE, not IRESS_ACCOUNT_CODE",
        { accountCode, productionAccount: deps.env.iressAccountCode },
      );
      return;
    }
    // UAT orders route to the "LONGMARK CARE" destination (-> EXT_BROKERTI), per
    // IRESS (Andre, 2026-07-13, connecting the LONGMARK CARE session).
    // IRESS_UAT_DESTINATION overrides centrally without a redeploy.
    const brokerDestination =
      process.env.IRESS_UAT_DESTINATION?.trim() ||
      (typeof b["broker_destination"] === "string" && (b["broker_destination"] as string).trim()) ||
      "LONGMARK CARE";

    const result = await uatSendToMarket(deps, orderAuditId, accountCode, brokerDestination);
    if (!result.ok) {
      sendError(res, result.status, result.code, result.message, result.extra);
      return;
    }
    send(res, 200, result.body);
    return;
  }

  if (req.method === "GET" && path === "/uat/status") {
    send(res, 200, {
      ok: true,
      uatMode: deps.env.uatMode,
      uatAccountCode: deps.env.uatAccountCode || null,
      productionAccountCode: deps.env.iressAccountCode || null,
      iressMode: deps.env.iressMode,
      lastPollAt: getLastUatPollAt() ?? null,
      pollIntervalSec: deps.env.uatOrderPollSec,
      workerId: deps.env.workerId,
    });
    return;
  }

  if (req.method === "GET" && path === "/uat/execution-stream") {
    await streamUatExecution(req, res, deps);
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
      console.info(`[iress-ingest] http api listening on ${url} (auth=${authToken ? "on" : "off"})`);
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
  const account =
    url.searchParams.get("account")?.trim() || deps.env.iressAccountCode.split(",")[0]?.trim() || "";
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
  const filter: OrderFilter = (
    VALID_FILTERS.has(filterParam as OrderFilter) ? filterParam : 1
  ) as OrderFilter;
  const intervalSec = Math.max(2, Number(url.searchParams.get("interval") ?? "5"));

  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store, no-transform",
    connection: "keep-alive",
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

// ──────────────────────────────────────────────────────────────────
// UAT mode helpers
// ──────────────────────────────────────────────────────────────────

interface UatAuditRow {
  id: string;
  order_id: string;
  symbol: string;
  side: string;
  quantity: number;
  price_cents: number | null;
  status: string;
  payload: Record<string, unknown>;
  result_payload: Record<string, unknown>;
}

interface UatSendOkBody {
  ok: true;
  iressOrderNumber: string;
  status: "working" | "rejected";
  orderAuditId: string;
  accountCode: string;
  brokerDestination: string;
  iressMode: string;
  errorNumber?: number;
  errorDescription?: string;
}

type UatSendResult =
  | { ok: true; body: UatSendOkBody; status: 200; code?: never; message?: never; extra?: undefined }
  | {
      ok: false;
      status: number;
      code: string;
      message: string;
      extra?: Record<string, unknown>;
      body?: never;
    };

function asNumber(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Read the audit row, build the IRESS `OrderCreate3` request from the
 * payload, dispatch via the cached IOSPlus service session, and stamp the
 * broker-assigned `OrderNumber` back onto the audit row.
 *
 * Falls back to `orderNoGetByOrderTag` if the SOAP call itself fails with
 * a transport-level error (HTTP 500, timeout, TCP RST) — IRESS may have
 * accepted the order but the response was lost. The tag is the UUID we
 * generated at send-to-market time (stored in payload.uatOrderTag).
 */
/**
 * Stamp the audit row + publish the SSE delta after OrderCreate3 finishes.
 * Used from both the success and the business-rejection paths so the
 * audit row + UI surface the same Hermes lifecycle detail (`pending_ack`
 * on success, `rejected` on a broker rejection) regardless of which
 * path triggered the stamp.
 */
async function stampAfterOrderCreate3(opts: {
  deps: HttpApiDeps;
  audit: UatAuditRow;
  orderCreateStatus: "working" | "rejected";
  errorNumber: number | undefined;
  errorDescription: string | undefined;
  existingTag: string;
  brokerDestination: string;
  exchange: string;
  tif: "DAY";
  accountCode: string;
  qty: number;
  symbol: string;
  orderType: "MKT" | "LMT";
  priceRands: number | undefined;
  side: 1 | 2;
  iressOrderNumber: string | null;
}): Promise<{ stampedAt: string; writeErr?: string }> {
  const {
    deps,
    audit,
    orderCreateStatus,
    errorNumber,
    errorDescription,
    existingTag,
    brokerDestination,
    exchange,
    tif,
    accountCode,
    qty,
    symbol,
    orderType,
    priceRands,
    side,
    iressOrderNumber,
  } = opts;
  const db = deps.supabase;
  const stampedAt = new Date().toISOString();
  const payloadObj = (audit.payload ?? {}) as Record<string, unknown>;

  // 2026-07-13 (Andre + Juan call, 26:21): Andre flagged "last action"
  // as a key field. Stamp a compact one-liner on every OrderCreate3
  // transition so the UI doesn't have to invent the action description
  // from raw Hermes fields.
  const lastAction = orderCreateStatus === "rejected"
    ? `Rejected (${errorNumber ?? "?"}: ${errorDescription ?? "no detail"})`
    : "Submitted to IRESS — awaiting broker acknowledgement";
  const newPayload: Record<string, unknown> = {
    ...payloadObj,
    uat: true,
    uatOrderTag: existingTag,
    uatAccountCode: accountCode,
    broker_destination: brokerDestination,
    uatSentAt: stampedAt,
    ...(iressOrderNumber ? { iress_order_number: iressOrderNumber } : {}),
    lastAction,
    lastActionAt: stampedAt,
  };
  const newResult: Record<string, unknown> = {
    ...(audit.result_payload ?? {}),
    broker: brokerDestination,
    venue: exchange,
    tif,
    orderTag: existingTag,
    uatAccountCode: accountCode,
    ...(iressOrderNumber ? { iress_order_number: iressOrderNumber } : {}),
    lastAction,
    lastActionAt: stampedAt,
  };
  if (errorNumber != null) {
    newResult.uatErrorNumber = errorNumber;
    newResult.uatErrorDescription = errorDescription;
  }

  let writeErr: string | undefined;
  if (db) {
    const { error: writeErrDb } = await db
      .from("oems_order_audit")
      .update({
        payload: newPayload,
        result_payload: newResult,
        status:
          orderCreateStatus === "rejected" ? "rejected" : "pending_ack",
        updated_at: stampedAt,
      })
      .eq("id", audit.id);
    if (writeErrDb) writeErr = writeErrDb.message;
  }

  // Hermes lifecycle publish.
  const initialHubState: OrderState =
    orderCreateStatus === "rejected" ? "REJECTED" : "PENDING_ACK";
  // 2026-07-13 — Transcript gap #1 + #2 (23:40 / 26:21): carry the
  // lastAction one-liner AND the IRESS error fields in the SSE delta
  // so the UI's new Action + Error columns update without a poll
  // cycle.
  const lastActionSummary =
    orderCreateStatus === "rejected"
      ? `Rejected (${errorNumber ?? "?"}: ${errorDescription ?? "no detail"})`
      : "Submitted to IRESS — awaiting broker acknowledgement";
  uatExecutionHub.publish({
    iressOrderNumber: iressOrderNumber ?? "",
    orderAuditId: audit.id,
    state: orderCreateStatus === "rejected" ? "rejected" : "pending_ack",
    filled: 0,
    avgFillPrice: priceRands ?? null,
    lastFillTimestamp: stampedAt,
    lastAction: lastActionSummary,
    lastActionAt: stampedAt,
    iressErrorNumber: orderCreateStatus === "rejected" ? errorNumber ?? null : null,
    iressErrorDescription:
      orderCreateStatus === "rejected" ? errorDescription ?? null : null,
    raw: {
      id: iressOrderNumber ?? "",
      account: accountCode,
      strategy: typeof payloadObj.strategy === "string" ? (payloadObj.strategy as string) : "",
      side: side === 1 ? "BUY" : "SELL",
      symbol,
      isin: typeof payloadObj.isin === "string" ? (payloadObj.isin as string) : "",
      type: orderType as "MKT" | "LMT",
      tif: tif as "DAY",
      destination: brokerDestination as "JSE" | "OTC" | "DARK",
      qty,
      filled: 0,
      limit: priceRands ?? null,
      stop: null,
      avgPx: null,
      vwap: null,
      trader:
        typeof payloadObj.sent_by === "string" ? (payloadObj.sent_by as string) : "",
      ts: Date.now(),
      state: initialHubState,
      orderTag: existingTag,
      slippageBps: null,
      arrivalMid: 0,
      brokerState: iressOrderNumber ? "ACTIVE" : null,
      actionStatus: null,
      internalOrderStatus:
        orderCreateStatus === "rejected" ? "Rejected" : "Pending",
      stateDescription:
        orderCreateStatus === "rejected"
          ? (errorDescription ?? "OrderCreate3 returned non-zero error")
          : "Submitted to IRESS — awaiting broker acknowledgement",
      remainingVolume: orderCreateStatus === "rejected" ? 0 : qty,
      remainingValueCents:
        orderCreateStatus === "rejected" || priceRands == null
          ? null
          : Math.round(priceRands * qty * 100),
      orderValueCents: priceRands != null ? Math.round(priceRands * qty * 100) : null,
    },
    bookId: typeof payloadObj.book_id === "string" ? (payloadObj.book_id as string) : null,
    observedAt: stampedAt,
  });

  return { stampedAt, writeErr };
}

async function uatSendToMarket(
  deps: HttpApiDeps,
  orderAuditId: string,
  accountCode: string,
  brokerDestination: string,
): Promise<UatSendResult> {
  const db = deps.supabase;
  if (!db) {
    return {
      ok: false,
      status: 503,
      code: "supabase_not_configured",
      message: "Worker has no Supabase client",
    };
  }

  // Read the audit row the BFF wrote at /api/admin/orderbook/send-to-market.
  const { data: row, error: readErr } = await db
    .from("oems_order_audit")
    .select("id, order_id, symbol, side, quantity, price_cents, status, payload, result_payload")
    .eq("id", orderAuditId)
    .maybeSingle();

  if (readErr) {
    return { ok: false, status: 500, code: "audit_read_failed", message: readErr.message };
  }
  if (!row) {
    return {
      ok: false,
      status: 404,
      code: "audit_not_found",
      message: `No oems_order_audit row for id=${orderAuditId}`,
    };
  }
  const audit = row as UatAuditRow;

  if (audit.payload && (audit.payload as { iress_order_number?: string }).iress_order_number) {
    // Already sent to IRESS — return the existing assignment as idempotent.
    return {
      ok: true,
      status: 200,
      body: {
        ok: true,
        iressOrderNumber: (audit.payload as { iress_order_number: string }).iress_order_number,
        status: "working",
        orderAuditId: audit.id,
        accountCode,
        brokerDestination,
        iressMode: deps.env.iressMode,
      },
    };
  }

  // Build the IRESS NewOrder from the audit row.
  const qty = Number(audit.quantity) || 0;
  if (qty <= 0) {
    return { ok: false, status: 400, code: "invalid_quantity", message: "Audit row has no usable quantity" };
  }
  const symbol = (audit.symbol ?? "").trim();
  if (!symbol) {
    return { ok: false, status: 400, code: "invalid_symbol", message: "Audit row has no symbol" };
  }
  const side = (audit.side ?? "buy").toLowerCase() === "sell" ? 2 : 1; // 1=BUY, 2=SELL
  const orderType = audit.price_cents != null ? "LMT" : "MKT";
  const priceRands = audit.price_cents != null ? Number(audit.price_cents) / 100 : undefined;
  const exchange = "JSE";
  const tif = "DAY";

  // IDEMPOTENCY: re-use any pre-existing tag from the audit payload, else mint a UUID.
  const payloadObj = audit.payload ?? {};
  const existingTag =
    typeof payloadObj.uatOrderTag === "string" && (payloadObj.uatOrderTag as string).length > 0
      ? (payloadObj.uatOrderTag as string)
      : randomUUID();

  const order = {
    AccountCode: accountCode,
    SecurityCode: symbol,
    Exchange: exchange,
    BuySell: side as 1 | 2,
    OrderType: orderType as "MKT" | "LMT",
    Volume: qty,
    ...(priceRands != null ? { Price: priceRands } : {}),
    Destination: brokerDestination,
    TimeInForce: tif as "DAY",
  };

  let iressOrderNumber: string | null = null;
  let errorNumber: number | undefined;
  let errorDescription: string | undefined;
  let orderCreateStatus: "working" | "rejected" = "working";

  try {
    const session = await deps.sessions.getSession();
    const iosKey = session.serviceKeys.IOSPlus;
    if (!iosKey) {
      return {
        ok: false,
        status: 503,
        code: "ios_unavailable",
        message: "IOSPlus service session not available; cannot place UAT orders",
        extra: { hint: "Check /debug/ips-session — ServiceSessionStart(IOSPlus) failed" },
      };
    }
    const client = getIressClient("live");
    const res = await client.orderCreate3({
      ServiceSessionKey: iosKey,
      Order: order,
      OrderTag: existingTag,
    });
    if (res.ErrorNumber && res.ErrorNumber !== 0) {
      errorNumber = res.ErrorNumber;
      errorDescription = res.ErrorDescription ?? "OrderCreate3 returned non-zero error";
      orderCreateStatus = "rejected";
    }
    iressOrderNumber = res.OrderNumber || null;
    if (!iressOrderNumber) {
      // Distinguish a business rejection (ErrorNumber != 0, no OrderNumber)
      // from a transport-level failure. 2026-07-13 (Juan + Andre): when
      // IRESS returns ErrorNumber=25014 (Not entitled) the broker REJECTED
      // the order — the upstream API call succeeded. We must surface that
      // as a 422-rejected AND stamp the audit row + publish the SSE delta
      // so the UI flips to REJECTED immediately. The previous code
      // returned 502 here which skipped both, leaving the UI perpetually
      // on WORKING.
      if (errorNumber != null) {
        // Stamp the audit row + publish the SSE delta before returning
        // so the UI flips to REJECTED immediately instead of staying on
        // the BFF-seeded WORKING.
        await stampAfterOrderCreate3({
          deps,
          audit,
          orderCreateStatus,
          errorNumber,
          errorDescription,
          existingTag,
          brokerDestination,
          exchange,
          tif,
          accountCode,
          qty,
          symbol,
          orderType,
          priceRands,
          side: side as 1 | 2,
          iressOrderNumber: null,
        });
        return {
          ok: false,
          status: 422,
          code: "order_rejected",
          message: `OrderCreate3 rejected by broker (${errorNumber}): ${errorDescription ?? "no description"}`,
          extra: { errorNumber, errorDescription },
        };
      }
      return {
        ok: false,
        status: 502,
        code: "no_order_number",
        message: "OrderCreate3 returned no OrderNumber",
        extra: { errorNumber, errorDescription },
      };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const code = err instanceof IressError ? err.code : null;
    if (isIressSessionDeadError(err) || (err instanceof IressError && err.code === 25001)) {
      deps.sessions.invalidate();
    }
    // A business rejection (IRESS order-validation error, code 20xxx) means the
    // server RESPONDED with a rejection, so there is nothing to recover: report
    // it as failed. The OrderTag recovery below is only for transport-level
    // failures (HTTP 500, timeout, TCP RST) where IRESS may have accepted the
    // order but the response was lost.
    const businessReject = err instanceof IressError && err.code >= 20000 && err.code < 25000;
    if (!businessReject) {
      try {
        const session = await deps.sessions.getSession();
        const iosKey = session.serviceKeys.IOSPlus;
        if (iosKey) {
          const client = getIressClient("live");
          const lookup = await client.orderNoGetByOrderTag({
            ServiceSessionKey: iosKey,
            OrderTag: existingTag,
          });
          if (lookup.OrderNumber) {
            iressOrderNumber = lookup.OrderNumber;
          }
        }
      } catch {
        /* fall through to the error */
      }
    }
    if (!iressOrderNumber) {
      return {
        ok: false,
        status: 502,
        code: code ? `iress_${code}` : "order_create_failed",
        message: `OrderCreate3 failed: ${msg}`,
        extra: { orderTag: existingTag },
      };
    }
  }

  // Stamp the broker-assigned OrderNumber back onto the audit row +
  // publish the SSE delta. Centralised so the success and rejection
  // paths share the same Hermes-lifecycle detail.
  const stamp = await stampAfterOrderCreate3({
    deps,
    audit,
    orderCreateStatus,
    errorNumber,
    errorDescription,
    existingTag,
    brokerDestination,
    exchange,
    tif,
    accountCode,
    qty,
    symbol,
    orderType,
    priceRands,
    side: side as 1 | 2,
    iressOrderNumber,
  });

  if (stamp.writeErr) {
    return {
      ok: false,
      status: 500,
      code: "audit_stamp_failed",
      message: `Order placed but audit stamp failed: ${stamp.writeErr}`,
      extra: { iressOrderNumber, orderAuditId: audit.id },
    };
  }

  return {
    ok: true,
    status: 200,
    body: {
      ok: true,
      iressOrderNumber: iressOrderNumber ?? "",
      status: orderCreateStatus,
      orderAuditId: audit.id,
      accountCode,
      brokerDestination,
      iressMode: deps.env.iressMode,
      ...(errorNumber != null ? { errorNumber } : {}),
      ...(errorDescription != null ? { errorDescription } : {}),
    },
  };
}

async function streamUatExecution(
  req: IncomingMessage,
  res: ServerResponse,
  deps: HttpApiDeps,
): Promise<void> {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store, no-transform",
    connection: "keep-alive",
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

  // Initial status frame so the client knows the stream is live.
  push("status", {
    uatMode: deps.env.uatMode,
    uatAccountCode: deps.env.uatAccountCode || null,
    lastPollAt: getLastUatPollAt() ?? null,
    pollIntervalSec: deps.env.uatOrderPollSec,
    timestamp: new Date().toISOString(),
  });

  // Keepalive ping every 25s — IRESS brokers tend to kill idle SSEs.
  const ping = setInterval(() => {
    if (closed) return;
    try {
      res.write(`: keepalive ${Date.now()}\n\n`);
    } catch {
      closed = true;
    }
  }, 25_000);

  const unsubscribe = uatExecutionHub.subscribe((delta: UatExecutionDelta) => {
    if (closed) return;
    push("delta", {
      order_audit_id: delta.orderAuditId,
      iress_order_number: delta.iressOrderNumber,
      state: delta.state,
      filled: delta.filled,
      avg_fill_price_cents: delta.avgFillPrice != null ? Math.round(delta.avgFillPrice * 100) : null,
      symbol: delta.raw.symbol,
      side: delta.raw.side,
      qty: delta.raw.qty,
      book_id: delta.bookId,
      timestamp: delta.observedAt,
      // IRESS Hermes lifecycle detail (2026-07-13). Forwarded so the
      // ExecutionView can show "Traded 200 @ 17700" + action status +
      // remaining volume as a tooltip on the State badge without polling.
      // When the audit row hasn't stamped these yet (e.g. a freshly-sent
      // order before the first poll cycle writes them), the UI falls back
      // to the existing row.
      brokerState: delta.raw.brokerState ?? null,
      actionStatus: delta.raw.actionStatus ?? null,
      internalOrderStatus: delta.raw.internalOrderStatus ?? null,
      stateDescription: delta.raw.stateDescription ?? null,
      remainingVolume: delta.raw.remainingVolume ?? null,
      remainingValueCents: delta.raw.remainingValueCents ?? null,
      orderValueCents: delta.raw.orderValueCents ?? null,
      // 2026-07-13 — Transcript gap #2 (26:21): forward the one-liner
      // last-action summary so the UI's new Action column updates
      // immediately on every state transition.
      lastAction: delta.lastAction ?? null,
      lastActionAt: delta.lastActionAt ?? null,
      // 2026-07-13 — Transcript gap #1 (23:40): forward IRESS error
      // fields so a rejection delta surfaces the actual reason
      // without the operator needing to dig into Supabase.
      iressErrorNumber: delta.iressErrorNumber ?? null,
      iressErrorDescription: delta.iressErrorDescription ?? null,
    });
  });

  await new Promise<void>((resolve) => {
    req.on("close", () => resolve());
    req.on("aborted", () => resolve());
  });

  clearInterval(ping);
  unsubscribe();
  res.end();
}
