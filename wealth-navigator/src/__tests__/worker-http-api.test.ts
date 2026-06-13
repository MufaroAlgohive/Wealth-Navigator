import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerResponse, IncomingMessage } from "node:http";

import { IressError } from "@/lib/iress/errors";
import type { Order } from "@/types/iress";

const ORIGINAL_ENV = { ...process.env };
const KEYS = [
  "WORKER_HTTP_PORT",
  "WORKER_HTTP_HOST",
  "WORKER_HTTP_TOKEN",
  "WORKER_HTTP_DISABLED",
  "IRESS_MODE",
  "IRESS_ACCOUNT_CODE",
  "IRESS_WATCHLIST_SYMBOLS",
];

function clearEnv() {
  for (const k of KEYS) delete process.env[k];
}

/** Mutable holder so the hoisted `vi.mock` factory can read per-test
 *  client shapes. Set inside each `it` before the dynamic import. */
const iressClientHolder: { current: unknown } = { current: null };

vi.mock("@/lib/iress/index", () => ({
  getIressClient: () => iressClientHolder.current,
  iressConfig: { mode: "live" },
}));

afterEach(() => {
  clearEnv();
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
  iressClientHolder.current = null;
});

interface FakeRes {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  headersSent: boolean;
  writeHead: (status: number, headers?: Record<string, string>) => void;
  write: (chunk: string) => void;
  end: (chunk?: string) => void;
  [k: string]: unknown;
}

function fakeRes(): FakeRes {
  const res: FakeRes = {
    statusCode: 0,
    headers: {},
    body: "",
    headersSent: false,
    writeHead(status, headers) {
      this.statusCode = status;
      this.headersSent = true;
      this.headers = { ...this.headers, ...(headers ?? {}) };
    },
    write(chunk) {
      this.body += chunk;
    },
    end(chunk) {
      if (chunk) this.body += chunk;
    },
  };
  return res;
}

function fakeReq(opts: { method?: string; url?: string; headers?: Record<string, string> } = {}): import("node:http").IncomingMessage {
  const listeners: Record<string, Array<() => void>> = {};
  const req = {
    url: opts.url ?? "/",
    method: opts.method ?? "GET",
    headers: { ...(opts.headers ?? {}) },
    on(event: string, cb: () => void) {
      (listeners[event] ??= []).push(cb);
      return req;
    },
  } as unknown as import("node:http").IncomingMessage;
  return req;
}

function buildEnv(overrides: Record<string, string | number | boolean | string[]> = {}): import("../../workers/iress-ingest/src/env").WorkerEnv {
  const watchlistSymbols = ["NPN", "PRX"];
  return {
    workerId: "iress-ingest-test",
    iressMode: "live",
    dryRun: true,
    allowWrites: false,
    heartbeatSec: 30,
    quoteIntervalSec: 15,
    orderPollIntervalSec: 60,
    watchlistSymbols,
    watchlistEntries: watchlistSymbols.map((s) => ({ symbol: s, exchange: "JSE", kind: "equity" as const })),
    watchlistExchanges: {},
    fxExchange: "FX",
    moneyMarketExchange: "MM",
    instrumentSync: false,
    supabaseUrl: "",
    supabaseServiceKey: "",
    iressAccountCode: "ACC1,ACC2",
    applicationLabel: "Mint-OEMS-Worker-test",
    defaultExchange: "JSE",
    ...overrides,
  };
}

function makeMockSession(): import("../../workers/iress-ingest/src/session").WorkerMintSession {
  return {
    iressSessionKey: "KEY-X@WebSer…@WebServicesCT",
    applicationId: "Mint-OEMS-Worker-test",
    sessionTimeout: 120,
    expiresAt: Date.now() + 60 * 60_000,
    serviceKeys: { IOSPlus: "IOS-KEY" },
    startedAt: Date.now(),
  };
}

