import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Tests for the new OEMS BFF envelope shape:
 *
 *   GET /api/strategies
 *   GET /api/curves/[code]/metrics
 *   GET /api/bonds
 *   GET /api/money-market
 *   GET /api/macro
 *   GET /api/news
 *
 * The routes are DB-first reads of:
 *   oems_strategy_c, oems_curve_metric_c, bonds_c,
 *   money_market_instrument_c, jibar_fixing_c,
 *   macro_indicator_c, macro_release_c, news_item_c
 *
 * They must:
 *  - return `{ source: "unavailable", … }` (no 5xx) when the source is empty
 *  - return the rows from the relevant table (mapped to client shape) when
 *    Supabase is configured and the table has data
 *  - never throw, never return raw driver errors to the client
 *
 * We use `vi.doMock` (combined with `vi.resetModules` per test) to swap
 * `@/lib/supabase/server`'s `createServiceRoleClient` because the route
 * handlers import it directly at module-load time.
 */

const ORIGINAL_ENV = { ...process.env };
const KEYS = [
  "USE_SUPABASE_QUOTES",
  "NEXT_PUBLIC_USE_SUPABASE_QUOTES",
  "SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_ANON_KEY",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
];

function clearEnv() {
  for (const k of KEYS) delete process.env[k];
}

function makeSupabaseStub(tables: Record<string, unknown[]>) {
  // The route handlers only call .from(...).select(...).order(...) and
  // sometimes .limit(...) or .eq(...). The stub returns the canned
  // rows for the requested table.
  //
  // Trick: any chain call that returns "the result" must be thenable —
  // `await supabase.from(...).select(...).order(...)` resolves to
  // `{ data, error }`. We make every chain object both chainable AND
  // thenable so the route can `await` it at any depth.
  const from = (table: string) => {
    const rows = (tables[table] ?? []) as unknown[];
    const result = { data: rows, error: null };
    const make = (): Record<string, unknown> => {
      const obj: Record<string, unknown> = {};
      for (const k of ["select", "eq", "order", "limit", "neq", "gt", "lt", "gte", "lte", "in", "match", "filter", "not"]) {
        obj[k] = () => make();
      }
      obj["maybeSingle"] = async () => ({ data: null, error: null });
      obj["single"] = async () => ({ data: null, error: null });
      // `then` makes the chain awaitable at any depth — the route
      // does `await supabase.from(...).select(...).order(...)` and
      // expects `{ data, error }` back, even if it didn't call
      // `.limit()` first.
      obj["then"] = (
        resolve: (v: unknown) => void,
        reject?: (e: unknown) => void,
      ) => Promise.resolve(result).then(resolve, reject);
      return obj;
    };
    return make();
  };
  return { from } as unknown as SupabaseClient;
}

beforeEach(() => {
  clearEnv();
  // Inject the same seam the production server uses.
  process.env.USE_SUPABASE_QUOTES = "true";
  process.env.SUPABASE_URL = "https://supabase.example.com";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key";
  process.env.SUPABASE_ANON_KEY = "anon-key";
  vi.resetModules();
});

afterEach(() => {
  clearEnv();
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
});

/**
 * Install a Supabase stub for the *next* dynamic import of the route.
 * `vi.doMock` is hoisted to the top of the file in production; inside
 * a test it applies to subsequent `await import(...)` calls, so the
 * route under test sees the stubbed `createServiceRoleClient`.
 */
function installSupabaseStub(tables: Record<string, unknown[]>) {
  const client = makeSupabaseStub(tables);
  vi.doMock("@/lib/supabase/server", () => ({
    createServiceRoleClient: () => client,
    createRetailServiceRoleClient: () => client,
    createInstitutionalServiceRoleClient: () => client,
    isSupabaseConfigured: () => true,
    isRetailSupabaseConfigured: () => true,
    isInstitutionalSupabaseConfigured: () => true,
    createSupabaseServerClient: () => client,
    createAnonServerClient: () => client,
  }));
}

