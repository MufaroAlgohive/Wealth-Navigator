import { afterEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Tests for the read-only OEMS order poll stub in workers/iress-ingest.
 *
 * Confirms that:
 *  - In dry-run mode (IRESS_WORKER_DRY_RUN=1), the stub logs the would-be
 *    upserts and does NOT touch Supabase.
 *  - In live-writes mode, the stub calls `supabase.upsert` on `oems_order_audit`.
 *  - When the account list is empty, the stub is a no-op.
 *  - When mock mode is selected, the stub still emits a dry-run-friendly
 *    plan (no live SOAP session needed).
 *
 * These tests intentionally avoid hitting the real network; they mock the
 * IRESS client + Supabase client at the seam.
 */

const ORIGINAL_ENV = { ...process.env };

interface UpsertCall {
  table: string;
  rows: unknown;
  options?: unknown;
}

interface MutationCall {
  table: string;
  op: "delete" | "insert";
  rows?: unknown;
}

function makeSupabaseRecorder(upsertImpl?: (table: string, rows: unknown) => Promise<{ error: { message: string } | null }>): {
  client: SupabaseClient;
  upsertCalls: UpsertCall[];
  mutationCalls: MutationCall[];
} {
  const upsertCalls: UpsertCall[] = [];
  const mutationCalls: MutationCall[] = [];
  const client = {
    from: (table: string) => ({
      upsert: async (rows: unknown, options?: unknown) => {
        upsertCalls.push({ table, rows, options });
        if (upsertImpl) return upsertImpl(table, rows);
        return { error: null };
      },
      // Positions snapshot: delete(...).in(...).lt(...) — a chainable, awaitable
      // PostgREST-style builder (in/lt return self; awaiting records + resolves).
      delete: () => {
        const builder: Record<string, unknown> = {
          in: () => builder,
          lt: () => builder,
          then: (resolve: (v: { error: null }) => void) => {
            mutationCalls.push({ table, op: "delete" });
            resolve({ error: null });
          },
        };
        return builder;
      },
      insert: async (rows: unknown) => {
        mutationCalls.push({ table, op: "insert", rows });
        // Honour the same error impl as upsert so error-path tests cover insert.
        if (upsertImpl) return upsertImpl(table, rows);
        return { error: null };
      },
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
    }),
  } as unknown as SupabaseClient;
  return { client, upsertCalls, mutationCalls };
}

function makeWorkerEnv(overrides: Partial<{
  dryRun: boolean;
  allowWrites: boolean;
  iressMode: string;
  iressAccountCode: string;
}> = {}) {
  const watchlistSymbols = ["NPN"];
  return {
    workerId: "iress-ingest-test",
    iressMode: overrides.iressMode ?? "mock",
    dryRun: overrides.dryRun ?? true,
    allowWrites: overrides.allowWrites ?? true,
    priceOverlayOff: false,
    heartbeatSec: 30,
    quoteIntervalSec: 15,
    orderPollIntervalSec: 60,
    watchlistSymbols,
    watchlistEntries: watchlistSymbols.map((s) => ({ symbol: s, exchange: "JSE", kind: "equity" as const })),
    watchlistExchanges: {},
    fxExchange: "FX",
    moneyMarketExchange: "MM",
    instrumentSync: false,
    supabaseUrl: "https://example.supabase.co",
    supabaseServiceKey: "sk",
    retailSupabaseUrl: "https://example.supabase.co",
    retailSupabaseKey: "sk",
    institutionalSupabaseUrl: "https://example.supabase.co",
    institutionalSupabaseKey: "sk",
    iressAccountCode: overrides.iressAccountCode ?? "ACC-1",
    uatAccountCode: "",
    uatMode: false,
    uatOrderPollSec: 30,
    alertEvalSec: 60,
    applicationLabel: "Mint-OEMS-Test",
    defaultExchange: "JSE",
    ipsServer: "IPSAPI",
    newsDryRun: true,
    newsAllowWrites: false,
    newsVendorCode: "SENS",
    newsMaxRows: 2000,
  };
}

describe("worker orders stub", () => {
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("dry-run: logs would-be upserts and does NOT call supabase.upsert", async () => {
    process.env.IRESS_WORKER_DRY_RUN = "1";
    process.env.SUPABASE_ALLOW_WRITES = "0";
    vi.resetModules();

    const { client, upsertCalls } = makeSupabaseRecorder();
    const env = makeWorkerEnv({ dryRun: true, allowWrites: false, iressMode: "mock" });
    const sessions = {} as never;
    const logSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { pollAccountsForOrders } = await import("../../workers/iress-ingest/src/orders");
    const result = await pollAccountsForOrders({
      env,
      sessions,
      supabase: client,
      accounts: ["MINT-LIVE-001"],
    });

    expect(result.polled).toBe(1);
    expect(result.upserted).toBe(0);
    expect(upsertCalls).toHaveLength(0);
    const logPayload = logSpy.mock.calls.flat().join("\n");
    expect(logPayload).toMatch(/would_upsert_oems_order_audit|oems_order_audit/);
    logSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it("live-writes: mirrors orders into oems_order_audit (delete-then-insert, no unique constraint)", async () => {
    process.env.IRESS_WORKER_DRY_RUN = "0";
    process.env.SUPABASE_ALLOW_WRITES = "1";
    vi.resetModules();

    const { client, mutationCalls } = makeSupabaseRecorder();
    const env = makeWorkerEnv({ dryRun: false, allowWrites: true, iressMode: "mock" });
    const sessions = {} as never;

    const { pollAccountsForOrders } = await import("../../workers/iress-ingest/src/orders");
    // Seed data uses MINT-LIVE-001 as a known account; the stub filters
    // mock orders by the requested accounts list.
    const result = await pollAccountsForOrders({
      env,
      sessions,
      supabase: client,
      accounts: ["MINT-LIVE-001"],
    });

    // oems_order_audit has no unique constraint on order_id → the worker must
    // delete-then-insert (NOT upsert), or it errors "no unique constraint".
    const auditMutations = mutationCalls.filter((m) => m.table === "oems_order_audit");
    expect(auditMutations.some((m) => m.op === "insert")).toBe(true);
    expect(result.polled).toBe(1);
    expect(result.upserted).toBeGreaterThan(0);
  });

  it("live-writes: snapshots positions into oems_position_c (upsert + stale-clear)", async () => {
    process.env.IRESS_WORKER_DRY_RUN = "0";
    process.env.SUPABASE_ALLOW_WRITES = "1";
    vi.resetModules();

    const { client, mutationCalls, upsertCalls } = makeSupabaseRecorder();
    const env = makeWorkerEnv({ dryRun: false, allowWrites: true, iressMode: "mock" });
    const sessions = {} as never;

    const { pollAccountsForOrders } = await import("../../workers/iress-ingest/src/orders");
    await pollAccountsForOrders({
      env,
      sessions,
      supabase: client,
      accounts: ["MINT-LIVE-001"],
    });

    // Positions upsert on UNIQUE(account_code, security_code), then a
    // batch-timestamp delete clears closed positions.
    expect(upsertCalls.some((c) => c.table === "oems_position_c")).toBe(true);
    const positionMutations = mutationCalls.filter((m) => m.table === "oems_position_c");
    expect(positionMutations.some((m) => m.op === "delete")).toBe(true);
  });

  it("empty account list is a no-op", async () => {
    vi.resetModules();
    const { client, upsertCalls } = makeSupabaseRecorder();
    const env = makeWorkerEnv({ dryRun: false, allowWrites: true, iressMode: "mock" });
    const sessions = {} as never;

    const { pollAccountsForOrders } = await import("../../workers/iress-ingest/src/orders");
    const result = await pollAccountsForOrders({
      env,
      sessions,
      supabase: client,
      accounts: [],
    });

    expect(result.polled).toBe(0);
    expect(result.upserted).toBe(0);
    expect(upsertCalls).toHaveLength(0);
  });

  it("propagates supabase error without throwing", async () => {
    vi.resetModules();
    const { client } = makeSupabaseRecorder(async () => ({
      error: { message: "RLS denied" },
    }));
    const env = makeWorkerEnv({ dryRun: false, allowWrites: true, iressMode: "mock" });
    const sessions = {} as never;
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { pollAccountsForOrders } = await import("../../workers/iress-ingest/src/orders");
    const result = await pollAccountsForOrders({
      env,
      sessions,
      supabase: client,
      accounts: ["MINT-LIVE-001"],
    });

    expect(result.upserted).toBe(0);
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});

describe("derivePositions (positions-from-fills)", () => {
  // Minimal Order factory — only the fields derivePositions reads matter.
  function order(o: Partial<{
    account: string;
    symbol: string;
    side: "BUY" | "SELL";
    filled: number;
    avgPx: number;
  }>) {
    return {
      id: "ord",
      account: o.account ?? "ACC-1",
      strategy: "(unspecified)",
      side: o.side ?? "BUY",
      symbol: o.symbol ?? "NPN",
      isin: "ZZZ",
      type: "LMT",
      tif: "DAY",
      destination: "JSE",
      qty: 100,
      filled: o.filled ?? 0,
      limit: null,
      stop: null,
      avgPx: o.avgPx ?? 0,
      vwap: 0,
      trader: "(current user)",
      ts: 0,
      state: "FILLED",
      slippageBps: 0,
      arrivalMid: 0,
      orderTag: "",
    } as unknown as import("@/types/iress").Order;
  }

  it("returns an empty array when no orders have fills (the demo book's correct empty state)", async () => {
    const { derivePositions } = await import("../../workers/iress-ingest/src/orders");
    const positions = derivePositions([
      order({ filled: 0 }),
      order({ filled: 0, side: "SELL" }),
    ]);
    expect(positions).toEqual([]);
  });

  it("nets buy/sell fills per account+security and volume-weights the open average price", async () => {
    const { derivePositions } = await import("../../workers/iress-ingest/src/orders");
    const positions = derivePositions([
      order({ symbol: "NPN", side: "BUY", filled: 100, avgPx: 61000 }), // 100 @ R610.00
      order({ symbol: "NPN", side: "BUY", filled: 100, avgPx: 63000 }), // 100 @ R630.00
      order({ symbol: "NPN", side: "SELL", filled: 50, avgPx: 64000 }), // -50 (does not affect buy avg)
    ]);
    expect(positions).toHaveLength(1);
    const p = positions[0]!;
    expect(p.account_code).toBe("ACC-1");
    expect(p.security_code).toBe("NPN");
    expect(p.quantity).toBe(150); // 100 + 100 - 50
    // Volume-weighted buy price = (100*61000 + 100*63000) / 200 = 62000 cents → R620.00
    expect(p.open_average_price).toBeCloseTo(620, 4);
    expect(p.currency).toBe("ZAR");
    expect(p.market_value).toBeNull();
  });

  it("drops positions that net to zero (fully closed)", async () => {
    const { derivePositions } = await import("../../workers/iress-ingest/src/orders");
    const positions = derivePositions([
      order({ symbol: "SOL", side: "BUY", filled: 80, avgPx: 17800 }),
      order({ symbol: "SOL", side: "SELL", filled: 80, avgPx: 18000 }),
    ]);
    expect(positions).toEqual([]);
  });

  it("keeps separate accounts and securities apart", async () => {
    const { derivePositions } = await import("../../workers/iress-ingest/src/orders");
    const positions = derivePositions([
      order({ account: "ACC-1", symbol: "NPN", side: "BUY", filled: 10, avgPx: 61000 }),
      order({ account: "ACC-2", symbol: "NPN", side: "BUY", filled: 20, avgPx: 61000 }),
      order({ account: "ACC-1", symbol: "AGL", side: "BUY", filled: 30, avgPx: 50000 }),
    ]);
    expect(positions).toHaveLength(3);
    const key = (p: { account_code: string; security_code: string }) => `${p.account_code}|${p.security_code}`;
    const byKey = new Map(positions.map((p) => [key(p), p]));
    expect(byKey.get("ACC-1|NPN")?.quantity).toBe(10);
    expect(byKey.get("ACC-2|NPN")?.quantity).toBe(20);
    expect(byKey.get("ACC-1|AGL")?.quantity).toBe(30);
  });
});