describe("worker http-api /health", () => {
  beforeEach(clearEnv);

  it("returns the worker session snapshot with no IRESS call", async () => {
    const { handleRequest } = await import("../../workers/iress-ingest/src/http-api");
    const session = makeMockSession();
    const sessions = {
      peekSession: () => session,
      getSession: async () => session,
      invalidate: () => undefined,
    } as never;
    const req = fakeReq({ url: "/health" });
    const res = fakeRes();
    await handleRequest(req, res as unknown as ServerResponse<IncomingMessage>, {
      env: buildEnv(),
      sessions,
      supabase: null,
    }, () => undefined, undefined);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.workerId).toBe("iress-ingest-test");
    expect(body.iressMode).toBe("live");
    expect(body.session.cached).toBe(true);
    expect(body.session.applicationId).toBe("Mint-OEMS-Worker-test");
    expect(body.session.services).toEqual(["IOSPlus"]);
    expect(body.accounts).toEqual(["ACC1", "ACC2"]);
    expect(body.watchlistSize).toBe(2);
    expect(typeof body.uptimeSec).toBe("number");
  });

  it("returns 401 when WORKER_HTTP_TOKEN is set and Authorization is missing", async () => {
    const { handleRequest } = await import("../../workers/iress-ingest/src/http-api");
    const req = fakeReq({ url: "/health" });
    const res = fakeRes();
    await handleRequest(req, res as unknown as ServerResponse<IncomingMessage>, {
      env: buildEnv(),
      sessions: { peekSession: () => null, invalidate: () => undefined } as never,
      supabase: null,
    }, () => undefined, "secret-token");
    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.code).toBe("unauthorized");
  });

  it("accepts Bearer <token> in Authorization", async () => {
    const { handleRequest } = await import("../../workers/iress-ingest/src/http-api");
    const req = fakeReq({ url: "/health", headers: { authorization: "Bearer secret-token" } });
    const res = fakeRes();
    await handleRequest(req, res as unknown as ServerResponse<IncomingMessage>, {
      env: buildEnv(),
      sessions: { peekSession: () => null, invalidate: () => undefined } as never,
      supabase: null,
    }, () => undefined, "secret-token");
    expect(res.statusCode).toBe(200);
  });

  it("accepts X-Worker-Token for SSE clients that can't set Authorization", async () => {
    const { handleRequest } = await import("../../workers/iress-ingest/src/http-api");
    const req = fakeReq({ url: "/health", headers: { "x-worker-token": "secret-token" } });
    const res = fakeRes();
    await handleRequest(req, res as unknown as ServerResponse<IncomingMessage>, {
      env: buildEnv(),
      sessions: { peekSession: () => null, invalidate: () => undefined } as never,
      supabase: null,
    }, () => undefined, "secret-token");
    expect(res.statusCode).toBe(200);
  });
});