describe("GET /api/strategies", () => {
  it("returns empty list with source=unavailable when oems_strategy_c is empty", async () => {
    installSupabaseStub({ oems_strategy_c: [] });
    const { GET } = await import("@/app/api/strategies/route");
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.source).toBe("unavailable");
    expect(body.strategies).toEqual([]);
    expect(body.reason).toBe("empty");
  });

  it("returns mapped rows when oems_strategy_c has data", async () => {
    const rows = [
      {
        strategy_id: "STRAT-EQ-001",
        name: "SA Equity Core",
        status: "live",
        asset_class: "equity",
        manager: "Quant",
        benchmark: "J203",
        aum_cents: 42500000000,
        pnl_today_cents: 1250000,
        pnl_mtd_cents: 7800000,
        pnl_ytd_pct: 8.4,
        nav_value_cents: 42500000000,
        investor_count: 32,
        holdings_count: 28,
        cash_weight_pct: 4.2,
        deployed_at: "2025-01-01T00:00:00Z",
        last_rebalanced_at: "2026-06-01T09:00:00Z",
        payload: {},
        ingested_at: "2026-06-13T00:00:00Z",
        updated_at: "2026-06-13T00:00:00Z",
      },
    ];
    installSupabaseStub({ oems_strategy_c: rows });
    const { GET } = await import("@/app/api/strategies/route");
    const res = await GET();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.source).toBe("supabase");
    expect(body.strategies).toHaveLength(1);
    // BFF maps `aum_cents` → `aum` (Rands, cents/100) for the client
    expect(body.strategies[0]).toMatchObject({
      id: "STRAT-EQ-001",
      status: "live",
      kind: "equity",
      aum: 425000000,
      dayPnl: 12500,
    });
  });

  it("returns 503 reason=supabase_not_configured when env is missing", async () => {
    clearEnv();
    // No stub — the real `isSupabaseConfigured` should return false
    // because SUPABASE_URL is unset. We don't install a mock for
    // `@/lib/supabase/server` so the real one runs.
    vi.doMock("@/lib/supabase/server", () => {
      // Re-export the real module's symbols, except override
      // isSupabaseConfigured to mirror the real one (return false
      // when env is missing). The `createClient` from
      // @supabase/supabase-js is also real, so the function should
      // throw on the first call — but `isSupabaseConfigured` returns
      // false BEFORE the createClient call, so 503 fires first.
      return {
        isSupabaseConfigured: () =>
          Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY),
        // Retail is also unconfigured when env is missing → the route skips the
        // retail-first path and falls through to the 503.
        isRetailSupabaseConfigured: () =>
          Boolean(process.env.RETAIL_SUPABASE_URL && process.env.RETAIL_SUPABASE_SERVICE_ROLE_KEY),
        isInstitutionalSupabaseConfigured: () => false,
        createServiceRoleClient: () => {
          throw new Error("createServiceRoleClient should NOT be called when isSupabaseConfigured is false");
        },
        createRetailServiceRoleClient: () => {
          throw new Error("createRetailServiceRoleClient should NOT be called when retail is unconfigured");
        },
        createInstitutionalServiceRoleClient: () => {
          throw new Error("not used in this test");
        },
        createSupabaseServerClient: () => {
          throw new Error("not used in this test");
        },
        createAnonServerClient: () => {
          throw new Error("not used in this test");
        },
      };
    });
    const { GET } = await import("@/app/api/strategies/route");
    const res = await GET();
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.reason).toBe("supabase_not_configured");
    expect(body.strategies).toEqual([]);
  });
});

