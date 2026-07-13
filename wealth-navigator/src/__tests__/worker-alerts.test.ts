import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { WorkerEnv } from "../../workers/iress-ingest/src/env";
import type { WorkerSupabase } from "../../workers/iress-ingest/src/supabase";
import { evaluateTriggers } from "../../workers/iress-ingest/src/alerts";

/**
 * Alert-cycle unit tests for the worker. The evaluator hits three
 * Supabase clients:
 *   1. Institutional — research_note_c, alert_log_c, and (tertiary)
 *      quote_snapshot_c keyed by security_code.
 *   2. Retail — stock_intraday_c (live ticks in cents) + securities_c
 *      fallback (also cents). Triggers store RANDS so cents are
 *      converted before comparison.
 * We stub both clients with thenable chains so the suite stays hermetic.
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

/** Thenable chain — every chain method returns the chain itself, with
 * `limit()` (or whichever terminal key was supplied) resolving with the
 * given `{ data, error }` payload. */
function makeChain(terminal: { data: unknown; error: unknown }, terminalKey = "limit") {
  const chain: Record<string, ReturnType<typeof vi.fn>> = {};
  const term = vi.fn().mockResolvedValue(terminal);
  chain.select = vi.fn().mockReturnValue(chain);
  chain.eq = vi.fn().mockReturnValue(chain);
  chain.not = vi.fn().mockReturnValue(chain);
  chain.is = vi.fn().mockReturnValue(chain);
  chain.in = vi.fn().mockReturnValue(chain);
  chain.order = vi.fn().mockReturnValue(chain);
  chain.gte = vi.fn().mockReturnValue(chain);
  chain[terminalKey] = term;
  return chain;
}

interface Stubs {
  institutional: WorkerSupabase;
  retail: WorkerSupabase;
  insert: ReturnType<typeof vi.fn>;
}

interface StubsArgs {
  notes: Array<Record<string, unknown>>;
  /** Live ticks on the RETAIL DB. Use CENTS. */
  intraday: Array<{ symbol: string; current_price: number; timestamp: string }>;
  /** End-of-day reference on the RETAIL DB. Use CENTS. */
  securities?: Array<{ symbol: string; last_price: number }>;
  insertError?: { code?: string; message: string };
  /** Custom update handler for `alert_log_c`. Provide to override the
   * default update chain returned by `makeFakeSupabase`. */
  alertLogUpdate?: ReturnType<typeof vi.fn>;
}