describe("worker http-api /orders", () => {
  beforeEach(clearEnv);

  it("returns 503 account_not_configured when no account param and no IRESS_ACCOUNT_CODE", async () => {
    const { handleRequest } = await import("../../workers/iress-ingest/src/http-api");
    const req = fakeReq({ url: "/orders" });
    const res = fakeRes();
    await handleRequest(req, res as unknown as ServerResponse<IncomingMessage>, {
      env: buildEnv({ iressAccountCode: "" }),
      sessions: { invalidate: () => undefined } as never,
      supabase: null,
    }, () => undefined, undefined);
    expect(res.statusCode).toBe(503);
    const body = JSON.parse(res.body);
    expect(body.code).toBe("account_not_configured");
    expect(body.error).toContain("Order account code not configured");
  });

  it("proxies OrderPadGetByAccount and returns the orders list", async () => {
    const orders: Order[] = [
      {
        id: "ORD-1",
        account: "ACC1",
        strategy: "test",
        side: "BUY",
        symbol: "NPN",
        isin: "ZAE000015889",
        type: "LMT",
        tif: "DAY",
        destination: "JSE",
        qty: 100,
        filled: 0,
        limit: 4180.55,
        stop: null,
        avgPx: 4180.55,
        vwap: 4180.55,
        trader: "tester",
        ts: Date.now(),
        state: "WORKING",
        orderTag: "tag-1",
        slippageBps: 0,
        arrivalMid: 4180.5,
      },
    ];
    const orderPadGetByAccount = vi.fn().mockResolvedValue({
      Header: { StatusCode: 2, ErrorNumber: 0 },
      DataRows: orders,
    });
    iressClientHolder.current = { orderPadGetByAccount };
    const { handleRequest } = await import("../../workers/iress-ingest/src/http-api");
    const session = makeMockSession();
    const sessions = {
      getSession: async () => session,
      invalidate: () => undefined,
    } as never;
    const req = fakeReq({ url: "/orders?account=ACC1&filter=1" });
    const res = fakeRes();
    await handleRequest(req, res as unknown as ServerResponse<IncomingMessage>, {
      env: buildEnv(),
      sessions,
      supabase: null,
    }, () => undefined, undefined);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.orders).toHaveLength(1);
    expect(body.orders[0].symbol).toBe("NPN");
    expect(body.source).toBe("live");
    expect(body.account).toBe("ACC1");
    expect(body.filter).toBe(1);
    expect(orderPadGetByAccount).toHaveBeenCalledWith(
      expect.objectContaining({ AccountCode: "ACC1", OrderFilter: 1 }),
    );
  });

  it("returns ok=false with mock_mode shape when IRESS_MODE is mock", async () => {
    const { handleRequest } = await import("../../workers/iress-ingest/src/http-api");
    const req = fakeReq({ url: "/orders?account=ACC1" });
    const res = fakeRes();
    await handleRequest(req, res as unknown as ServerResponse<IncomingMessage>, {
      env: buildEnv({ iressMode: "mock" }),
      sessions: { invalidate: () => undefined } as never,
      supabase: null,
    }, () => undefined, undefined);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(false);
    expect(body.source).toBe("unavailable");
    expect(body.error?.code).toBe("mock_mode");
  });

  it("returns ok=false with iress_<code> shape when the SOAP call fails", async () => {
    const orderPadGetByAccount = vi.fn().mockRejectedValue(
      new IressError(25032, "OrderPadGetByAccount", "Invalid account code"),
    );
    iressClientHolder.current = { orderPadGetByAccount };
    const { handleRequest } = await import("../../workers/iress-ingest/src/http-api");
    const session = makeMockSession();
    const sessions = {
      getSession: async () => session,
      invalidate: () => undefined,
    } as never;
    const req = fakeReq({ url: "/orders?account=ACC1" });
    const res = fakeRes();
    await handleRequest(req, res as unknown as ServerResponse<IncomingMessage>, {
      env: buildEnv(),
      sessions,
      supabase: null,
    }, () => undefined, undefined);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(false);
    expect(body.error?.code).toBe("iress_25032");
    expect(body.error?.message).toContain("Invalid account code");
  });

  it("invalidates the cached session on 25001", async () => {
    const orderPadGetByAccount = vi
      .fn()
      .mockRejectedValue(new IressError(25001, "OrderPadGetByAccount", "session expired"));
    iressClientHolder.current = { orderPadGetByAccount };
    const invalidate = vi.fn();
    const { handleRequest } = await import("../../workers/iress-ingest/src/http-api");
    const session = makeMockSession();
    const sessions = {
      getSession: async () => session,
      invalidate,
    } as never;
    const req = fakeReq({ url: "/orders?account=ACC1" });
    const res = fakeRes();
    await handleRequest(req, res as unknown as ServerResponse<IncomingMessage>, {
      env: buildEnv(),
      sessions,
      supabase: null,
    }, () => undefined, undefined);
    expect(invalidate).toHaveBeenCalled();
  });
});

describe("worker http-api 404", () => {
  it("returns 404 for unknown routes", async () => {
    const { handleRequest } = await import("../../workers/iress-ingest/src/http-api");
    const req = fakeReq({ url: "/nope" });
    const res = fakeRes();
    await handleRequest(req, res as unknown as ServerResponse<IncomingMessage>, {
      env: buildEnv(),
      sessions: { invalidate: () => undefined } as never,
      supabase: null,
    }, () => undefined, undefined);
    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body);
    expect(body.code).toBe("not_found");
  });
});

/**
 * The `/debug/timeseries-probe` endpoint exists to verify a candidate
 * V4 period selector against the live CT server. The empirical truth
 * (June 2026, see `docs/TIMESERIES_PROBE_REPORT_FINAL.md`) is that the
 * live CT server honours `<Frequency>` (Long), NOT the V4-WSDL-sample
 * `<Interval>` (string). The probe accepts either form so future
 * debugging can run both shapes against the live server without
 * redeploying the worker. Every probed value goes through the same
 * `getIressClient("live").timeSeriesGet2()` path the worker itself
 * uses; the endpoint surfaces the raw IRESS response so the operator
 * can spot the first non-fault value.
 */