describe("GET /api/curves/[code]/metrics", () => {
  it("returns null pca + empty metrics + honest message when no rows", async () => {
    installSupabaseStub({ oems_curve_metric_c: [] });
    const { GET } = await import("@/app/api/curves/[code]/metrics/route");
    const res = await GET(new Request("http://localhost/api/curves/ZAR_NSS/metrics"), {
      params: Promise.resolve({ code: "ZAR_NSS" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.code).toBe("ZAR_NSS");
    expect(body.metrics).toEqual([]);
    expect(body.pca).toBeNull();
    expect(body.source).toBe("unavailable");
    // Honest empty-state message — what /oems/curves + the Cockpit
    // PCA panel read to explain why the chart is empty.
    expect(body.message).toMatch(/Curve metrics require/i);
    expect(body.hint).toMatch(/20260613000003_oems_curve_metric_c\.sql/);
  });

  it("returns source=unavailable reason=supabase_quotes_disabled when USE_SUPABASE_QUOTES is off", async () => {
    clearEnv();
    const { GET } = await import("@/app/api/curves/[code]/metrics/route");
    const res = await GET(new Request("http://localhost/api/curves/ZAR_NSS/metrics"), {
      params: Promise.resolve({ code: "ZAR_NSS" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.source).toBe("unavailable");
    expect(body.reason).toBe("supabase_quotes_disabled");
  });
});

describe("GET /api/bonds", () => {
  it("returns empty list with source=unavailable when bonds_c is empty", async () => {
    installSupabaseStub({ bonds_c: [] });
    const { GET } = await import("@/app/api/bonds/route");
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.source).toBe("unavailable");
    expect(body.bonds).toEqual([]);
    expect(body.message).toMatch(/IRESS bond entitlement/i);
  });
});

describe("GET /api/money-market", () => {
  it("returns empty instruments + jibar with honest message when both tables are empty", async () => {
    installSupabaseStub({ money_market_instrument_c: [], jibar_fixing_c: [] });
    const { GET } = await import("@/app/api/money-market/route");
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.source).toBe("unavailable");
    expect(body.instruments).toEqual([]);
    expect(body.jibar).toEqual([]);
    expect(body.message).toMatch(/rate entitlement or a vendor contract/i);
  });
});

describe("GET /api/macro", () => {
  it("returns empty indicators + releases with vendor-not-configured message", async () => {
    installSupabaseStub({ macro_indicator_c: [], macro_release_c: [] });
    const { GET } = await import("@/app/api/macro/route");
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.source).toBe("unavailable");
    expect(body.indicators).toEqual([]);
    expect(body.releases).toEqual([]);
    expect(body.message).toMatch(/vendor contract/i);
  });
});

describe("GET /api/news", () => {
  it("returns empty list with source=unavailable when News_articles is empty", async () => {
    process.env.USE_SUPABASE_QUOTES = "true";
    process.env.NEXT_PUBLIC_USE_SUPABASE_QUOTES = "true";
    installSupabaseStub({ News_articles: [] });
    const { GET } = await import("@/app/api/news/route");
    const res = await GET(new Request("http://localhost/api/news"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.source).toBe("unavailable");
    expect(body.items).toEqual([]);
  });
});

/**
 * `POST /api/orders/cancel` is the live-only path for cancelling an
 * open order on the broker. The BFF itself is a passthrough to the
 * Railway worker (which calls `OrderDelete` on the IRESS license seat),
 * so we test the BFF's own envelope + gate logic, not the worker's
 * downstream behaviour (covered in `worker-http-api.test.ts`).
 */
describe("POST /api/orders/cancel", () => {
  function mockCallWorker(impl: (opts: { method?: string; path?: string; body?: unknown }) => Promise<unknown>) {
    vi.doMock("@/lib/iress/worker-api", () => ({
      callWorker: (opts: { method?: string; path?: string; body?: unknown }) => impl(opts),
    }));
  }

  /**
   * Wrap a plain "shape the worker would send" object in the
   * `WorkerApiSuccess` envelope the BFF expects (`{ ok, body, status, contentType }`).
   */
  function ok<T>(body: T): { ok: true; body: T; status: number; contentType: string } {
    return { ok: true, body, status: 200, contentType: "application/json" };
  }

  function configureEnv(overrides: Record<string, string | undefined> = {}) {
    for (const k of KEYS) delete process.env[k];
    process.env.USE_SUPABASE_QUOTES = "true";
    process.env.SUPABASE_URL = "https://supabase.example.com";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key";
    process.env.SUPABASE_ANON_KEY = "anon-key";
    process.env.IRESS_WORKER_URL = "https://iress-worker.example.com";
    for (const [k, v] of Object.entries(overrides)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }

  it("returns 503 not_configured when the worker URL is not set", async () => {
    clearEnv();
    process.env.USE_SUPABASE_QUOTES = "true";
    vi.resetModules();
    const { POST } = await import("@/app/api/orders/cancel/route");
    const res = await POST(
      new Request("http://localhost/api/orders/cancel", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ orderId: "ORD-123", account: "ACC1" }),
      }),
    );
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.code).toBe("not_configured");
  });

  it("returns 503 worker_mode_off when USE_SUPABASE_QUOTES is off", async () => {
    clearEnv();
    process.env.SUPABASE_URL = "https://supabase.example.com";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key";
    process.env.SUPABASE_ANON_KEY = "anon-key";
    process.env.IRESS_WORKER_URL = "https://iress-worker.example.com";
    // USE_SUPABASE_QUOTES is not set → worker live mode is off
    vi.resetModules();
    const { POST } = await import("@/app/api/orders/cancel/route");
    const res = await POST(
      new Request("http://localhost/api/orders/cancel", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ orderId: "ORD-123", account: "ACC1" }),
      }),
    );
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.code).toBe("worker_mode_off");
  });

  it("forwards a valid body to the worker via POST /orders/cancel", async () => {
    configureEnv();
    vi.resetModules();
    type WorkerCallOpts = { method?: string; path?: string; body?: unknown };
    const received: { value: WorkerCallOpts | null } = { value: null };
    mockCallWorker(async (opts) => {
      received.value = opts;
      return ok({ ok: true, orderId: "ORD-123", account: "ACC1", cancelledAt: "2026-06-13T10:00:00Z" });
    });
    const { POST } = await import("@/app/api/orders/cancel/route");
    const res = await POST(
      new Request("http://localhost/api/orders/cancel", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ orderId: "ORD-123", account: "ACC1" }),
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(received.value).not.toBeNull();
    expect(received.value?.method).toBe("POST");
    expect(received.value?.path).toBe("/orders/cancel");
    expect(received.value?.body).toEqual({ orderId: "ORD-123", account: "ACC1" });
  });

  it("returns 400 missing_order_id when the body omits orderId", async () => {
    configureEnv();
    vi.resetModules();
    mockCallWorker(async () => ({ ok: true }));
    const { POST } = await import("@/app/api/orders/cancel/route");
    const res = await POST(
      new Request("http://localhost/api/orders/cancel", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ account: "ACC1" }),
      }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("missing_order_id");
  });

  it("returns 400 bad_request when the body is not valid JSON", async () => {
    configureEnv();
    vi.resetModules();
    mockCallWorker(async () => ({ ok: true }));
    const { POST } = await import("@/app/api/orders/cancel/route");
    const res = await POST(
      new Request("http://localhost/api/orders/cancel", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not valid",
      }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("bad_request");
  });

  it("bubbles upstream errors with the worker's body when the worker call fails", async () => {
    configureEnv();
    vi.resetModules();
    mockCallWorker(async () => ({
      ok: false as const,
      status: 503,
      code: "unreachable" as const,
      error: "Worker unreachable: connection refused",
      workerUrl: "https://iress-worker.example.com",
    }));
    const { POST } = await import("@/app/api/orders/cancel/route");
    const res = await POST(
      new Request("http://localhost/api/orders/cancel", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ orderId: "ORD-123", account: "ACC1" }),
      }),
    );
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.code).toBe("unreachable");
    expect(body.workerUrl).toBe("https://iress-worker.example.com");
  });
});