function makeFakeClients({
  notes,
  intraday,
  securities = [],
  insertError,
  alertLogUpdate,
}: StubsArgs): { stubs: Stubs } {
  const insert = vi.fn().mockResolvedValue(
    insertError ? { data: null, error: insertError } : { data: [{ id: "row-1" }], error: null },
  );

  // Institutional — research_note_c + alert_log_c. alert_log_c uses an
  // optional custom update chain so the breached_date-eq path can be
  // spied on; otherwise we fall back to a 3-level eq chain.
  const eqThird = vi.fn().mockResolvedValue({ data: null, error: null });
  const eqSecond = vi.fn().mockReturnValue({ eq: eqThird });
  const eqFirst = vi.fn().mockReturnValue({ eq: eqSecond });
  const defaultUpdate = vi.fn().mockReturnValue({ eq: eqFirst });
  const institutional = {
    from: vi.fn((table: string) => {
      if (table === "research_note_c") {
        return makeChain({ data: notes, error: null }, "limit");
      }
      if (table === "quote_snapshot_c") {
        // Always returns empty in this suite — the tertiary path is
        // exercised separately if at all.
        return makeChain({ data: [], error: null }, "limit");
      }
      // alert_log_c
      const a: Record<string, ReturnType<typeof vi.fn>> = {};
      a.insert = insert;
      a.update = alertLogUpdate ?? defaultUpdate;
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
    update: defaultUpdate,
    eq: vi.fn(),
    gte: vi.fn(),
    is: vi.fn(),
    in: vi.fn(),
    order: vi.fn(),
    limit: vi.fn(),
    not: vi.fn(),
  };

  // Retail — stock_intraday_c (live) + securities_c (fallback).
  const retail = {
    from: vi.fn((table: string) => {
      if (table === "stock_intraday_c") {
        return makeChain({ data: intraday, error: null }, "limit");
      }
      if (table === "securities_c") {
        return makeChain({ data: securities, error: null }, "limit");
      }
      // symbols_c (tertiary RIC lookup) returns nothing.
      return makeChain({ data: [], error: null }, "limit");
    }),
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    eq: vi.fn(),
    gte: vi.fn(),
    is: vi.fn(),
    in: vi.fn(),
    order: vi.fn(),
    limit: vi.fn(),
    not: vi.fn(),
  };

  return {
    stubs: {
      institutional: institutional as unknown as WorkerSupabase,
      retail: retail as unknown as WorkerSupabase,
      insert,
    },
  };
}

describe("evaluateTriggers — alert cycle (worker)", () => {
  const prevWebhook = process.env.ALERT_EMAIL_WEBHOOK_URL;
  const prevTo = process.env.ALERT_EMAIL_TO;

  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env.ALERT_EMAIL_WEBHOOK_URL;
    delete process.env.ALERT_EMAIL_TO;
  });

  afterEach(() => {
    if (prevWebhook == null) delete process.env.ALERT_EMAIL_WEBHOOK_URL;
    else process.env.ALERT_EMAIL_WEBHOOK_URL = prevWebhook;
    if (prevTo == null) delete process.env.ALERT_EMAIL_TO;
    else process.env.ALERT_EMAIL_TO = prevTo;
  });

  it("returns no-op result when there are no approved notes", async () => {
    const { stubs } = makeFakeClients({ notes: [], intraday: [] });
    const r = await evaluateTriggers({
      env: makeEnv(),
      supabase: stubs.institutional,
      retailSupabase: stubs.retail,
    });
    expect(r.notes).toBe(0);
    expect(r.breached).toBe(0);
    expect(r.inserted).toBe(0);
  });

  it("writes a row when an approved note's BUY_BELOW trigger is breached on the retail intraday tick", async () => {
    const notes = [
      {
        id: "n-1",
        symbol: "NPN",
        status: "approved",
        triggers: { buy_below: { price: 4000, note: "Adds full 2.0pp weight" } },
      },
    ];
    // R3,995 in rands = 399500 in cents (last tick).
    const intraday = [{ symbol: "NPN", current_price: 399500, timestamp: "2026-07-13T08:30:00Z" }];
    const { stubs } = makeFakeClients({ notes, intraday });
    const r = await evaluateTriggers({
      env: makeEnv({ allowWrites: true }),
      supabase: stubs.institutional,
      retailSupabase: stubs.retail,
    });
    expect(r.notes).toBe(1);
    expect(r.breached).toBe(1);
    expect(r.inserted).toBe(1);
    expect(stubs.insert).toHaveBeenCalledTimes(1);
    const call = (stubs.insert.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(call.symbol).toBe("NPN");
    expect(call.trigger_kind).toBe("buy_below");
    expect(call.trigger_price).toBe(4000);
    // rands, not cents — the comparison was made in rands.
    expect(call.observed_price).toBe(3995);
  });

  it("falls back to securities_c when no intraday tick exists", async () => {
    const notes = [
      {
        id: "n-2",
        symbol: "NPN",
        status: "approved",
        triggers: { sell_above: { price: 5100, note: "Exit" } },
      },
    ];
    // No intraday tick (empty), but securities_c carries a cents last_price
    // equivalent to R5,120 → breach on sell_above.
    const securities = [{ symbol: "NPN", last_price: 512000 }];
    const { stubs } = makeFakeClients({ notes, intraday: [], securities });
    const r = await evaluateTriggers({
      env: makeEnv({ allowWrites: true }),
      supabase: stubs.institutional,
      retailSupabase: stubs.retail,
    });
    expect(r.breached).toBe(1);
    expect(r.inserted).toBe(1);
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
    // R4,180 between the two triggers. cents → 418000.
    const intraday = [{ symbol: "NPN", current_price: 418000, timestamp: "2026-07-13T08:30:00Z" }];
    const { stubs } = makeFakeClients({ notes, intraday });
    const r = await evaluateTriggers({
      env: makeEnv({ allowWrites: true }),
      supabase: stubs.institutional,
      retailSupabase: stubs.retail,
    });
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
    // R3,500 cents → 350000. stop_loss: observed ≤ level (3500 ≤ 3600).
    const intraday = [{ symbol: "NPN", current_price: 350000, timestamp: "2026-07-13T08:30:00Z" }];
    const { stubs } = makeFakeClients({ notes, intraday });
    const r = await evaluateTriggers({
      env: makeEnv({ dryRun: true, allowWrites: true }),
      supabase: stubs.institutional,
      retailSupabase: stubs.retail,
    });
    expect(r.breached).toBe(1);
    expect(r.skipped).toBe(1);
    expect(r.inserted).toBe(0);
    expect(stubs.insert).not.toHaveBeenCalled();
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
    // R4,800 cents → 480000. trim_above: observed ≥ level (4800 ≥ 4700).
    const intraday = [{ symbol: "NPN", current_price: 480000, timestamp: "2026-07-13T08:30:00Z" }];
    const { stubs } = makeFakeClients({
      notes,
      intraday,
      insertError: { code: "23505", message: "duplicate key value violates unique constraint" },
    });
    const r = await evaluateTriggers({
      env: makeEnv({ allowWrites: true }),
      supabase: stubs.institutional,
      retailSupabase: stubs.retail,
    });
    expect(r.breached).toBe(1);
    expect(r.skipped).toBe(1);
    expect(r.inserted).toBe(0);
    expect(r.errors).toHaveLength(0);
  });

  it("stamps email_sent_at against the same-day breached_date row when the webhook fires", async () => {
    process.env.ALERT_EMAIL_WEBHOOK_URL = "https://example.test/alerts";
    process.env.ALERT_EMAIL_TO = "ops@mint.test";
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200 } as unknown as Response);
    vi.stubGlobal("fetch", fetchSpy);

    const eqThird = vi.fn().mockResolvedValue({ data: null, error: null });
    const eqSecond = vi.fn().mockReturnValue({ eq: eqThird });
    const eqFirst = vi.fn().mockReturnValue({ eq: eqSecond });
    const alertLogUpdate = vi.fn().mockReturnValue({ eq: eqFirst });

    const notes = [
      {
        id: "n-1",
        symbol: "NPN",
        status: "approved",
        triggers: { buy_below: { price: 4000, note: "Adds 2.0pp" } },
      },
    ];
    const intraday = [{ symbol: "NPN", current_price: 399500, timestamp: "2026-07-13T08:30:00Z" }];
    const { stubs } = makeFakeClients({ notes, intraday, alertLogUpdate });

    const r = await evaluateTriggers({
      env: makeEnv({ allowWrites: true }),
      supabase: stubs.institutional,
      retailSupabase: stubs.retail,
    });
    expect(r.inserted).toBe(1);
    expect(r.emailed).toBe(1);
    // The deepest `eq` in the chain receives `(breached_date, <todayUtc>)`.
    expect(eqThird).toHaveBeenCalledTimes(1);
    const eqThirdArgs = eqThird.mock.calls[0];
    expect(eqThirdArgs?.[0]).toBe("breached_date");
    expect(eqThirdArgs?.[1]).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    vi.unstubAllGlobals();
  });
});

describe("evaluateTriggers — null / missing client", () => {
  it("returns an 'institutional Supabase client not configured' error if the client is null", async () => {
    const r = await evaluateTriggers({ env: makeEnv(), supabase: null });
    expect(r.notes).toBe(0);
    expect(r.errors).toContain("institutional Supabase client not configured");
  });
});