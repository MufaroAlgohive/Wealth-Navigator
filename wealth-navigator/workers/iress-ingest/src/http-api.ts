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
import { availableToSell, availableToBuy, type SellAvailability, type CashAvailability } from "./pretrade-guard";
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
  /**
   * RETAIL (mfxng) client — the per-client ledger (stock_holdings_c / wallets)
   * the per-client pre-trade guard checks for PRODUCTION client orders. Optional
   * + dormant: the desk/UAT path never uses it (see resolveHolderKind +
   * IRESS_PER_CLIENT_GUARD).
   */
  retailSupabase?: WorkerSupabase | null;
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

/**
 * Mutating HTTP routes — order cancel/amend, UAT send-to-market, the raw SOAP
 * prober, the heartbeat writer, and the prod market-data seat release. Used only
 * to decide whether to log a CRITICAL "served without auth" line when
 * WORKER_HTTP_TOKEN is unset (fail-open). Read/probe routes stay quiet.
 */
function isMutatingRequest(method: string | undefined, path: string): boolean {
  const m = (method ?? "GET").toUpperCase();
  if (
    m === "POST" &&
    (path === "/orders/cancel" ||
      path === "/orders/amend" ||
      path === "/uat/send-to-market" ||
      path === "/debug/soap-raw" ||
      path === "/heartbeat/refresh")
  ) {
    return true;
  }
  // /debug/release-md-seat mutates the prod market-data session regardless of verb.
  if (path === "/debug/release-md-seat") return true;
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
  /** Echoed ISO-naive `YYYY-MM-DDTHH:MM:SS` window the probe queried. */
  dateTimeStart: string;
  dateTimeEnd: string;
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
 * One-shot `NewsHeadlineGet` probe — confirmed working envelope:
 *   <Parameters>
 *     <VendorCode>SENSD</VendorCode>     ("SENS NEWS DELAYED" on this CT build)
 *     <DateTimeStart>2026-07-20T00:00:00</DateTimeStart>
 *     <DateTimeEnd>2026-07-20T23:59:59</DateTimeEnd>
 *     <Count>20</Count>
 *   </Parameters>
 *
 * Runs on the **prod market-data session** (so the SENS entitlement is
 * honoured — see `wealth-navigator/docs/SENS_NEWSHEADLINE_WIRE.md`).
 * `NewsVendorGet` returns the vendor catalog only (1 row); the actual
 * story-fetching verb on this CT build is `NewsHeadlineGet`.
 *
 * Wire shape mirrors `probeTimeSeriesInterval`:
 *   - caller supplies `vendor` (default `SENSD` — the code that the
 *     server actually accepts on the prod market-data session for
 *     SENS announcements; the catalog row labels it "SENS NEWS DELAYED")
 *   - `dateFrom` / `dateTo` default to today (UTC) when not supplied;
 *     both inclusive lower / inclusive upper in ISO-naive format
 *   - `pageSize` (Count) capped at 1000 (the CT max)
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
  dateTimeStart: string,
  dateTimeEnd: string,
  pageSize: number,
  timeout: number,
  includeBody: boolean,
  securityCode = "",
): Promise<NewsProbeResult> {
  const started = Date.now();
  try {
    const session = await deps.sessions.getSession();
    // News is market data: use the PROD market-data session when the split is
    // on, else the UAT session. On this CT build the prod session is what
    // carries the SENS entitlement; the base session returns test fixtures.
    const md = await getMarketDataSession();
    void marketDataProdEnabled(); // kept for symmetry / future diagnostics
    const client = md ? md.client : getIressClient("live");
    // The IRESS `NewsHeadlineGet` request shape includes an optional
    // `SecurityCode` parameter that some prod builds accept for
    // per-symbol scoping (Andre's WSDL browser capture 2026-07-22).
    // Forward it through when supplied; if the build ignores it, the
    // vendor-broadcast result lands unchanged.
    const res = await client.newsHeadlineGet({
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
      VendorCode: vendor,
      DateTimeStart: dateTimeStart,
      DateTimeEnd: dateTimeEnd,
      Count: pageSize,
      ...(securityCode ? { SecurityCode: securityCode } : {}),
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
      dateTimeStart,
      dateTimeEnd,
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
      // Market-data session presence is informational only — `md.sessionKey`
      // above vs. `session.iressSessionKey` is the indicator and we don't
      // want to leak the env var.
      // if/when we add it. Today `md.sessionKey` versus `session.iressSessionKey`
      // is the indicator and we don't want to leak the env var.
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const faultCode = err instanceof IressError ? err.code : null;
    return {
      ok: false,
      vendor,
      dateTimeStart,
      dateTimeEnd,
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

interface OrderAmendResult {
  ok: boolean;
  orderId: string;
  account: string;
  amendedAt: string;
  workerId: string;
  iressMode: string;
  // Echo back the fields we sent to OrderAmend2 so the caller / audit row
  // can show what was changed. Null when not amended (failed path).
  newPrice: number | null;
  newVolume: number | null;
  newTif: string | null;
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
    let cancelledSymbol: string | null = null;
    let cancelledQty: number | null = null;
    let cancelledPayload: Record<string, unknown> = {};
    if (deps.supabase) {
      try {
        // Read the existing audit row(s) so the SSE delta carries the
        // pre-cancel filled / avg fill values AND symbol / qty from the
        // top-level columns (those are NOT inside payload). Without
        // these, the UI's second grouped row (the cancel delta) renders
        // with `symbol: "—"` and `qty: "0"` until the next poll lands.
        const { data: existing } = await deps.supabase
          .from("oems_order_audit")
          .select("id, payload, symbol, quantity")
          .or(`order_id.eq.${orderId},payload->>iress_order_number.eq.${orderId}`)
          .limit(1);
        if (existing && existing.length > 0) {
          const ex = existing[0] as {
            id: string;
            payload: Record<string, unknown> | null;
            symbol: string | null;
            quantity: number | null;
          };
          cancelledAuditId = ex.id;
          cancelledPayload = (ex.payload ?? {}) as Record<string, unknown>;
          cancelledSymbol = ex.symbol ?? null;
          cancelledQty = typeof ex.quantity === "number" ? ex.quantity : null;
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
            // cancel_pending, NOT cancelled: OrderDelete is sent but the broker
            // has not acked — the order can still FILL in the race, so the poller
            // writes the true terminal state (cancelled OR filled). MERGE the
            // payload: a bare {lastAction} REPLACED the jsonb column, wiping
            // book_id/strategy/iress_order_number and dropping the row out of the
            // book-scoped execution poll — the actual cause of the stuck
            // CANCEL_PENDING. updated_at lets the UI reconcile its optimistic override.
            status: "cancel_pending",
            payload: {
              ...cancelledPayload,
              lastAction: "Cancel sent — awaiting broker acknowledgement",
              lastActionAt: cancelledAt,
            },
            updated_at: cancelledAt,
          })
          .eq("order_id", orderId);
        await deps.supabase
          .from("oems_order_audit")
          .update({
            status: "cancel_pending",
            payload: {
              ...cancelledPayload,
              lastAction: "Cancel sent — awaiting broker acknowledgement",
              lastActionAt: cancelledAt,
            },
            updated_at: cancelledAt,
          })
          .eq("payload->>iress_order_number", orderId);
      } catch {
        /* audit stamp is best-effort; the broker cancel already succeeded */
      }

      // Publish the SSE delta so subscribed UIs flip to
      // "CANCEL_PENDING" immediately — without waiting for the next
      // 30s poll. The hub suppresses no-op deltas (state didn't
      // change), but "cancel_pending" is always a state change
      // relative to anything pre-cancel. The next poll (or a manual
      // ack from the desk broker) writes a CANCELLED row which flips
      // the UI to terminal.
      try {
        uatExecutionHub.publish({
          iressOrderNumber: orderId,
          orderAuditId: cancelledAuditId,
          state: "cancel_pending",
          filled: cancelledFilled ?? 0,
          avgFillPrice: cancelledAvgFillCents != null ? cancelledAvgFillCents / 100 : null,
          lastFillTimestamp: cancelledAt,
          // 2026-07-13 — Transcript gap #2 (26:21): explicitly carry the
          // last-action text so the UI's new Action column updates
          // without needing a poll cycle.
          // 2026-07-14 — Transcript gap #3 (19:35, 19:49): symbol + qty
          // disappear on the cancel delta because the OrderDelete SOAP
          // reply doesn't carry the original row's SecurityCode /
          // Volume. Carry them forward from the existing audit row so
          // the parent's symbol/qty never blanks while the cancel
          // instruction is in-flight. `symbol` defaults to "" and qty
          // to 0 only if we genuinely have no prior audit row to read
          // from (first-ever cancel of a freshly created order).
          lastAction: "Cancel sent — awaiting broker acknowledgement",
          lastActionAt: cancelledAt,
          raw: {
            id: orderId,
            account,
            strategy: "",
            side: "BUY",
            symbol: cancelledSymbol ?? "",
            isin: "",
            type: "LMT",
            tif: "DAY",
            destination: "JSE",
            qty: cancelledQty ?? 0,
            filled: cancelledFilled ?? 0,
            limit: null,
            stop: null,
            avgPx: cancelledAvgFillCents != null ? cancelledAvgFillCents / 100 : null,
            vwap: null,
            trader: "",
            ts: Date.parse(cancelledAt) || Date.now(),
            state: "CANCEL_PENDING" as OrderState,
            orderTag: "",
            slippageBps: null,
            arrivalMid: 0,
            brokerState: "INACTIVE",
            actionStatus: "Cancel sent",
            internalOrderStatus: "Awaiting cancel acknowledgement",
            stateDescription: "Cancel instruction sent — awaiting broker acknowledgement",
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

/**
 * Forward an `OrderAmend2` to IRESS via the IOS+ service session.
 *
 * 2026-07-14 (Andre + Juan, 37:04): Andre confirmed the lifecycle for
 * an amend is "amend_pending → broker ack → WORKING/PARTIAL (preserving
 * fills)". Mirrors `cancelLiveOrder` 1:1 — same live-only gate, same
 * SSE delta + audit-row stamp pattern, same broker error envelope.
 *
 * Body shape:
 *   { orderId: string, account?: string, price?: number,
 *     volume?: number, tif?: "DAY" | "GTC" | "IOC" | "FOK",
 *     triggerPrice?: number }
 *
 * `OrderAmend2` is a partial-update: only the fields you pass are
 * changed at the broker. At least one of price / volume / tif /
 * triggerPrice must be supplied, else IRESS returns an error. The
 * server does NOT short-circuit that here — it forwards whatever the
 * BFF sent and surfaces the broker's verdict in the result envelope.
 */
async function amendLiveOrder(
  deps: HttpApiDeps,
  account: string,
  orderId: string,
  amend: {
    price?: number | null;
    volume?: number | null;
    tif?: "DAY" | "GTC" | "IOC" | "FOK" | null;
    triggerPrice?: number | null;
  },
): Promise<OrderAmendResult> {
  const baseError = (code: string, message: string): OrderAmendResult => ({
    ok: false,
    orderId,
    account,
    amendedAt: new Date().toISOString(),
    workerId: deps.env.workerId,
    iressMode: deps.env.iressMode,
    newPrice: amend.price ?? null,
    newVolume: amend.volume ?? null,
    newTif: amend.tif ?? null,
    error: { code, message },
  });
  const isLive = deps.env.iressMode === "live" || deps.env.iressMode === "wsdl-stub";
  if (!isLive) {
    return baseError("mock_mode", "Worker is running in mock mode; no live orders available");
  }
  if (
    amend.price == null &&
    amend.volume == null &&
    amend.tif == null &&
    amend.triggerPrice == null
  ) {
    return baseError(
      "no_fields",
      "Amend requires at least one of price / volume / tif / triggerPrice",
    );
  }
  try {
    const session = await deps.sessions.getSession();
    const iosKey = session.serviceKeys.IOSPlus;
    if (!iosKey) {
      return baseError("ios_unavailable", "IOSPlus service session not available; order pad not entitled");
    }
    const client = getIressClient("live");
    // 2026-07-15: build the wire-shape payload up front so the log
    // line below mirrors what the broker actually sees. OrderAmend2
    // expects the amendable fields inside a nested `<Order>` element
    // (`Documentation & Vision/iress-v4-docs/13-soap-examples/order-amend-2.request.xml`).
    // A flat `<Parameters><OrderNumber>...</OrderNumber><Volume>...</Volume></Parameters>`
    // envelope parses enough to return success but doesn't mutate the
    // order on Hermes — which is exactly what Andre observed earlier
    // today (the worker logged Volume=100 sent, Hermes confirmed
    // OrderNumber=1500152 with no ErrorNumber, but the order's volume
    // never changed at the broker).
    const orderObj: Record<string, unknown> = { OrderNumber: orderId };
    if (amend.price != null) orderObj.Price = amend.price;
    if (amend.volume != null) orderObj.Volume = amend.volume;
    if (amend.tif != null) orderObj.TimeInForce = amend.tif;
    if (amend.triggerPrice != null) orderObj.TriggerPrice = amend.triggerPrice;
    const sentParams: Record<string, unknown> = { Order: orderObj };
    const amendStartedAt = Date.now();
    console.info(
      `[iress-ingest/amend] OrderAmend2 request account=${account} orderNumber=${orderId} fields=${JSON.stringify(sentParams)}`,
    );
    let amendResult: { OrderNumber: string };
    try {
      amendResult = await client.orderAmend2({
        ServiceSessionKey: iosKey,
        OrderNumber: orderId,
        ...(amend.price != null ? { Price: amend.price } : {}),
        ...(amend.volume != null ? { Volume: amend.volume } : {}),
        ...(amend.tif != null ? { TimeInForce: amend.tif } : {}),
        ...(amend.triggerPrice != null ? { TriggerPrice: amend.triggerPrice } : {}),
      });
      const amendElapsed = Date.now() - amendStartedAt;
      console.info(
        `[iress-ingest/amend] OrderAmend2 success account=${account} orderNumber=${orderId} returned=${JSON.stringify(amendResult)} elapsedMs=${amendElapsed}`,
      );
    } catch (amendErr) {
      const amendElapsed = Date.now() - amendStartedAt;
      const iressCode =
        amendErr instanceof IressError ? amendErr.code : null;
      const iressDesc =
        amendErr instanceof IressError ? amendErr.message : null;
      console.error(
        `[iress-ingest/amend] OrderAmend2 FAILED account=${account} orderNumber=${orderId} sent=${JSON.stringify(sentParams)} errorCode=${iressCode ?? "—"} errorDesc=${iressDesc ?? String(amendErr)} elapsedMs=${amendElapsed}`,
      );
      throw amendErr;
    }
    const amendedAt = new Date().toISOString();
    // Stamp the audit row + publish the SSE delta so the desk sees
    // AMEND_PENDING immediately (Andre, 37:04). Same pattern as
    // cancelLiveOrder: read symbol / qty / filled / avgPx from the
    // existing audit row so the parent's symbol/qty never blanks
    // while the amend instruction is in-flight, then stamp the
    // payload with the new fields we sent to the broker.
    let amendedAuditId: string | null = null;
    let amendedSymbol: string | null = null;
    let amendedQty: number | null = null;
    let amendedFilled: number | null = null;
    let amendedAvgFillCents: number | null = null;
    let amendedPayload: Record<string, unknown> = {};
    if (deps.supabase) {
      try {
        const { data: existing } = await deps.supabase
          .from("oems_order_audit")
          .select("id, payload, symbol, quantity")
          .or(`order_id.eq.${orderId},payload->>iress_order_number.eq.${orderId}`)
          .limit(1);
        if (existing && existing.length > 0) {
          const ex = existing[0] as {
            id: string;
            payload: Record<string, unknown> | null;
            symbol: string | null;
            quantity: number | null;
          };
          amendedAuditId = ex.id;
          amendedPayload = (ex.payload ?? {}) as Record<string, unknown>;
          amendedSymbol = ex.symbol ?? null;
          amendedQty = typeof ex.quantity === "number" ? ex.quantity : null;
          const p = ex.payload ?? {};
          if (typeof p.filled === "number") amendedFilled = p.filled;
          if (typeof p.avgPx === "number") amendedAvgFillCents = Math.round(p.avgPx * 100);
        }
        const amendSummary = [
          amend.price != null ? `price=${amend.price}` : null,
          amend.volume != null ? `volume=${amend.volume}` : null,
          amend.tif != null ? `tif=${amend.tif}` : null,
          amend.triggerPrice != null ? `trigger=${amend.triggerPrice}` : null,
        ]
          .filter(Boolean)
          .join(", ");
        await deps.supabase
          .from("oems_order_audit")
          .update({
            // AMEND_PENDING (2026-07-14): Andre confirmed the lifecycle.
            // Flip to amend_pending so the UI shows the in-flight
            // instruction. The next poll (or a manual ack) writes a
            // WORKING/PARTIAL row which flips the UI back, preserving
            // any partial fills already on the book.
            status: "amend_pending",
            // MERGE payload (keep book_id/strategy/iress_order_number/fills so the
            // row stays in the book-scoped poll and the UI can reconcile); bump
            // updated_at. A bare payload here had the same clobber bug as cancel.
            payload: {
              ...amendedPayload,
              lastAction: `Amend sent (${amendSummary}) — awaiting broker acknowledgement`,
              lastActionAt: amendedAt,
              amend_pending: {
                price: amend.price ?? null,
                volume: amend.volume ?? null,
                tif: amend.tif ?? null,
                trigger_price: amend.triggerPrice ?? null,
                sent_at: amendedAt,
              },
            },
            updated_at: amendedAt,
          })
          .eq("order_id", orderId);
        await deps.supabase
          .from("oems_order_audit")
          .update({
            status: "amend_pending",
            payload: {
              ...amendedPayload,
              lastAction: `Amend sent (${amendSummary}) — awaiting broker acknowledgement`,
              lastActionAt: amendedAt,
              amend_pending: {
                price: amend.price ?? null,
                volume: amend.volume ?? null,
                tif: amend.tif ?? null,
                trigger_price: amend.triggerPrice ?? null,
                sent_at: amendedAt,
              },
            },
            updated_at: amendedAt,
          })
          .eq("payload->>iress_order_number", orderId);
      } catch {
        /* audit stamp is best-effort; the broker amend already succeeded */
      }

      try {
        uatExecutionHub.publish({
          iressOrderNumber: orderId,
          orderAuditId: amendedAuditId,
          state: "amend_pending",
          filled: amendedFilled ?? 0,
          avgFillPrice: amendedAvgFillCents != null ? amendedAvgFillCents / 100 : null,
          lastFillTimestamp: amendedAt,
          lastAction: `Amend sent (${[
            amend.price != null ? `price=${amend.price}` : null,
            amend.volume != null ? `volume=${amend.volume}` : null,
            amend.tif != null ? `tif=${amend.tif}` : null,
            amend.triggerPrice != null ? `trigger=${amend.triggerPrice}` : null,
          ]
            .filter(Boolean)
            .join(", ")}) — awaiting broker acknowledgement`,
          lastActionAt: amendedAt,
          // 2026-07-14: amend preserves fills. The hub forwards the
          // current fill + avgPx unchanged so the parent's % filled /
          // avg price never blanks during the in-flight amend. The
          // next poll (or a manual ack) flips the state to
          // WORKING / PARTIAL with the new price/volume applied.
          raw: {
            id: orderId,
            account,
            strategy: "",
            side: "BUY",
            symbol: amendedSymbol ?? "",
            isin: "",
            type: "LMT",
            tif: amend.tif ?? "DAY",
            destination: "JSE",
            qty: amendedQty ?? 0,
            filled: amendedFilled ?? 0,
            limit: amend.price ?? null,
            stop: amend.triggerPrice ?? null,
            avgPx: amendedAvgFillCents != null ? amendedAvgFillCents / 100 : null,
            vwap: amendedAvgFillCents != null ? amendedAvgFillCents / 100 : null,
            trader: "",
            ts: Date.parse(amendedAt) || Date.now(),
            state: "AMEND_PENDING" as OrderState,
            orderTag: "",
            slippageBps: null,
            arrivalMid: 0,
            brokerState: "ACTIVE",
            actionStatus: "Amend sent",
            internalOrderStatus: "Awaiting amend acknowledgement",
            stateDescription: "Amend instruction sent — awaiting broker acknowledgement",
            remainingVolume: amendedQty != null && amendedFilled != null ? amendedQty - amendedFilled : null,
            remainingValueCents: null,
            orderValueCents:
              amend.price != null && amendedQty != null ? Math.round(amend.price * amendedQty * 100) : null,
          },
          bookId: null,
          observedAt: amendedAt,
        });
      } catch (hubErr) {
        console.warn(`[iress-ingest] amend hub publish failed: ${String(hubErr)}`);
      }
    }
    return {
      ok: true,
      orderId,
      account,
      amendedAt,
      workerId: deps.env.workerId,
      iressMode: deps.env.iressMode,
      newPrice: amend.price ?? null,
      newVolume: amend.volume ?? null,
      newTif: amend.tif ?? null,
    };
  } catch (err) {
    if (isIressSessionDeadError(err) || (err instanceof IressError && err.code === 25001)) {
      deps.sessions.invalidate();
    }
    const message = err instanceof Error ? err.message : String(err);
    const code = err instanceof IressError ? `iress_${err.code}` : "amend_failed";
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
 * Run the orders-entitlement probe against the prod endpoint without
 * requiring an HTTP round-trip. Exported so the prod worker can also
 * run it on startup (`IRESS_DEBUG_ORDERS_PROBE=1`), which is the only
 * reliable way to see the result when the Railway public proxy 502s.
 *
 * Returns `{ status, body }` where `status` is the HTTP-shaped status
 * code the public probe would have used; `body` is the JSON envelope.
 */
export async function runOrdersEntitlementProbe(opts: {
  deps: HttpApiDeps;
  probePad: boolean;
  accountOverride?: string | null;
}): Promise<{ status: number; body: Record<string, unknown> }> {
  const { deps, probePad, accountOverride } = opts;
  const startedAt = Date.now();
  const prodEndpoint = marketDataBaseUrl();
  const iosServer = (process.env.IRESS_IOS_SERVER ?? "MINT_CT").trim() || "MINT_CT";
  const ipsServer = (process.env.IRESS_IPS_SERVER ?? "IPSAPI").trim() || "IPSAPI";
  const fixServer = (process.env.IRESS_FIX_SERVER ?? "FIXPLUSAPI").trim() || "FIXPLUSAPI";

  const isLive = deps.env.iressMode === "live" || deps.env.iressMode === "wsdl-stub";
  if (!isLive) {
    return {
      status: 503,
      body: {
        ok: false,
        status: 503,
        code: "iress_mode_not_live",
        error: `Cannot probe in iressMode=${deps.env.iressMode}; switch the worker to live`,
        iressMode: deps.env.iressMode,
      },
    };
  }

  let probeClient: ReturnType<typeof createLiveIressClient> | null = null;
  let probeSessionKey: string | null = null;
  const results: Record<
    string,
    {
      ok: boolean;
      errorNumber: number | null;
      errorDescription: string | null;
      serviceSessionKeyPrefix: string | null;
      elapsedMs: number;
    }
  > = {};

  try {
    const creds = getIressProdCredentialsFromEnv() ?? getIressCredentialsFromEnv();
    if (!creds.userName || !creds.password) {
      return {
        status: 503,
        body: {
          ok: false,
          status: 503,
          code: "iress_credentials_unconfigured",
          error: "IRESS_USERNAME / IRESS_PASSWORD not configured on this worker",
          endpoint: prodEndpoint,
        },
      };
    }
    probeClient = createLiveIressClient({ baseUrl: prodEndpoint });
    const applicationId = `Mint-OEMS-OrdersProbe-${deps.env.workerId}-${Date.now()}`;
    const sess = await probeClient.iressSessionStart({
      Locale: "en-ZA",
      ApplicationID: applicationId,
      ApplicationLabel: `Mint-OEMS-OrdersProbe`,
      UserName: creds.userName,
      CompanyName: creds.company ?? creds.userName.split("@").pop() ?? "",
      Password: creds.password,
    });
    if (!sess.IRESSSessionKey) {
      return {
        status: 502,
        body: {
          ok: false,
          status: 502,
          code: "session_start_failed",
          error: "IRESSSessionStart returned no session key on the prod endpoint",
          endpoint: prodEndpoint,
          applicationId,
        },
      };
    }
    probeSessionKey = sess.IRESSSessionKey;

    for (const target of [
      { Service: "IOSPlus" as IressService, Server: iosServer },
      { Service: "IPS" as IressService, Server: ipsServer },
      { Service: "FIXPlus" as IressService, Server: fixServer },
    ]) {
      const t0 = Date.now();
      try {
        const r = await probeClient.serviceSessionStart({
          IRESSSessionKey: probeSessionKey,
          Service: target.Service,
          Server: target.Server,
        });
        results[target.Service] = {
          ok: !!r.ServiceSessionKey,
          errorNumber: null,
          errorDescription: r.ServiceSessionKey ? null : "no ServiceSessionKey returned",
          serviceSessionKeyPrefix: r.ServiceSessionKey ? r.ServiceSessionKey.slice(0, 8) : null,
          elapsedMs: Date.now() - t0,
        };
        if (r.ServiceSessionKey) {
          try {
            await probeClient.serviceSessionEnd({
              ServiceSessionKey: r.ServiceSessionKey,
            });
          } catch {
            /* best-effort teardown */
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const code = err instanceof IressError ? err.code : null;
        results[target.Service] = {
          ok: false,
          errorNumber: code,
          errorDescription: msg,
          serviceSessionKeyPrefix: null,
          elapsedMs: Date.now() - t0,
        };
      }
    }

    let padProbe: {
      attempted: boolean;
      ok: boolean;
      accountCode: string | null;
      rowCount: number | null;
      errorNumber: number | null;
      errorDescription: string | null;
      elapsedMs: number | null;
    } = {
      attempted: false,
      ok: false,
      accountCode: null,
      rowCount: null,
      errorNumber: null,
      errorDescription: null,
      elapsedMs: null,
    };
    if (probePad) {
      const accountCode =
        accountOverride?.trim() ||
        deps.env.iressAccountCode.split(",")[0]?.trim() ||
        "";
      if (!accountCode) {
        padProbe = {
          ...padProbe,
          attempted: true,
          errorDescription:
            "no account code supplied (set IRESS_ACCOUNT_CODE or pass ?account=…)",
        };
      } else {
        padProbe = {
          attempted: true,
          ok: false,
          accountCode,
          rowCount: null,
          errorNumber: null,
          errorDescription:
            "OrderPadGetByAccount needs a live IOSPlus ServiceSessionKey (the probe releases each key after confirming entitlement); re-run with the orders loop active to verify the account-level probe path.",
          elapsedMs: null,
        };
      }
    }

    return {
      status: 200,
      body: {
        ok: true,
        endpoint: prodEndpoint,
        workerId: deps.env.workerId,
        applicationId,
        sessionKeyPrefix: probeSessionKey.slice(0, 8),
        services: results,
        padProbe,
        probeSummary: {
          iosplusEntitled: results.IOSPlus?.ok === true,
          ipsEntitled: results.IPS?.ok === true,
          fixplusEntitled: results.FIXPlus?.ok === true,
          allOrdersEntitled: results.IOSPlus?.ok === true,
        },
        elapsedMs: Date.now() - startedAt,
        probedAt: new Date().toISOString(),
        build: PROBE_BUILD,
        note:
          "ServiceSessionStart is entitlement-only — it does NOT place or amend orders. Each service key is released before this probe returns. Safe to call against the prod seat.",
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const code = err instanceof IressError ? err.code : null;
    return {
      status: 200,
      body: {
        ok: false,
        endpoint: prodEndpoint,
        workerId: deps.env.workerId,
        services: results,
        error: { code, message: msg },
        elapsedMs: Date.now() - startedAt,
        probedAt: new Date().toISOString(),
        build: PROBE_BUILD,
      },
    };
  } finally {
    if (probeSessionKey && probeClient) {
      try {
        await probeClient.iressSessionEnd({ IRESSSessionKey: probeSessionKey });
      } catch {
        /* best-effort teardown */
      }
    }
  }
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

  // SECURITY: checkAuth fails OPEN when WORKER_HTTP_TOKEN is unset (so an
  // auto-deploy that forgets the token never takes the order seat down). Emit a
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
      // Price history is MARKET DATA: read it from the PROD market-data seat
      // (getMarketDataSession), NEVER the CT/UAT order seat. When the split is
      // off or the prod seat is momentarily down, return empty so the BFF
      // (/api/history, /api/analysis) falls back to Yahoo — mirrors the
      // news/quotes/timeseries handlers. History is therefore PROD-or-Yahoo,
      // never UAT.
      const md = await getMarketDataSession();
      if (!md) {
        send(res, 200, { ok: false, sym, points: [], reason: "market_data_prod_unavailable" });
        return;
      }
      const res2 = await md.client.timeSeriesGet2({
        Header: { SessionKey: md.sessionKey, RequestID: newRequestID(`hist-${sym}`), Timeout: 30 },
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
      if (isIressSessionDeadError(err)) invalidateMarketDataSession();
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

  // 2026-07-14: amend route (mirrors /orders/cancel). Body:
  //   { orderId, account?, price?, volume?, tif?, triggerPrice? }
  // At least one of price / volume / tif / triggerPrice must be set;
  // the worker forwards whatever the BFF sent to OrderAmend2 and
  // surfaces the broker's verdict in the result envelope.
  if (req.method === "POST" && path === "/orders/amend") {
    let amendBody: unknown;
    try {
      amendBody = await readBodyJson(req);
    } catch (err) {
      sendError(res, 400, "bad_request", (err as Error).message);
      return;
    }
    if (!amendBody || typeof amendBody !== "object") {
      sendError(
        res,
        400,
        "bad_request",
        "Body must be JSON with `orderId` and at least one of price / volume / tif / triggerPrice",
      );
      return;
    }
    const ab = amendBody as Record<string, unknown>;
    const orderIdRaw = ab["orderId"];
    const orderId = typeof orderIdRaw === "string" ? orderIdRaw.trim() : "";
    if (!orderId) {
      sendError(res, 400, "bad_request", "`orderId` is required");
      return;
    }
    const accountRaw = ab["account"];
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
    const numOrNull = (v: unknown): number | null => {
      if (v == null) return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };
    const tifRaw = typeof ab["tif"] === "string" ? (ab["tif"] as string).trim().toUpperCase() : null;
    const tif: "DAY" | "GTC" | "IOC" | "FOK" | null =
      tifRaw === "DAY" || tifRaw === "GTC" || tifRaw === "IOC" || tifRaw === "FOK" ? tifRaw : null;
    if (typeof ab["tif"] === "string" && tif == null) {
      sendError(res, 400, "bad_request", "`tif` must be one of DAY / GTC / IOC / FOK");
      return;
    }
    const amend = {
      price: numOrNull(ab["price"]),
      volume: numOrNull(ab["volume"]),
      tif,
      triggerPrice: numOrNull(ab["triggerPrice"]),
    };
    const amendResult = await amendLiveOrder(deps, account, orderId, amend);
    send(res, 200, amendResult);
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
   * `GET /debug/news-vendor-probe` — one-shot `NewsHeadlineGet` verifier.
   *
   * Mirrors `/debug/timeseries-probe`'s shape but uses GET + query string
   * (the only call site is the BFF passthrough / a curl from the operator,
   * so the URL-as-config ergonomics of GET win over the POST body for a
   * probe).
   *
   * Query params (all optional):
   *   - `vendor`       default `"SENSD"` (the CT/UAT vendor code). The
   *                    prod-side BFF default is `"SENS"` (real-time);
   *                    when the prod worker is online, the BFF forwards
   *                    `SENS` and the worker auto-falls-back to
   *                    `"SENSD"` (delayed) on 25010 / 25018 entitlement
   *                    faults.
   *   - `dateFrom`     ISO-naive `YYYY-MM-DDTHH:MM:SS` (no `Z`).
   *                    Default: today 00:00:00 UTC.
   *   - `dateTo`       ISO-naive `YYYY-MM-DDTHH:MM:SS`. Default:
   *                    today 23:59:59 UTC.
   *   - `pageSize`     default 50, capped at 1000 (CT max)
   *   - `timeout`      default 25, capped at 25 (CT ceiling)
   *   - `includeBody`  "1" to include a 200-char preview of each story body
   *   - `symbol`       optional per-symbol filter (`SecurityCode`).
   *                    Forwarded to `NewsHeadlineGet.SecurityCode` so the
   *                    BFF / UI can target a single instrument. Andre's
   *                    WSDL browser (2026-07-22) shows the prod build
   *                    exposes a `SecurityCode` column on the row grid;
   *                    if the prod build doesn't honour the param, the
   *                    worker falls back to vendor-broadcast (today's
   *                    effective behaviour) and surfaces the ignored
   *                    param in the response metadata.
   *   - `vendorCatalog` "1" to also surface the entitled vendor catalog
   *                    persisted by the prod worker (per the 2026-07-22
   *                    `news_vendor_catalog` plan).
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
    const vendorRaw = url.searchParams.get("vendor") ?? "SENSD";
    const vendor = vendorRaw.trim();
    if (!vendor) {
      sendError(res, 400, "bad_request", "`vendor` query param required (e.g. ?vendor=SENSD)");
      return;
    }
    const today = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const defaultStart = `${today.getUTCFullYear()}-${pad(today.getUTCMonth() + 1)}-${pad(today.getUTCDate())}T00:00:00`;
    const defaultEnd = `${today.getUTCFullYear()}-${pad(today.getUTCMonth() + 1)}-${pad(today.getUTCDate())}T23:59:59`;
    const dateTimeStart = url.searchParams.get("dateFrom")?.trim() || defaultStart;
    const dateTimeEnd = url.searchParams.get("dateTo")?.trim() || defaultEnd;
    const pageSizeRaw = Number(url.searchParams.get("pageSize") ?? "50");
    const pageSize = Number.isFinite(pageSizeRaw) ? Math.min(1000, Math.max(1, Math.trunc(pageSizeRaw))) : 50;
    const timeoutRaw = Number(url.searchParams.get("timeout") ?? "25");
    const timeout = Number.isFinite(timeoutRaw) ? Math.min(25, Math.max(1, Math.trunc(timeoutRaw))) : 25;
    const includeBody = url.searchParams.get("includeBody") === "1";
    const symbol = url.searchParams.get("symbol")?.trim() ?? "";
    const includeCatalog = url.searchParams.get("vendorCatalog") === "1";
    const result = await probeNewsVendor(
      deps,
      vendor,
      dateTimeStart,
      dateTimeEnd,
      pageSize,
      timeout,
      includeBody,
      symbol,
    );
    // When `?vendorCatalog=1`, attach the most recent persisted catalog
    // marker row so the UI can render the entitled-vendor dropdown
    // without a second round-trip. Read from `news_item_c` directly —
    // no Supabase realtime subscription needed.
    let vendorCatalog: Array<{ vendorCode: string; vendorDescription: string }> | null = null;
    if (includeCatalog && deps.supabase) {
      try {
        const { data } = await deps.supabase
          .from("news_item_c")
          .select("payload")
          .eq("source", "__catalog__")
          .order("ingested_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        const cat = (data?.payload as { scope?: { vendor_catalog?: unknown } } | null)
          ?.scope?.vendor_catalog;
        if (Array.isArray(cat)) {
          vendorCatalog = cat
            .filter(
              (r): r is { vendorCode: string; vendorDescription: string } =>
                typeof r === "object" &&
                r !== null &&
                typeof (r as { vendorCode?: unknown }).vendorCode === "string" &&
                typeof (r as { vendorDescription?: unknown }).vendorDescription === "string",
            )
            .map((r) => ({
              vendorCode: r.vendorCode,
              vendorDescription: r.vendorDescription,
            }));
        }
      } catch {
        /* best-effort */
      }
    }
    send(res, 200, {
      ...result,
      ...(symbol ? { symbolFilterRequested: symbol } : {}),
      ...(vendorCatalog !== null ? { vendorCatalog } : {}),
    });
    return;
  }

  // -----------------------------------------------------------------------
  // /debug/orders-entitlement-probe — operator diagnostic for the
  // prod→CT cutover. Read-only + non-ordering: opens a fresh IRESS wire
  // session against the prod endpoint (no shared state with the prod
  // market-data session), attempts `ServiceSessionStart` for IOSPlus /
  // IPS / FIXPlus, optionally calls `OrderPadGetByAccount` when
  // `IRESS_ACCOUNT_CODE` is set, and tears everything down before
  // returning. NEVER places or amends an order.
  //
  // Purpose: confirm the prod seat actually carries the orders
  // entitlement (CT-seat entitlement does not auto-provision on prod).
  // Without this probe, the UAT→prod cutover would silently break the
  // blotter / new-order dialog the moment we stop the CT worker.
  //
  // Query params:
  //   ?probePad=1   additionally call OrderPadGetByAccount against the
  //                  account code in `IRESS_ACCOUNT_CODE` (the comma-split
  //                  first value, mirroring the /orders handler). Off by
  //                  default — only enabled when an operator wants to
  //                  verify a real prod account before cutover.
  // -----------------------------------------------------------------------
  if (req.method === "GET" && path === "/debug/orders-entitlement-probe") {
    const result = await runOrdersEntitlementProbe({
      deps,
      probePad: url.searchParams.get("probePad") === "1",
      accountOverride: url.searchParams.get("account") ?? null,
    });
    send(res, result.status ?? 200, result.body);
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
    // Optionally run the probe on the PROD market-data session + endpoint (the
    // split's prod side) instead of the CT/UAT orders session. Read-only: this
    // lets us inspect raw PricingQuoteGet fields and NewsVendorGet parameters
    // against REAL prod data (e.g. confirm the JSE cents-vs-Rands convention, or
    // test whether SENS needs a From/To/Category param). Prod market data only
    // uses the iress header (no service session), so headerKind=service is ignored.
    const useMarketData = b["useMarketData"] === true || b["useMarketData"] === "1";
    const started = Date.now();
    try {
      const session = await deps.sessions.getSession();
      const md = useMarketData ? await getMarketDataSession() : null;
      if (useMarketData && !md) {
        sendError(
          res,
          503,
          "market_data_session_down",
          "PROD market-data session is not up (check IRESS_MARKET_DATA_PROD + the seat). Cannot run a useMarketData probe.",
        );
        return;
      }
      const probeSessionKey = md ? md.sessionKey : session.iressSessionKey;
      // Placeholder substitution so we can probe putting the live session key in
      // <Parameters> (some V4 methods read it there, not just the header):
      //   "$IRESS_SESSION_KEY" → the live IRESSSessionKey (prod key when useMarketData)
      //   "$SERVICE_KEY:IOSPlus" → the cached IOS+ ServiceSessionKey (if any)
      for (const k of Object.keys(parameters)) {
        const v = parameters[k];
        if (v === "$IRESS_SESSION_KEY") parameters[k] = probeSessionKey;
        else if (typeof v === "string" && v.startsWith("$SERVICE_KEY:")) {
          parameters[k] = session.serviceKeys[v.slice("$SERVICE_KEY:".length) as IressService] ?? "";
        }
      }
      const transport = createSoapTransport({
        baseUrl: md
          ? marketDataBaseUrl()
          : (process.env.IRESS_BASE_URL ?? "https://webservices-ct.iress.co.za/v4"),
      });
      const serviceKey =
        !md && headerKind === "service" && typeof b["service"] === "string"
          ? session.serviceKeys[b["service"] as IressService]
          : undefined;
      const header = makeHeader(
        !md && headerKind === "service"
          ? { serviceSessionKey: serviceKey, requestID: newRequestID("raw"), timeout, waitForResponse: true }
          : {
              sessionKey: probeSessionKey,
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

  if (path === "/uat/send-to-market" || path === "/uat/preflight" || path === "/uat/execution-stream" || path === "/uat/status") {
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

  if (req.method === "POST" && path === "/uat/preflight") {
    // Pure read-only pre-trade gate. The BFF calls this BEFORE writing
    // the audit row so a blocked verdict never creates a phantom `working`
    // row that reserves quantity against the next corrected order.
    //
    // 2026-07-20: ships with the OEMS guardrail + force-correction refactor.
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
        "Body must be JSON with `account_code`, `symbol`, `side`, `qty`",
      );
      return;
    }
    const b = body as Record<string, unknown>;
    const accountCode =
      typeof b["account_code"] === "string" && (b["account_code"] as string).trim()
        ? (b["account_code"] as string).trim()
        : (deps.env.uatAccountCode ?? "");
    const symbol =
      typeof b["symbol"] === "string" ? (b["symbol"] as string).trim() : "";
    const sideRaw = String(b["side"] ?? "buy").toLowerCase();
    const side: 1 | 2 = sideRaw === "sell" ? 2 : 1;
    const qty = Number(b["qty"]);
    const priceCentsRaw = b["price_cents"];
    const priceCents =
      priceCentsRaw != null && Number.isFinite(Number(priceCentsRaw)) && Number(priceCentsRaw) > 0
        ? Math.round(Number(priceCentsRaw))
        : null;

    if (!accountCode) {
      sendError(res, 400, "bad_request", "`account_code` (or IRESS_UAT_ACCOUNT_CODE) is required");
      return;
    }
    if (!symbol) {
      sendError(res, 400, "bad_request", "`symbol` is required");
      return;
    }
    if (!Number.isFinite(qty) || qty <= 0) {
      sendError(res, 400, "bad_request", "`qty` must be a positive number");
      return;
    }

    const guard = await runUatPreflight(deps, {
      accountCode,
      symbol,
      side,
      qty: Math.floor(qty),
      priceCents,
      excludeAuditId:
        typeof b["exclude_audit_id"] === "string"
          ? (b["exclude_audit_id"] as string)
          : undefined,
      arrivalMidRands:
        Number(b["arrival_mid_rands"]) > 0 ? Number(b["arrival_mid_rands"]) : null,
    });

    if (guard.ok) {
      send(res, 200, {
        ok: true,
        verdict: "pass",
        code: "pass",
        message: guard.message,
        sell: guard.sell,
        cash: guard.cash,
        account_code: accountCode,
        symbol,
        side: sideRaw === "sell" ? "sell" : "buy",
        qty: Math.floor(qty),
      });
      return;
    }
    send(res, guard.status, {
      ok: false,
      status: guard.status,
      verdict:
        guard.code === "naked_short_blocked"
          ? "blocked_naked_short"
          : guard.code === "insufficient_cash_blocked"
            ? "blocked_insufficient_cash"
            : "blocked_unverifiable",
      code: guard.code,
      message: guard.message,
      sell: guard.sell,
      cash: guard.cash,
      account_code: accountCode,
      symbol,
      side: sideRaw === "sell" ? "sell" : "buy",
      qty: Math.floor(qty),
    });
    return;
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
  // "working" | "rejected" | "failed":
  //   - working  : OrderCreate3 returned OrderNumber, no ErrorNumber
  //   - rejected : OrderCreate3 returned non-zero ErrorNumber (broker
  //                validation reject — pre-routing)
  //   - failed   : transport-level failure that the OrderTag lookup
  //                could not recover (network down, kicked session,
  //                venue unavailable). 2026-07-14 (Andre test).
  //                Distinct from REJECTED — REJECTED is pre-routing
  //                validation, FAILED is post-routing transport.
  orderCreateStatus: "working" | "rejected" | "failed";
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
  // from raw Hermes fields. 2026-07-14: extend with the FAILED branch so
  // transport-level failures land with the actual broker / network error
  // text instead of a generic "OrderCreate3 failed".
  const lastAction = (() => {
    if (orderCreateStatus === "rejected") {
      return `Rejected (${errorNumber ?? "?"}: ${errorDescription ?? "no detail"})`;
    }
    if (orderCreateStatus === "failed") {
      return `Failed (${errorNumber ?? "transport"}: ${errorDescription ?? "no detail"})`;
    }
    return "Submitted to IRESS — awaiting broker acknowledgement";
  })();
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
    const updateShape: Record<string, unknown> = {
      payload: newPayload,
      result_payload: newResult,
      // 2026-07-14: stamp FAILED on transport-level failure. The BFF
      // status-code stays 502 (transport-failed), but the audit row +
      // SSE delta immediately surface FAILED so the OEMS UI's State
      // chip flips off "Pending" instead of getting stuck.
      status:
        orderCreateStatus === "rejected"
          ? "rejected"
          : orderCreateStatus === "failed"
            ? "failed"
            : "pending_ack",
      updated_at: stampedAt,
    };
    // 2026-07-15: collapse the BFF seed + the worker poll row into
    // the same OrderNumber-grouped bucket. Previously the BFF seed
    // sat at `order_id = OB-…` (a strategy-tag the BFF minted) and
    // the worker poll sat at `order_id = 1500150` (the IRESS
    // OrderNumber). The grouping-by-order_id on the UI saw two
    // distinct buckets — the parent + child ended up as adjacent
    // rows on screen instead of one expandable entry. We now
    // overwrite `order_id` to the IRESS OrderNumber once it's known.
    // The original seed lives on in `payload.seed_order_id` for audit
    // back-reference and `payload.iress_order_number` was already
    // populated above.
    if (iressOrderNumber) {
      const seedOrderId =
        typeof audit.order_id === "string" && audit.order_id.length > 0
          ? audit.order_id
          : null;
      if (seedOrderId && !payloadObj.seed_order_id) {
        newPayload.seed_order_id = seedOrderId;
      }
      // Keep the BFF seed's original OB-… order_id OUT of the
      // collision — overwrite to the IRESS OrderNumber so the
      // grouping key lines up with the worker poll row.
      updateShape.order_id = iressOrderNumber;
    }
    const { error: writeErrDb } = await db
      .from("oems_order_audit")
      .update(updateShape)
      .eq("id", audit.id);
    if (writeErrDb) writeErr = writeErrDb.message;
  }

  // Hermes lifecycle publish.
  const initialHubState: OrderState =
    orderCreateStatus === "rejected"
      ? "REJECTED"
      : orderCreateStatus === "failed"
        ? "FAILED"
        : "PENDING_ACK";
  // 2026-07-13 — Transcript gap #1 + #2 (23:40 / 26:21): carry the
  // lastAction one-liner AND the IRESS error fields in the SSE delta
  // so the UI's new Action + Error columns update without a poll
  // cycle.
  const lastActionSummary =
    orderCreateStatus === "rejected"
      ? `Rejected (${errorNumber ?? "?"}: ${errorDescription ?? "no detail"})`
      : orderCreateStatus === "failed"
        ? `Failed (${errorNumber ?? "transport"}: ${errorDescription ?? "no detail"})`
        : "Submitted to IRESS — awaiting broker acknowledgement";
  uatExecutionHub.publish({
    iressOrderNumber: iressOrderNumber ?? "",
    orderAuditId: audit.id,
    state:
      orderCreateStatus === "rejected"
        ? "rejected"
        : orderCreateStatus === "failed"
          ? "failed"
          : "pending_ack",
    filled: 0,
    avgFillPrice: priceRands ?? null,
    lastFillTimestamp: stampedAt,
    lastAction: lastActionSummary,
    lastActionAt: stampedAt,
    iressErrorNumber:
      orderCreateStatus === "rejected" || orderCreateStatus === "failed"
        ? errorNumber ?? null
        : null,
    iressErrorDescription:
      orderCreateStatus === "rejected" || orderCreateStatus === "failed"
        ? errorDescription ?? null
        : null,
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
      // FAILED orders are not on the book (parked by the broker),
      // so surface INACTIVE. ACTIVE / UNKNOWN only when IRESS has
      // actually accepted the order.
      brokerState:
        orderCreateStatus === "failed"
          ? "INACTIVE"
          : iressOrderNumber
            ? "ACTIVE"
            : null,
      actionStatus: null,
      internalOrderStatus:
        orderCreateStatus === "rejected"
          ? "Rejected"
          : orderCreateStatus === "failed"
            ? "Failed"
            : "Pending",
      stateDescription:
        orderCreateStatus === "rejected"
          ? (errorDescription ?? "OrderCreate3 returned non-zero error")
          : orderCreateStatus === "failed"
            ? (errorDescription ?? "OrderCreate3 transport failure")
            : "Submitted to IRESS — awaiting broker acknowledgement",
      remainingVolume:
        orderCreateStatus === "rejected" || orderCreateStatus === "failed"
          ? 0
          : qty,
      remainingValueCents:
        orderCreateStatus === "rejected" ||
        orderCreateStatus === "failed" ||
        priceRands == null
          ? null
          : Math.round(priceRands * qty * 100),
      orderValueCents: priceRands != null ? Math.round(priceRands * qty * 100) : null,
      iressErrorNumber: errorNumber ?? null,
      iressErrorDescription: errorDescription ?? null,
    },
    bookId: typeof payloadObj.book_id === "string" ? (payloadObj.book_id as string) : null,
    observedAt: stampedAt,
  });

  return { stampedAt, writeErr };
}

/**
 * Shared preflight computation, called by both `POST /uat/preflight` (the
 * BFF pre-submit gate) AND `uatSendToMarket` (the worker-side guard right
 * before `OrderCreate3`). Returns the same shape both call sites consume,
 * so the BFF and the worker never disagree on what's available.
 *
 * Extracted from `uatSendToMarket` on 2026-07-20 as part of the OEMS
 * guardrail + force-correction refactor — the previous placement
 * (audit-row-INSERT-then-guard) left rejected orders as ghost `working`
 * rows that reserved their full quantity against the next corrected order.
 */
async function runUatPreflight(
  deps: HttpApiDeps,
  opts: {
    accountCode: string;
    symbol: string;
    side: 1 | 2;
    qty: number;
    priceCents: number | null;
    excludeAuditId?: string;
    /** For market orders, derive RANDS value from `arrivalMid` if available. */
    arrivalMidRands?: number | null;
  },
): Promise<
  | { ok: true; verdict: "pass"; sell?: SellAvailability; cash?: CashAvailability; message: string }
  | {
      ok: false;
      status: number;
      code:
        | "sell_guard_unavailable"
        | "buy_guard_unavailable"
        | "naked_short_blocked"
        | "insufficient_cash_blocked";
      message: string;
      sell?: SellAvailability;
      cash?: CashAvailability;
    }
> {
  const db = deps.supabase;
  if (!db) {
    return {
      ok: false,
      status: 503,
      code: "sell_guard_unavailable",
      message: "Worker has no Supabase client",
    };
  }

  if (opts.side === 2) {
    let avail;
    try {
      avail = await availableToSell(db, opts.accountCode, opts.symbol, opts.excludeAuditId);
    } catch (guardErr) {
      const m = guardErr instanceof Error ? guardErr.message : String(guardErr);
      console.warn(
        `[iress-ingest/uat] sell guard could not verify holdings for ${opts.symbol} on ${opts.accountCode}: ${m}`,
      );
      return {
        ok: false,
        status: 422,
        code: "sell_guard_unavailable",
        message: `Sell blocked: could not verify holdings for ${opts.symbol} on account ${opts.accountCode} (${m}). Try again.`,
      };
    }
    if (opts.qty > avail.available) {
      console.warn(
        `[iress-ingest/uat] NAKED-SHORT BLOCKED ${opts.symbol} sell ${opts.qty} > available ${avail.available} on ${opts.accountCode} (held ${avail.held}, inflight ${avail.inflightSells}, src ${avail.source})`,
      );
      return {
        ok: false,
        status: 422,
        code: "naked_short_blocked",
        message: `Sell blocked: ${opts.qty} ${opts.symbol} exceeds available-to-sell ${avail.available} on account ${opts.accountCode} — held ${avail.held}, ${avail.inflightSells} in open sells (${avail.note}). We only sell stock we own.`,
        sell: avail,
      };
    }
    return {
      ok: true,
      verdict: "pass",
      sell: avail,
      message: `Sell guard OK: ${opts.qty} ${opts.symbol} <= available ${avail.available} on account ${opts.accountCode} (${avail.note}).`,
    };
  }

  // BUY side
  const capEnv = process.env.IRESS_BUY_GUARD_CAP_RANDS;
  const capRands =
    capEnv != null && capEnv !== "" && Number.isFinite(Number(capEnv)) ? Number(capEnv) : null;
  const buffer = Number(process.env.IRESS_MARKET_BUY_BUFFER ?? "1.02");
  let cash;
  try {
    cash = await availableToBuy(db, opts.accountCode, opts.excludeAuditId, {
      fallbackCapRands: capRands,
    });
  } catch (guardErr) {
    const m = guardErr instanceof Error ? guardErr.message : String(guardErr);
    console.warn(
      `[iress-ingest/uat] buy guard could not verify cash for ${opts.symbol} on ${opts.accountCode}: ${m}`,
    );
    return {
      ok: false,
      status: 422,
      code: "buy_guard_unavailable",
      message: `Buy blocked: could not verify cash for account ${opts.accountCode} (${m}). Try again.`,
    };
  }
  const priceRands =
    opts.priceCents != null ? opts.priceCents / 100 : undefined;
  const orderValue =
    priceRands != null
      ? priceRands * opts.qty
      : opts.arrivalMidRands != null
        ? opts.arrivalMidRands * opts.qty * buffer
        : null;
  if (cash.available != null && orderValue != null && orderValue > cash.available) {
    console.warn(
      `[iress-ingest/uat] INSUFFICIENT-CASH BLOCKED ${opts.symbol} buy value ${orderValue.toFixed(2)} > available ${cash.available.toFixed(2)} on ${opts.accountCode} (cash ${cash.cash}, inflight ${cash.inflightBuys.toFixed(2)}, src ${cash.source})`,
    );
    return {
      ok: false,
      status: 422,
      code: "insufficient_cash_blocked",
      message: `Buy blocked: ${opts.symbol} value R${orderValue.toFixed(2)} exceeds available cash R${cash.available.toFixed(2)} on account ${opts.accountCode} — ${cash.note}. We only buy within available cash.`,
      cash,
    };
  }
  return {
    ok: true,
    verdict: "pass",
    cash,
    message: `Buy guard ${cash.available == null ? "ADVISORY (no cash source)" : "OK"} ${opts.symbol} value ${orderValue?.toFixed(2) ?? "?"} <= available ${cash.available?.toFixed(2) ?? "∞"} on account ${opts.accountCode} (src ${cash.source}).`,
  };
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
  // 2026-07-23: market orders only, for now — audit.price_cents used to
  // silently make EVERY order a LMT at that price (mint always supplies a
  // reference price, so a true MKT order never actually happened). Force
  // MKT and omit Price from the IRESS order entirely; price_cents is still
  // stored on the audit row for display/reference (expected-fill, arrival
  // mid), it's just no longer sent to IRESS as a limit price. Revert this
  // one line to restore LMT support once an explicit order_type choice is
  // wired through from the caller.
  const orderType = "MKT" as const;
  const priceRands = undefined;
  const exchange = "JSE";
  const tif = "DAY";

  // ── PRE-TRADE NAKED-SHORT + CASH GUARD ─────────────────────────────────────
  // 2026-07-20: shared with the new `POST /uat/preflight` endpoint via
  // `runUatPreflight()` — both paths compute the exact same verdict so the
  // BFF pre-submit gate and the worker submit-time gate can never disagree.
  // (See the comment on `runUatPreflight` above for the rationale.)
  const guard = await runUatPreflight(deps, {
    accountCode,
    symbol,
    side: side as 1 | 2,
    qty,
    priceCents: audit.price_cents ?? null,
    excludeAuditId: audit.id,
    arrivalMidRands:
      Number((audit.result_payload as { arrivalMid?: number } | null)?.arrivalMid) || null,
  });
  if (!guard.ok) {
    return {
      ok: false,
      status: guard.status,
      code: guard.code,
      message: guard.message,
      extra: { sell: guard.sell, cash: guard.cash },
    };
  }

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
      // 2026-07-14 (Andre test): when transport fails and the OrderTag
      // lookup can't recover the broker-assigned OrderNumber, stamp the
      // audit row + publish a FAILED SSE delta so the OEMS UI flips off
      // "Pending" immediately. Previously the row was left on the
      // BFF-seeded "working" forever — operators saw an order that was
      // silently dead, with no error surfaced.
      try {
        await stampAfterOrderCreate3({
          deps,
          audit,
          orderCreateStatus: "failed",
          errorNumber: code ?? undefined,
          errorDescription: msg,
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
      } catch (stampErr) {
        const stampMsg = stampErr instanceof Error ? stampErr.message : String(stampErr);
        console.warn(`[iress-ingest] FAILED-stamp after transport error failed: ${stampMsg}`);
      }
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
