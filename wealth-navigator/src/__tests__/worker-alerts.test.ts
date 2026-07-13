import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { WorkerEnv } from "../../workers/iress-ingest/src/env";
import { evaluateTriggers } from "../../workers/iress-ingest/src/alerts";

/**
 * Alert-cycle unit tests for the worker. The evaluator is a pure DB read +
 * DB write against the institutional Supabase client — we stub the client
 * with an object that records calls and returns canned responses so the
 * suite stays hermetic.
 */

function makeEnv(overrides: Partial<WorkerEnv> = {}): WorkerEnv {
  return {
    workerId: "w",
    iressMode: "live",
    dryRun: false,
    allowWrites: false, // by default the suite tests the dry-run path
    priceOverlayOff: false,
    heartbeatSec: 30,
    quoteIntervalSec: 15,
    orderPollIntervalSec: 60,
    watchlistSymbols: [],
    watchlistEntries: [],
    watchlistExchanges: {},
    instrumentSync: false,
    supabaseUrl: "",
    supabaseServiceKey: "",
    retailSupabaseUrl: "",
    retailSupabaseKey: "",
    institutionalSupabaseUrl: "",
    institutionalSupabaseKey: "",
    iressAccountCode: "",
    uatAccountCode: "",
    uatMode: false,
    uatOrderPollSec: 30,
    alertEvalSec: 60,
    applicationLabel: "lbl",
    defaultExchange: "JSE",
    fxExchange: "FX",
    moneyMarketExchange: "MM",
    ipsServer: "IPSAPI",
    ...overrides,
  } as WorkerEnv;
}

interface FakeChainable {
  select: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  eq: ReturnType<typeof vi.fn>;
  gte: ReturnType<typeof vi.fn>;
  is: ReturnType<typeof vi.fn>;
  in: ReturnType<typeof vi.fn>;
  order: ReturnType<typeof vi.fn>;
  limit: ReturnType<typeof vi.fn>;
  not: ReturnType<typeof vi.fn>;
}

/** A thenable chain: every chain method returns this object so the
 * evaluator can build `.from(...).select(...).eq(...).not(...).limit(...)`,
 * and `.limit(...)` resolves with the supplied `{ data, error }` payload. */
function makeChain(terminal: { data: unknown; error: unknown }) {
  const chain: Record<string, ReturnType<typeof vi.fn>> = {};
  const terminal_ = vi.fn().mockResolvedValue(terminal);
  chain.select = vi.fn().mockReturnValue(chain);
  chain.eq = vi.fn().mockReturnValue(chain);
  chain.not = vi.fn().mockReturnValue(chain);
  chain.is = vi.fn().mockReturnValue(chain);
  chain.in = vi.fn().mockReturnValue(chain);
  chain.order = vi.fn().mockReturnValue(chain);
  chain.gte = vi.fn().mockReturnValue(chain);
  chain.limit = terminal_;
  // Last chain method called — `.limit()` here — is awaited by the evaluator.
  return chain;
}

function makeFakeSupabase({
  notes,
  snapshots,
  insertError,
}: {
  notes: Array<Record<string, unknown>>;
  snapshots: Array<Record<string, unknown>>;
  insertError?: { code?: string; message: string };
}): { client: FakeChainable & { from: ReturnType<typeof vi.fn> } } {
  const notesChain = makeChain({ data: notes, error: null });
  const snapChain = makeChain({ data: snapshots, error: null });
  const insert = vi.fn().mockResolvedValue(
    insertError ? { data: null, error: insertError } : { data: [{ id: "row-1" }], error: null },
  );
  const update = vi.fn().mockReturnValue({
    eq: vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        gte: vi.fn().mockResolvedValue({ data: null, error: null }),
      }),
    }),
  });
  const client = {
    from: vi.fn((table: string) => {
      if (table === "research_note_c") return notesChain;
      if (table === "quote_snapshot_c") return snapChain;
      // alert_log_c / metadata updates
      const a: Record<string, ReturnType<typeof vi.fn>> = {};
      a.insert = insert;
      a.update = update;
      a.select = vi.fn().mockReturnValue(a);
      a.eq = vi.fn().mockReturnValue(a);
      a.gte = vi.fn().mockReturnValue(a);
      a.is = vi.fn().mockReturnValue(a);
      a.in = vi.fn().mockReturnValue(a);
      a.order = vi.fn().mockReturnValue(a);
      a.limit = vi.fn().mockResolvedValue({ data: [], error: null });
      a.not = vi.fn().mockReturnValue(a);
      return a;
    }),
    select: vi.fn(),
    insert,
    update,
    eq: vi.fn(),
    gte: vi.fn(),
    is: vi.fn(),
    in: vi.fn(),
    order: vi.fn(),
    limit: vi.fn(),
    not: vi.fn(),
  };
  return { client };
}

