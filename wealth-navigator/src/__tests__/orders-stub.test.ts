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

function makeSupabaseRecorder(upsertImpl?: (table: string, rows: unknown) => Promise<{ error: { message: string } | null }>): {
  client: SupabaseClient;
  upsertCalls: UpsertCall[];
} {
  const upsertCalls: UpsertCall[] = [];
  const client = {
    from: (table: string) => ({
      upsert: async (rows: unknown, options?: unknown) => {
        upsertCalls.push({ table, rows, options });
        if (upsertImpl) return upsertImpl(table, rows);
        return { error: null };
      },
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
    }),
  } as unknown as SupabaseClient;
  return { client, upsertCalls };
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
    iressAccountCode: overrides.iressAccountCode ?? "ACC-1",
    applicationLabel: "Mint-OEMS-Test",
    defaultExchange: "JSE",
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

  it("live-writes: calls supabase.upsert on oems_order_audit with mapped rows", async () => {
    process.env.IRESS_WORKER_DRY_RUN = "0";
    process.env.SUPABASE_ALLOW_WRITES = "1";
    vi.resetModules();

    const { client, upsertCalls } = makeSupabaseRecorder();
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

    // Mock orders adapter returns a non-empty list; the stub should upsert.
    expect(upsertCalls.length).toBeGreaterThan(0);
    expect(upsertCalls[0]?.table).toBe("oems_order_audit");
    expect(result.polled).toBe(1);
    expect(result.upserted).toBeGreaterThan(0);
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