describe("worker http-api /debug/timeseries-probe", () => {
  function readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
      req.on("error", () => resolve(""));
    });
  }
  function postReq(body: object): IncomingMessage {
    const listeners: Record<string, Array<() => void>> = {};
    const text = JSON.stringify(body);
    const req = {
      url: "/debug/timeseries-probe",
      method: "POST",
      headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(text)) },
      on(event: string, cb: (chunk?: Buffer) => void) {
        (listeners[event] ??= []).push(cb as never);
        return req;
      },
    } as unknown as IncomingMessage;
    // Fire `data` then `end` on the next tick so the handler can attach listeners first.
    setImmediate(() => {
      const buf = Buffer.from(text, "utf-8");
      for (const cb of listeners["data"] ?? []) cb(buf);
      for (const cb of listeners["end"] ?? []) cb();
    });
    return req;
  }
  function postReqRaw(bodyText: string): IncomingMessage {
    const listeners: Record<string, Array<() => void>> = {};
    const req = {
      url: "/debug/timeseries-probe",
      method: "POST",
      headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(bodyText)) },
      on(event: string, cb: (chunk?: Buffer) => void) {
        (listeners[event] ??= []).push(cb as never);
        return req;
      },
    } as unknown as IncomingMessage;
    setImmediate(() => {
      const buf = Buffer.from(bodyText, "utf-8");
      for (const cb of listeners["data"] ?? []) cb(buf);
      for (const cb of listeners["end"] ?? []) cb();
    });
    return req;
  }

  it("returns 401 when WORKER_HTTP_TOKEN is set and Authorization is missing", async () => {
    const { handleRequest } = await import("../../workers/iress-ingest/src/http-api");
    const req = postReq({ code: "J203", interval: "Daily" });
    const res = fakeRes();
    await handleRequest(req, res as unknown as ServerResponse<IncomingMessage>, {
      env: buildEnv(),
      sessions: { invalidate: () => undefined } as never,
      supabase: null,
    }, () => undefined, "secret-token");
    expect(res.statusCode).toBe(401);
  });

  it("returns 400 when body is not valid JSON", async () => {
    const { handleRequest } = await import("../../workers/iress-ingest/src/http-api");
    const req = postReqRaw("not-json{");
    const res = fakeRes();
    await handleRequest(req, res as unknown as ServerResponse<IncomingMessage>, {
      env: buildEnv(),
      sessions: { invalidate: () => undefined } as never,
      supabase: null,
    }, () => undefined, undefined);
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.code).toBe("bad_request");
    expect(body.error).toMatch(/Invalid JSON/);
  });

  it("returns 400 when code is missing", async () => {
    const { handleRequest } = await import("../../workers/iress-ingest/src/http-api");
    const req = postReq({ interval: "Daily" });
    const res = fakeRes();
    await handleRequest(req, res as unknown as ServerResponse<IncomingMessage>, {
      env: buildEnv(),
      sessions: { invalidate: () => undefined } as never,
      supabase: null,
    }, () => undefined, undefined);
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.code).toBe("bad_request");
    expect(body.error).toMatch(/code/);
  });

  it("returns 400 when both interval and frequency are missing", async () => {
    const { handleRequest } = await import("../../workers/iress-ingest/src/http-api");
    const req = postReq({ code: "J203" });
    const res = fakeRes();
    await handleRequest(req, res as unknown as ServerResponse<IncomingMessage>, {
      env: buildEnv(),
      sessions: { invalidate: () => undefined } as never,
      supabase: null,
    }, () => undefined, undefined);
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.code).toBe("bad_request");
    expect(body.error).toMatch(/frequency|interval/);
  });

  it("returns 503 when iressMode is mock (the probe needs a live session)", async () => {
    const { handleRequest } = await import("../../workers/iress-ingest/src/http-api");
    const req = postReq({ code: "J203", interval: "Daily" });
    const res = fakeRes();
    await handleRequest(req, res as unknown as ServerResponse<IncomingMessage>, {
      env: buildEnv({ iressMode: "mock" }),
      sessions: { invalidate: () => undefined } as never,
      supabase: null,
    }, () => undefined, undefined);
    expect(res.statusCode).toBe(503);
    const body = JSON.parse(res.body);
    expect(body.code).toBe("iress_mode_not_live");
  });

  it("calls timeSeriesGet2 with the supplied interval and surfaces the raw IRESS response", async () => {
    const timeSeriesGet2 = vi.fn().mockResolvedValueOnce({
      Header: { StatusCode: 2, ErrorNumber: 0, ErrorDescription: "" },
      DataRows: [
        { Date: "2026-06-12", Value: 78234.5 },
        { Date: "2026-06-13", Value: 78400.0 },
      ],
    });
    iressClientHolder.current = { timeSeriesGet2 };
    const session = makeMockSession();
    const sessions = {
      getSession: async () => session,
      peekSession: () => session,
      invalidate: () => undefined,
    } as never;
    const { handleRequest } = await import("../../workers/iress-ingest/src/http-api");
    const req = postReq({ code: "J203", interval: "Daily" });
    const res = fakeRes();
    await handleRequest(req, res as unknown as ServerResponse<IncomingMessage>, {
      env: buildEnv(),
      sessions,
      supabase: null,
    }, () => undefined, undefined);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.errorNumber).toBe(0);
    expect(body.dataRowCount).toBe(2);
    expect(body.interval).toBe("Daily");
    expect(body.frequency).toBeNull();
    expect(body.code).toBe("J203");
    expect(body.exchange).toBe("JSE"); // default
    expect(body.iressMode).toBe("live");
    expect(typeof body.elapsedMs).toBe("number");
    expect(typeof body.probedAt).toBe("string");
    // The SOAP call carried the user-supplied interval, plus the
    // standard 14-day lookback / today range, on the JSE exchange.
    const callArgs = timeSeriesGet2.mock.calls[0]![0] as {
      Header: { SessionKey: string; Timeout?: number };
      Code: string;
      Exchange: string;
      From: string;
      To: string;
      Interval?: string;
      Frequency?: number;
    };
    expect(callArgs.Interval).toBe("Daily");
    expect(callArgs.Frequency).toBeUndefined();
    expect(callArgs.Code).toBe("J203");
    expect(callArgs.Exchange).toBe("JSE");
    expect(callArgs.Header.SessionKey).toBe(session.iressSessionKey);
    expect(callArgs.Header.Timeout).toBe(15);
  });

  it("calls timeSeriesGet2 with the supplied frequency (Long) — the live CT server path", async () => {
    // The live CT server honours `<Frequency>` (Long), not the
    // V4-WSDL-sample `<Interval>` (string). The probe accepts the
    // `frequency` field so future debugging can pin the correct Long
    // without redeploying the worker.
    const timeSeriesGet2 = vi.fn().mockResolvedValueOnce({
      Header: { StatusCode: 2, ErrorNumber: 0, ErrorDescription: "" },
      DataRows: [
        { Date: "2026-06-12", Value: 78234.5 },
        { Date: "2026-06-13", Value: 78400.0 },
      ],
    });
    iressClientHolder.current = { timeSeriesGet2 };
    const session = makeMockSession();
    const sessions = {
      getSession: async () => session,
      peekSession: () => session,
      invalidate: () => undefined,
    } as never;
    const { handleRequest } = await import("../../workers/iress-ingest/src/http-api");
    const req = postReq({ code: "J203", frequency: 5 });
    const res = fakeRes();
    await handleRequest(req, res as unknown as ServerResponse<IncomingMessage>, {
      env: buildEnv(),
      sessions,
      supabase: null,
    }, () => undefined, undefined);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.dataRowCount).toBe(2);
    expect(body.frequency).toBe(5);
    expect(body.interval).toBeNull();
    const callArgs = timeSeriesGet2.mock.calls[0]![0] as {
      Code: string;
      Exchange: string;
      Interval?: string;
      Frequency?: number;
    };
    expect(callArgs.Frequency).toBe(5);
    expect(callArgs.Interval).toBeUndefined();
    expect(callArgs.Code).toBe("J203");
    expect(callArgs.Exchange).toBe("JSE");
  });

  it("frequency wins over interval when both are supplied (precedence rule)", async () => {
    // The body parser drops `interval` from the request when
    // `frequency` is set, so the wire shape only carries the Long.
    const timeSeriesGet2 = vi.fn().mockResolvedValueOnce({
      Header: { StatusCode: 2, ErrorNumber: 0, ErrorDescription: "" },
      DataRows: [{ Date: "2026-06-13", Value: 78400.0 }],
    });
    iressClientHolder.current = { timeSeriesGet2 };
    const session = makeMockSession();
    const sessions = {
      getSession: async () => session,
      peekSession: () => session,
      invalidate: () => undefined,
    } as never;
    const { handleRequest } = await import("../../workers/iress-ingest/src/http-api");
    const req = postReq({ code: "J203", frequency: 5, interval: "Daily" });
    const res = fakeRes();
    await handleRequest(req, res as unknown as ServerResponse<IncomingMessage>, {
      env: buildEnv(),
      sessions,
      supabase: null,
    }, () => undefined, undefined);
    expect(res.statusCode).toBe(200);
    const callArgs = timeSeriesGet2.mock.calls[0]![0] as {
      Interval?: string;
      Frequency?: number;
    };
    expect(callArgs.Frequency).toBe(5);
    expect(callArgs.Interval).toBeUndefined();
  });

  it("accepts frequency supplied as a numeric string (curl-friendliness)", async () => {
    // Some HTTP clients serialise JSON numbers as strings; the parser
    // coerces a numeric string to a Long.
    const timeSeriesGet2 = vi.fn().mockResolvedValueOnce({
      Header: { StatusCode: 2, ErrorNumber: 0, ErrorDescription: "" },
      DataRows: [{ Date: "2026-06-13", Value: 78400.0 }],
    });
    iressClientHolder.current = { timeSeriesGet2 };
    const session = makeMockSession();
    const sessions = {
      getSession: async () => session,
      peekSession: () => session,
      invalidate: () => undefined,
    } as never;
    const { handleRequest } = await import("../../workers/iress-ingest/src/http-api");
    const req = postReq({ code: "J203", frequency: "5" });
    const res = fakeRes();
    await handleRequest(req, res as unknown as ServerResponse<IncomingMessage>, {
      env: buildEnv(),
      sessions,
      supabase: null,
    }, () => undefined, undefined);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.frequency).toBe(5);
    const callArgs = timeSeriesGet2.mock.calls[0]![0] as { Frequency?: number };
    expect(callArgs.Frequency).toBe(5);
  });

  it("surfaces the soap:Receiver fault string verbatim when the live call throws IressError", async () => {
    const timeSeriesGet2 = vi.fn().mockRejectedValueOnce(
      new IressError(25018, "TimeSeriesGet2", "soap:Receiver — Invalid Parameter Value: bogus as Interval"),
    );
    iressClientHolder.current = { timeSeriesGet2 };
    const session = makeMockSession();
    const sessions = {
      getSession: async () => session,
      peekSession: () => session,
      invalidate: () => undefined,
    } as never;
    const { handleRequest } = await import("../../workers/iress-ingest/src/http-api");
    const req = postReq({ code: "J203", interval: "bogus" });
    const res = fakeRes();
    await handleRequest(req, res as unknown as ServerResponse<IncomingMessage>, {
      env: buildEnv(),
      sessions,
      supabase: null,
    }, () => undefined, undefined);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(false);
    expect(body.errorNumber).toBe(25018);
    expect(body.rawFault).toMatch(/Invalid Parameter Value: bogus as Interval/);
    expect(body.dataRowCount).toBe(0);
    expect(body.firstRow).toBeNull();
  });

  it("uses the caller's exchange when supplied (bond curve code with FX/MM-specific exchange)", async () => {
    const timeSeriesGet2 = vi.fn().mockResolvedValueOnce({
      Header: { StatusCode: 2, ErrorNumber: 0 },
      DataRows: [],
    });
    iressClientHolder.current = { timeSeriesGet2 };
    const session = makeMockSession();
    const sessions = {
      getSession: async () => session,
      peekSession: () => session,
      invalidate: () => undefined,
    } as never;
    const { handleRequest } = await import("../../workers/iress-ingest/src/http-api");
    const req = postReq({ code: "R2030", exchange: "JSE", interval: "Daily" });
    const res = fakeRes();
    await handleRequest(req, res as unknown as ServerResponse<IncomingMessage>, {
      env: buildEnv(),
      sessions,
      supabase: null,
    }, () => undefined, undefined);
    const callArgs = timeSeriesGet2.mock.calls[0]![0] as { Exchange: string; Code: string };
    expect(callArgs.Code).toBe("R2030");
    expect(callArgs.Exchange).toBe("JSE");
  });
});