describe("evaluateTriggers — alert cycle (worker)", () => {
  const prevWebhook = process.env.ALERT_EMAIL_WEBHOOK_URL;
  const prevTo = process.env.ALERT_EMAIL_TO;

  beforeEach(() => {
    vi.restoreAllMocks();
    // Disable the optional email webhook so the tests stay deterministic.
    delete process.env.ALERT_EMAIL_WEBHOOK_URL;
    delete process.env.ALERT_EMAIL_TO;
  });

  afterEach(() => {
    if (prevWebhook == null) delete process.env.ALERT_EMAIL_WEBHOOK_URL;
    else process.env.ALERT_EMAIL_WEBHOOK_URL = prevWebhook;
    if (prevTo == null) delete process.env.ALERT_EMAIL_TO;
    else process.env.ALERT_EMAIL_TO = prevTo;
    // vi.unstubAllGlobals();
  });

  it("returns no-op result when there are no approved notes", async () => {
    const { client } = makeFakeSupabase({ notes: [], snapshots: [] });
    const r = await evaluateTriggers({ env: makeEnv(), supabase: client });
    expect(r.notes).toBe(0);
    expect(r.breached).toBe(0);
    expect(r.inserted).toBe(0);
  });

  it("writes a row when an approved note's BUY_BELOW trigger is breached", async () => {
    const notes = [
      {
        id: "n-1",
        symbol: "NPN",
        status: "approved",
        triggers: {
          buy_below: { price: 4000, note: "Adds full 2.0pp weight" },
        },
      },
    ];
    const snapshots = [
      { symbol: "NPN", last_price: 3995, observed_at: "2026-07-13T08:30:00Z" },
    ];
    const { client } = makeFakeSupabase({ notes, snapshots });
    const r = await evaluateTriggers({ env: makeEnv({ allowWrites: true }), supabase: client });
    expect(r.notes).toBe(1);
    expect(r.breached).toBe(1);
    expect(r.inserted).toBe(1);
    expect(client.insert).toHaveBeenCalledTimes(1);
    const call = (client.insert.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(call.symbol).toBe("NPN");
    expect(call.trigger_kind).toBe("buy_below");
    expect(call.trigger_price).toBe(4000);
    expect(call.observed_price).toBe(3995);
  });

  it("does NOT trigger when the observed price is on the wrong side of the level", async () => {
    const notes = [
      {
        id: "n-1",
        symbol: "NPN",
        status: "approved",
        triggers: {
          buy_below: { price: 4000, note: "Adds 2.0pp" },
          sell_above: { price: 5100, note: "Exit" },
        },
      },
    ];
    // Last = 4180 — between the two triggers. Nothing should fire.
    const snapshots = [{ symbol: "NPN", last_price: 4180, observed_at: "2026-07-13T08:30:00Z" }];
    const { client } = makeFakeSupabase({ notes, snapshots });
    const r = await evaluateTriggers({ env: makeEnv({ allowWrites: true }), supabase: client });
    expect(r.breached).toBe(0);
    expect(r.inserted).toBe(0);
  });

  it("respects dry-run: emits events but never writes", async () => {
    const notes = [
      {
        id: "n-1",
        symbol: "NPN",
        status: "approved",
        triggers: { stop_loss: { price: 3600, note: "Thesis break" } },
      },
    ];
    const snapshots = [{ symbol: "NPN", last_price: 3500, observed_at: "2026-07-13T08:30:00Z" }];
    const { client } = makeFakeSupabase({ notes, snapshots });
    const r = await evaluateTriggers({ env: makeEnv({ dryRun: true, allowWrites: true }), supabase: client });
    expect(r.breached).toBe(1);
    expect(r.skipped).toBe(1);
    expect(r.inserted).toBe(0);
    expect(client.insert).not.toHaveBeenCalled();
  });

  it("treats a unique-violation on insert (23505) as a success-path 'already fired today'", async () => {
    const notes = [
      {
        id: "n-1",
        symbol: "NPN",
        status: "approved",
        triggers: { trim_above: { price: 4700, note: "Trim 1.0pp" } },
      },
    ];
    const snapshots = [{ symbol: "NPN", last_price: 4800, observed_at: "2026-07-13T08:30:00Z" }];
    const { client } = makeFakeSupabase({
      notes,
      snapshots,
      insertError: { code: "23505", message: "duplicate key value violates unique constraint" },
    });
    const r = await evaluateTriggers({ env: makeEnv({ allowWrites: true }), supabase: client });
    expect(r.breached).toBe(1);
    expect(r.skipped).toBe(1);
    expect(r.inserted).toBe(0);
    expect(r.errors).toHaveLength(0);
  });
});

describe("evaluateTriggers — null / missing client", () => {
  it("returns an 'institutional Supabase client not configured' error if the client is null", async () => {
    const r = await evaluateTriggers({ env: makeEnv(), supabase: null });
    expect(r.notes).toBe(0);
    expect(r.errors).toContain("institutional Supabase client not configured");
  });
});