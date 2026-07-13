import { afterEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Regression test for the bug Andre + Juan hit live (2026-07-13):
 *   "partials come through, full fills don't"
 *
 * The UAT order poller (`workers/iress-ingest/src/order-poller.ts`) polls
 * IRESS `OrderPadGetByAccount` and uses the response to update the audit
 * row + publish SSE deltas. It used to pass `OrderFilter: 1` (WORKING only)
 * — which means IRESS returned only ACTIVE rows. The moment a fully-filled
 * CARE order flipped OrderState to INACTIVE on Hermes, it dropped out of
 * the poll and the audit row stayed stuck on `partial` forever.
 *
 * The fix: pass `OrderFilter: 3` (ALL) so INACTIVE rows are returned too
 * — the poller can then stamp the audit `status` to `filled` and publish
 * the final-fill SSE delta to the UI.
 *
 * This test imports the worker's `fetchUatOrders` helper indirectly via
 * `pollUatForFills` and asserts that the IRESS client was invoked with
 * `OrderFilter: 3`. If anyone reverts that filter, this test fires.
 */

const ORIGINAL_ENV = { ...process.env };

interface UpsertCall {
  table: string;
  rows: unknown;
  options?: unknown;
}

interface MutationCall {
  table: string;
  op: "delete" | "insert" | "update";
  rows?: unknown;
}

function makeSupabaseRecorder(): {
  client: SupabaseClient;
  upsertCalls: UpsertCall[];
  mutationCalls: MutationCall[];
  selectByOrderId: (orderId: string) => Record<string, unknown> | null;
} {
  const upsertCalls: UpsertCall[] = [];
  const mutationCalls: MutationCall[] = [];
  // Pre-seed one audit row that the poll will match against. The row shape
  // mirrors what `send-to-market` writes: a working row keyed by the IRESS
  // OrderNumber stamped back into `order_id`.
  const seededRow = {
    id: "audit-row-1",
    order_id: "1500118",
    client_account: "56378",
    symbol: "SOL",
    side: "buy",
    quantity: 400,
    price_cents: 17700,
    status: "working",
    source: "UAT",
    payload: { book_id: "UAT-single-fill-test", strategy: "UAT-single-fill-test", limitPrice: 177 },
    result_payload: {},
  };

  const client = {
    from: (table: string) => ({
      upsert: async (rows: unknown, options?: unknown) => {
        upsertCalls.push({ table, rows, options });
        return { error: null };
      },
      update: (rows: unknown) => {
        const builder: Record<string, unknown> = {
          eq: () => builder,
          then: (resolve: (v: { error: null }) => void) => {
            mutationCalls.push({ table, op: "update", rows });
            resolve({ error: null });
          },
        };
        return builder;
      },
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
        return { error: null };
      },
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: null, error: null }),
        }),
        in: (_col: string, _vals: string[]) => ({
          then: (resolve: (v: { data: unknown[]; error: null }) => void) => {
            // Return the seeded row so the poller has something to update.
            resolve({ data: [seededRow], error: null });
          },
        }),
        order: () => ({
          limit: () => ({
            then: (resolve: (v: { data: unknown[]; error: null }) => void) => {
              resolve({ data: [seededRow], error: null });
            },
          }),
        }),
      }),
    }),
  } as unknown as SupabaseClient;
  return {
    client,
    upsertCalls,
    mutationCalls,
    selectByOrderId: (orderId: string) =>
      seededRow.order_id === orderId ? seededRow : null,
  };
}

function makeWorkerEnv(overrides: Partial<{ uatMode: boolean; uatAccountCode: string }> = {}) {
  const watchlistSymbols = ["NPN"];
  return {
    workerId: "iress-ingest-uat-test",
    iressMode: "live",
    dryRun: false,
    allowWrites: true,
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
    iressAccountCode: "MINT-LIVE-001",
    uatAccountCode: overrides.uatAccountCode ?? "56378",
    uatMode: overrides.uatMode ?? true,
    uatOrderPollSec: 30,
    applicationLabel: "Mint-OEMS-Worker-Test",
    defaultExchange: "JSE",
    ipsServer: "IPSAPI",
  };
}

describe("UAT order poller — OrderFilter regression (Juan + Andre 2026-07-13)", () => {
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.resetModules();
    vi.restoreAllMocks();
    vi.unmock("../../workers/iress-ingest/src/index");
  });

  it("calls IRESS OrderPadGetByAccount with OrderFilter=3 (ALL), not 1 (WORKING)", async () => {
    process.env.IRESS_WORKER_DRY_RUN = "0";
    process.env.SUPABASE_ALLOW_WRITES = "1";
    vi.resetModules();

    const env = makeWorkerEnv();
    const { client } = makeSupabaseRecorder();

    // Mock the IRESS client to record the OrderFilter value. This is what
    // would have prevented the regression in the first place.
    const orderPadMock = vi.fn().mockResolvedValue({
      DataRows: [
        {
          OrderNumber: "1500118",
          AccountCode: "56378",
          SecurityCode: "SOL",
          BuyOrSell: "B",
          OrderVolume: 400,
          DoneVolumeTotal: 400, // fully filled
          OrderPrice: 17700,
          AveragePrice: 17800,
          OrderState: "INACTIVE",
          ActionStatus: "OK",
          InternalOrderStatus: "Filled",
          StateDescription: "Traded 200 @ 17700, then 200 @ 17900",
          RemainingVolume: 0,
          RemainingValue: 0,
          OrderValue: 7120000,
          Lifetime: "DAY",
          PricingInstructions: "LIMIT",
          Destination: "JSE",
          ISIN: "ZAE000191426",
          OrderGroup: "UAT-single-fill-test",
          OrderTag: "56378",
        },
      ],
      Status: "OK",
      ErrorNumber: 0,
    });
    const sessionMock = vi.fn().mockResolvedValue({
      iressSessionKey: "sk-test",
      serviceKeys: { IOSPlus: "ios-key" },
      applicationId: "Mint-OEMS-Test",
    });
    const withSessionMock = vi.fn(async (fn: (s: unknown) => Promise<unknown>) => {
      return fn({ iressSessionKey: "sk-test", serviceKeys: { IOSPlus: "ios-key" } });
    });

    vi.doMock("../../src/lib/iress/index", () => ({
      getIressClient: () => ({
        orderPadGetByAccount: orderPadMock,
      }),
    }));

    const { pollUatForFills } = await import("../../workers/iress-ingest/src/order-poller");
    const result = await pollUatForFills({
      env,
      sessions: {
        getSession: sessionMock,
        withSession: withSessionMock,
      } as never,
      supabase: client as never,
    });

    expect(orderPadMock).toHaveBeenCalledTimes(1);
    const call = orderPadMock.mock.calls[0]?.[0] as { OrderFilter?: number };
    // THE assertion that pins the fix: OrderFilter MUST be 3 (ALL), never
    // 1 (WORKING) or 2 (OPEN). If anyone reverts this, the partial-then-
    // full-fill flow goes invisible to the UI again.
    expect(call.OrderFilter).toBe(3);

    // Sanity: the poll actually ran (not skipped) and the IRESS mock
    // returned the fully-filled row. The hub publish count isn't asserted
    // because the test doesn't register an SSE subscriber — `published=0`
    // is the correct outcome in that scenario.
    expect(result.polled).toBe(1);
    expect(result.skipReason).toBeNull();
  });
});