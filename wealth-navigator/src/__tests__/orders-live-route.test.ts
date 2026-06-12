import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_ENV = { ...process.env };
const KEYS = [
  "IRESS_WORKER_URL",
  "RAILWAY_SERVICE_URL",
  "USE_SUPABASE_QUOTES",
  "NEXT_PUBLIC_USE_SUPABASE_QUOTES",
];

function clearEnv() {
  for (const k of KEYS) delete process.env[k];
}

afterEach(() => {
  clearEnv();
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("GET /api/orders/live", () => {
  it("returns 503 not_configured when the worker URL is missing", async () => {
    clearEnv();
    const { GET } = await import("@/app/api/orders/live/route");
    const res = await GET(
      new Request("http://localhost/api/orders/live?account=ACC1"),
    );
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.code).toBe("not_configured");
    expect(body.orders).toEqual([]);
  });

  it("returns 503 worker_mode_off when USE_SUPABASE_QUOTES is off", async () => {
    clearEnv();
    process.env.IRESS_WORKER_URL = "https://worker.example.com";
    const { GET } = await import("@/app/api/orders/live/route");
    const res = await GET(
      new Request("http://localhost/api/orders/live?account=ACC1"),
    );
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.code).toBe("worker_mode_off");
    expect(body.orders).toEqual([]);
  });

  it("returns 400 missing_account when account is not provided", async () => {
    clearEnv();
    process.env.IRESS_WORKER_URL = "https://worker.example.com";
    process.env.USE_SUPABASE_QUOTES = "1";
    const { GET } = await import("@/app/api/orders/live/route");
    const res = await GET(new Request("http://localhost/api/orders/live"));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("missing_account");
  });

  it("proxies the worker response verbatim when configured", async () => {
    clearEnv();
    process.env.IRESS_WORKER_URL = "https://worker.example.com";
    process.env.USE_SUPABASE_QUOTES = "1";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            ok: true,
            orders: [],
            source: "live",
            account: "ACC1",
            filter: 1,
            workerId: "iress-ingest-1",
            iressMode: "live",
            fetchedAt: "2026-06-12T18:00:00.000Z",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    const { GET } = await import("@/app/api/orders/live/route");
    const res = await GET(
      new Request("http://localhost/api/orders/live?account=ACC1"),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.orders).toEqual([]);
    expect(body.source).toBe("live");
  });

  it("passes the account + filter query params to the worker", async () => {
    clearEnv();
    process.env.IRESS_WORKER_URL = "https://worker.example.com";
    process.env.USE_SUPABASE_QUOTES = "1";
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, orders: [], source: "live" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { GET } = await import("@/app/api/orders/live/route");
    await GET(
      new Request(
        "http://localhost/api/orders/live?account=ACC1&filter=3",
      ),
    );
    const calledUrl = fetchMock.mock.calls[0]?.[0] as string;
    expect(calledUrl).toContain("/orders?account=ACC1");
    expect(calledUrl).toContain("filter=3");
  });

  it("surfaces 503 unreachable when the worker fetch throws", async () => {
    clearEnv();
    process.env.IRESS_WORKER_URL = "https://worker.example.com";
    process.env.USE_SUPABASE_QUOTES = "1";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("ECONNREFUSED")),
    );
    const { GET } = await import("@/app/api/orders/live/route");
    const res = await GET(
      new Request("http://localhost/api/orders/live?account=ACC1"),
    );
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.code).toBe("unreachable");
    expect(body.error).toContain("ECONNREFUSED");
  });

  it("surfaces 503 upstream_error with the worker's error body when it 4xx/5xx", async () => {
    clearEnv();
    process.env.IRESS_WORKER_URL = "https://worker.example.com";
    process.env.USE_SUPABASE_QUOTES = "1";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            ok: false,
            error: "Order account code not configured",
          }),
          { status: 503, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    const { GET } = await import("@/app/api/orders/live/route");
    const res = await GET(
      new Request("http://localhost/api/orders/live?account=ACC1"),
    );
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.code).toBe("upstream_error");
    expect(body.upstreamStatus).toBe(503);
    expect(body.upstreamError).toEqual({
      ok: false,
      error: "Order account code not configured",
    });
  });
});

describe("GET /api/integration/health", () => {
  it("returns 503 not_configured when the worker URL is missing", async () => {
    clearEnv();
    const { GET } = await import("@/app/api/integration/health/route");
    const res = await GET();
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.code).toBe("not_configured");
  });

  it("proxies the worker health snapshot", async () => {
    clearEnv();
    process.env.IRESS_WORKER_URL = "https://worker.example.com";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            ok: true,
            workerId: "iress-ingest-1",
            iressMode: "live",
            dryRun: false,
            allowWrites: true,
            session: {
              cached: true,
              expiresAt: Date.now() + 60_000,
              services: ["IOSPlus", "IPS", "FIXPlus"],
              applicationId: "Mint-OEMS-Worker-prod-1",
            },
            accounts: ["ACC1"],
            watchlistSize: 10,
            timestamp: "2026-06-12T18:00:00.000Z",
            uptimeSec: 1234,
            lastQuoteSyncAt: "2026-06-12T17:59:45.000Z",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    const { GET } = await import("@/app/api/integration/health/route");
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.workerId).toBe("iress-ingest-1");
    expect(body.sessionCached).toBe(true);
    expect(body.services).toEqual(["IOSPlus", "IPS", "FIXPlus"]);
    expect(body.accounts).toEqual(["ACC1"]);
  });
});
