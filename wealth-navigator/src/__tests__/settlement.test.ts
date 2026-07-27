import { beforeEach, describe, expect, it } from "vitest";

import {
  observedFillFromAudit,
  planSettlement,
  settleFill,
  type ObservedFill,
} from "../../workers/iress-ingest/src/settlement";
import type { WorkerSupabase } from "../../workers/iress-ingest/src/supabase";

/**
 * Settlement is the only worker path that moves client money, so these tests
 * are written around the ways it could LOSE money rather than around its happy
 * path:
 *
 *   - applying the same fill twice (the poller re-reads filled orders forever)
 *   - applying a partial fill twice instead of incrementally
 *   - a 100x on the cost basis (avgPx is CENTS, wallets.balance is RANDS)
 *   - rewriting an existing lot's avg_fill, i.e. a client's cost basis
 *   - moving cash after the holdings write failed, or vice versa
 */

// --------------------------------------------------------------------------
// A small fake that behaves like PostgREST for the handful of calls settlement
// makes. It is deliberately strict: an unexpected table or a missing filter
// throws, so a test cannot pass because the double answered a question the real
// database would have refused.
// --------------------------------------------------------------------------

interface FakeState {
  ledger: Record<string, Record<string, unknown>>;
  wallets: Array<Record<string, unknown>>;
  holdings: Array<Record<string, unknown>>;
  securities: Array<Record<string, unknown>>;
  failOn?: { table: string; op: "insert" | "update" };
  /** Fires right after the wallet balance is READ, so a test can simulate
   *  another writer moving the balance between the plan and the apply. */
  onWalletRead?: () => void;
}

function makeDb(state: FakeState, allowed: string[]): WorkerSupabase {
  let seq = 0;
  const db = {
    from(table: string) {
      if (!allowed.includes(table)) {
        throw new Error(`fake ${allowed.join("/")} DB queried for "${table}" — wrong database`);
      }
      const filters: Record<string, unknown> = {};
      const rowsFor = (): Array<Record<string, unknown>> => {
        if (table === "wallets") return state.wallets;
        if (table === "stock_holdings_c") return state.holdings;
        if (table === "securities_c") return state.securities;
        return Object.values(state.ledger);
      };
      const matched = (): Array<Record<string, unknown>> =>
        rowsFor().filter((r) =>
          Object.entries(filters).every(([k, v]) =>
            v === null ? r[k] === null || r[k] === undefined : r[k] === v,
          ),
        );

      const chain: Record<string, unknown> = {};
      const self = () => chain;
      chain.select = self;
      chain.order = self;
      chain.eq = (k: string, v: unknown) => {
        filters[k] = v;
        return chain;
      };
      // `.is(col, null)` — used to scope the sell FIFO to the account holder's
      // own lots (family_member_id IS NULL). The double MUST honour it: a fake
      // that ignores the filter would let a test pass while the real query
      // reaches a child's shares.
      chain.is = (k: string, v: unknown) => {
        filters[k] = v === null ? null : v;
        return chain;
      };
      chain.limit = self;
      chain.maybeSingle = async () => {
        const hit = matched()[0] ?? null;
        // Snapshot, so a concurrent write after the read is not reflected in
        // the value the caller planned against — exactly like a real read.
        const snap = hit ? { ...hit } : null;
        if (table === "wallets" && hit) state.onWalletRead?.();
        return { data: snap, error: null };
      };
      chain.then = (res: (v: { data: unknown; error: unknown }) => unknown) => {
        // Snapshot before firing the hook, so a concurrent write after the read
        // is not visible in the value the caller planned against.
        const snap = matched().map((r) => ({ ...r }));
        if (table === "wallets" && snap.length) state.onWalletRead?.();
        return Promise.resolve({ data: snap, error: null }).then(res);
      };

      chain.insert = (row: Record<string, unknown>) => {
        if (state.failOn?.table === table && state.failOn.op === "insert") {
          return { select: async () => ({ data: null, error: { message: "injected insert failure" } }) };
        }
        const withId = { id: `new-${++seq}`, ...row };
        rowsFor().push(withId);
        return { select: async () => ({ data: [{ id: withId.id }], error: null }) };
      };

      chain.update = (patch: Record<string, unknown>) => {
        const upd: Record<string, unknown> = {};
        const u = {
          eq(k: string, v: unknown) {
            upd[k] = v;
            return u;
          },
          apply() {
            if (state.failOn?.table === table && state.failOn.op === "update") {
              return { data: null, error: { message: "injected update failure" } };
            }
            const hits = rowsFor().filter((r) => Object.entries(upd).every(([k, v]) => r[k] === v));
            for (const h of hits) Object.assign(h, patch);
            return { data: hits.map((h) => ({ user_id: h.user_id })), error: null };
          },
          select() {
            return Promise.resolve(u.apply());
          },
          then(res: (v: unknown) => unknown) {
            return Promise.resolve(u.apply()).then(res);
          },
        };
        return u;
      };

      chain.upsert = async (row: Record<string, unknown>) => {
        if (state.failOn?.table === table && state.failOn.op === "insert") {
          return { data: null, error: { message: "injected upsert failure" } };
        }
        const key = String(row.order_id);
        state.ledger[key] = { ...(state.ledger[key] ?? {}), ...row };
        return { data: null, error: null };
      };
      return chain;
    },
  };
  return db as unknown as WorkerSupabase;
}

const USER = "fc3a74f1-eaa6-43b6-b825-2bff1487e2a4";
const SEC = "286d17c4-a013-42b8-bdd7-9a1c0856fdfd";

/** Order 700002 — FSR.JO, 1 share, filled at 9600 CENTS = R96,00. */
const BUY_FILL: ObservedFill = {
  orderId: "700002",
  userId: USER,
  securityId: SEC,
  symbol: "FSR.JO",
  side: "buy",
  filledQty: 1,
  avgFillCents: 9600,
  strategy: "MANUAL",
  holdingId: null, // desk order — no lot exists yet
};

let state: FakeState;
let inst: WorkerSupabase;
let retail: WorkerSupabase;

function reset(over: Partial<FakeState> = {}) {
  state = {
    ledger: {},
    wallets: [{ id: "w-1", user_id: USER, balance: 1000, status: "active" }],
    holdings: [],
    // FSR marked at 9612c = R96,12 — deliberately DIFFERENT from the 9600c fill
    // so a test can tell the mark and the cost basis apart.
    securities: [{ id: SEC, last_price: 9612 }],
    ...over,
  };
  inst = makeDb(state, ["oems_fill_settlement_c"]);
  retail = makeDb(state, ["wallets", "stock_holdings_c", "securities_c"]);
}

const live = () => ({ institutional: inst, retail, enabled: true, dryRun: false });

beforeEach(() => reset());

describe("settlement — the money must be right", () => {
  it("debits R96,00 for a R96,00 fill, not R9 600,00", async () => {
    const r = await settleFill(live(), BUY_FILL);
    expect(r.error).toBeNull();
    expect(r.applied).toBe(true);
    expect(r.plan.cashDeltaRands).toBeCloseTo(-96.0, 2);
    expect(state.wallets[0]!.balance).toBeCloseTo(904.0, 2);
  });

  it("stores the cost basis in CENTS, matching the column", async () => {
    await settleFill(live(), BUY_FILL);
    expect(state.holdings).toHaveLength(1);
    expect(state.holdings[0]!.avg_fill).toBe(9600);
    expect(state.holdings[0]!.quantity).toBe(1);
    expect(state.holdings[0]!.trade_side).toBe("BUY");
    expect(state.holdings[0]!.is_active).toBe(true);
  });

  it("writes Expected_fill in RANDS and market_value in CENTS", async () => {
    // These two columns sit next to avg_fill holding the same price in DIFFERENT
    // units. Live rows prove it: GLPROP avg_fill 5086 / Expected_fill 50.86,
    // ADR 650 / 6.5, AME 5500 / 55. Getting either wrong is a 100x on a
    // client-facing number.
    await settleFill(live(), BUY_FILL);
    const lot = state.holdings[0]!;
    expect(lot.avg_fill).toBe(9600); // CENTS
    expect(lot.Expected_fill).toBeCloseTo(96.0, 2); // RANDS — NOT 9600
    expect(lot.market_value).toBe(9612); // CENTS, marked at the live price
  });

  it("falls back to the fill price when the security has no live mark", async () => {
    reset({ securities: [{ id: SEC, last_price: 0 }] });
    await settleFill(live(), BUY_FILL);
    expect(state.holdings[0]!.market_value).toBe(9600);
  });

  it("applying the same fill twice does NOT debit twice", async () => {
    await settleFill(live(), BUY_FILL);
    const second = await settleFill(live(), BUY_FILL);
    expect(second.applied).toBe(false);
    expect(second.plan.deltaQty).toBe(0);
    expect(state.wallets[0]!.balance).toBeCloseTo(904.0, 2);
    expect(state.holdings).toHaveLength(1); // no phantom second lot
  });

  it("ten poll cycles over one filled order still debit exactly once", async () => {
    for (let i = 0; i < 10; i++) await settleFill(live(), BUY_FILL);
    expect(state.wallets[0]!.balance).toBeCloseTo(904.0, 2);
    expect(state.holdings).toHaveLength(1);
  });

  /**
   * The case that exposed the bug. avgPx is the order-wide volume-weighted
   * average — Andre Pietersen (IRESS), 2026-07-27: "the average of the partial
   * fills will basically be what the order traded for on average... that is the
   * field you are going to want to use". Juan's rule follows: a client is
   * measured on their average fill.
   *
   * So total cash MUST equal filledQty x avgPx. Pricing each slice at the
   * running average silently violates that as soon as the price moves:
   *   40 @ avg 100 -> 4 000, then 60 @ avg 110 -> 6 600, total 10 600
   *   truth: 100 x 110 = 11 000.   R4 adrift on one order.
   */
  it("keeps total cash equal to filledQty x avgPx when the price MOVES mid-order", async () => {
    reset({ wallets: [{ id: "w-1", user_id: USER, balance: 20000, status: "active" }], securities: [{ id: SEC, last_price: 110 }] });

    // Slice 1: 40 filled, order-wide average 100c = R1,00.
    await settleFill(live(), { ...BUY_FILL, filledQty: 40, avgFillCents: 100 });
    expect(state.wallets[0]!.balance).toBeCloseTo(19960.0, 2); // -R40,00

    // Slice 2: 100 filled, order-wide average has risen to 110c = R1,10.
    const r = await settleFill(live(), { ...BUY_FILL, filledQty: 100, avgFillCents: 110 });
    expect(r.applied).toBe(true);
    expect(r.plan.deltaQty).toBe(60);

    // THE invariant: total moved == 100 x R1,10 == R110,00. Not R106,00.
    expect(state.wallets[0]!.balance).toBeCloseTo(19890.0, 2);
    const totalMoved = 20000 - Number(state.wallets[0]!.balance);
    expect(totalMoved).toBeCloseTo(110.0, 2);

    // And the second lot is priced at what those 60 shares actually cost —
    // (11 000 - 4 000) / 60 = 116,67c — not the 110c order-wide average.
    expect(state.holdings).toHaveLength(2);
    expect(state.holdings[0]!.avg_fill).toBe(100);
    expect(state.holdings[1]!.avg_fill).toBe(117); // 116.67 rounded to the cent
    // The lot ledger sums back to the order total, so the cost basis is right.
    const lotCost = state.holdings.reduce(
      (sum, h) => sum + (Number(h.quantity) * Number(h.avg_fill)) / 100,
      0,
    );
    expect(lotCost).toBeCloseTo(110.2, 1); // within a rounding cent of R110,00
  });

  it("records settled_cash_rands as a RUNNING TOTAL, not the last slice", async () => {
    // planSettlement subtracts this from filledQty x avgPx. If it held a delta,
    // every partial after the first would mis-price itself.
    reset({ wallets: [{ id: "w-1", user_id: USER, balance: 20000, status: "active" }], securities: [{ id: SEC, last_price: 110 }] });
    await settleFill(live(), { ...BUY_FILL, filledQty: 40, avgFillCents: 100 });
    expect(state.ledger["700002"]!.settled_cash_rands).toBeCloseTo(-40.0, 2);
    await settleFill(live(), { ...BUY_FILL, filledQty: 100, avgFillCents: 110 });
    expect(state.ledger["700002"]!.settled_cash_rands).toBeCloseTo(-110.0, 2); // total, not -70
    expect(state.ledger["700002"]!.settled_qty).toBe(100);
  });

  it("settles a partial fill incrementally, never cumulatively", async () => {
    // 40 of 100 fill, then the rest. The second slice must cost 60, not 100.
    await settleFill(live(), { ...BUY_FILL, filledQty: 40, avgFillCents: 100 });
    expect(state.wallets[0]!.balance).toBeCloseTo(960.0, 2); // -R40,00

    const r = await settleFill(live(), { ...BUY_FILL, filledQty: 100, avgFillCents: 100 });
    expect(r.plan.alreadySettledQty).toBe(40);
    expect(r.plan.deltaQty).toBe(60);
    expect(state.wallets[0]!.balance).toBeCloseTo(900.0, 2); // -R60,00 more
    expect(state.holdings).toHaveLength(2);
    expect(state.holdings.reduce((s, h) => s + Number(h.quantity), 0)).toBe(100);
  });
});

describe("settlement — a client's cost basis is never rewritten", () => {
  it("appends a lot instead of averaging into the existing one", async () => {
    reset({
      holdings: [
        {
          id: "existing-lot",
          user_id: USER,
          security_id: SEC,
          quantity: 5,
          avg_fill: 8000, // R80,00 — set in stone
          is_active: true,
          created_at: "2026-01-01T00:00:00Z",
        },
      ],
    });
    await settleFill(live(), BUY_FILL);
    const existing = state.holdings.find((h) => h.id === "existing-lot");
    expect(existing?.avg_fill).toBe(8000); // untouched
    expect(existing?.quantity).toBe(5); // untouched
    expect(state.holdings).toHaveLength(2);
    expect(state.holdings[1]!.avg_fill).toBe(9600);
  });
});

describe("settlement — sells close lots FIFO", () => {
  beforeEach(() => {
    reset({
      wallets: [{ id: "w-1", user_id: USER, balance: 100, status: "active" }],
      holdings: [
        { id: "lot-old", user_id: USER, security_id: SEC, quantity: 3, avg_fill: 8000, is_active: true, created_at: "2026-01-01T00:00:00Z" },
        { id: "lot-new", user_id: USER, security_id: SEC, quantity: 4, avg_fill: 9000, is_active: true, created_at: "2026-06-01T00:00:00Z" },
      ],
    });
  });

  it("credits the wallet and closes the oldest lot first", async () => {
    const r = await settleFill(live(), { ...BUY_FILL, side: "sell", filledQty: 3, avgFillCents: 9600 });
    expect(r.applied).toBe(true);
    expect(state.wallets[0]!.balance).toBeCloseTo(388.0, 2); // 100 + 3 x 96
    const old = state.holdings.find((h) => h.id === "lot-old");
    expect(old?.is_active).toBe(false);
    expect(old?.avg_exit).toBe(9600);
    expect(old?.avg_fill).toBe(8000); // entry basis preserved for realised P&L
    expect(state.holdings.find((h) => h.id === "lot-new")?.is_active).toBe(true);
  });

  it("splits a lot on a partial sell, preserving the original entry price", async () => {
    await settleFill(live(), { ...BUY_FILL, side: "sell", filledQty: 5, avgFillCents: 9600 });
    // lot-old (3) fully closed; lot-new (4) split into 2 closed + 2 still open.
    expect(state.holdings.find((h) => h.id === "lot-old")?.is_active).toBe(false);
    const remainder = state.holdings.find((h) => h.id === "lot-new");
    expect(remainder?.quantity).toBe(2);
    expect(remainder?.is_active).toBe(true);
    expect(remainder?.avg_fill).toBe(9000); // untouched
    const split = state.holdings.find((h) => h.closed_reason === "iress-settlement:700002" && h.quantity === 2);
    expect(split?.avg_fill).toBe(9000); // carried, NOT reset
    expect(split?.avg_exit).toBe(9600);
    expect(split?.is_active).toBe(false);
  });

  it("refuses to invent a position when selling more than is held", async () => {
    const r = await settleFill(live(), { ...BUY_FILL, side: "sell", filledQty: 99, avgFillCents: 9600 });
    expect(r.applied).toBe(false);
    expect(r.error).toMatch(/unaccounted/);
    expect(state.wallets[0]!.balance).toBe(100); // nothing moved
  });
});

describe("settlement — failure never leaves money half-moved", () => {
  it("rolls the claim back when the holdings write fails", async () => {
    reset({ failOn: { table: "stock_holdings_c", op: "insert" } });
    const r = await settleFill(live(), BUY_FILL);
    expect(r.applied).toBe(false);
    expect(r.error).toMatch(/holding insert failed/);
    expect(state.wallets[0]!.balance).toBe(1000); // cash untouched
    expect(state.ledger["700002"]!.settled_qty).toBe(0); // claim rolled back
    expect(state.ledger["700002"]!.last_error).toMatch(/holding insert failed/);
  });

  it("retries cleanly on the next cycle after a failure", async () => {
    reset({ failOn: { table: "stock_holdings_c", op: "insert" } });
    await settleFill(live(), BUY_FILL);
    state.failOn = undefined; // transient error clears
    const r = await settleFill(live(), BUY_FILL);
    expect(r.applied).toBe(true);
    expect(state.wallets[0]!.balance).toBeCloseTo(904.0, 2);
    expect(state.holdings).toHaveLength(1); // exactly one, not two
  });

  /**
   * The contract after the 2026-07-27 audit. Once ANY row has landed in RETAIL
   * the claim MUST STAND, even though the cash did not move.
   *
   * The first version un-claimed unconditionally. That looks safe and is not:
   * the lot had already been inserted, so the next cycle re-planned the full
   * delta and inserted a SECOND lot — once per poll, forever. Un-claiming after
   * a write silently converts claim-first into apply-then-record, the exact mode
   * the whole design exists to avoid.
   *
   * Under-applying is the intended failure: shares recorded, cash not moved,
   * discrepancy sitting in last_error for a human. Never double-applying.
   */
  it("holds the claim when the wallet write loses a race — never mints a second lot", async () => {
    let fired = false;
    state.onWalletRead = () => {
      if (fired) return;
      fired = true;
      state.wallets[0]!.balance = 1500; // a client deposit lands mid-settlement
    };
    const r = await settleFill(live(), BUY_FILL);
    expect(r.applied).toBe(false);
    expect(state.wallets[0]!.balance).toBe(1500); // the deposit survives
    expect(state.holdings).toHaveLength(1); // the lot landed

    // The claim STANDS at the quantity that actually landed, flagged.
    expect(state.ledger["700002"]!.settled_qty).toBe(1);
    expect(String(state.ledger["700002"]!.last_error)).toMatch(/PARTIALLY APPLIED/);

    // THE point: the next cycle must not re-apply anything.
    state.onWalletRead = undefined;
    const retry = await settleFill(live(), BUY_FILL);
    expect(retry.plan.deltaQty).toBe(0);
    expect(state.holdings).toHaveLength(1); // still ONE lot, not two
    expect(state.wallets[0]!.balance).toBe(1500); // still not debited
  });

  it("un-claims cleanly when nothing reached RETAIL", async () => {
    // The other half of the contract: no write, no claim. Safe to retry in full.
    reset({ failOn: { table: "stock_holdings_c", op: "insert" } });
    const r = await settleFill(live(), BUY_FILL);
    expect(r.applied).toBe(false);
    expect(state.ledger["700002"]!.settled_qty).toBe(0);
    expect(String(state.ledger["700002"]!.last_error)).not.toMatch(/PARTIALLY APPLIED/);
    state.failOn = undefined;
    const retry = await settleFill(live(), BUY_FILL);
    expect(retry.applied).toBe(true);
    expect(state.holdings).toHaveLength(1);
  });
});

/**
 * The MINT app books the position and takes the cash at PURCHASE time —
 * record-investment.js inserts the lot and debits the wallet before the order is
 * even parked (holding efd2ffae… created 10:01:43, order parked 10:01:45). Only
 * the actual fill price is missing. Creating a lot here would give the client two
 * positions and two debits for one purchase.
 */
describe("settlement — app orders are reconciled, never re-bought", () => {
  const APP_FILL = { ...BUY_FILL, holdingId: "app-lot-1" };

  beforeEach(() => {
    reset({
      holdings: [
        {
          id: "app-lot-1",
          user_id: USER,
          security_id: SEC,
          quantity: 1,
          avg_fill: null, // the app never knows the fill price
          Expected_fill: 102.489, // RANDS, what the app charged
          is_active: true,
          created_at: "2026-07-27T10:01:43Z",
        },
      ],
    });
  });

  it("stamps the real fill onto the existing lot", async () => {
    const r = await settleFill(live(), APP_FILL);
    expect(r.applied).toBe(true);
    expect(r.plan.mode).toBe("reconcile");
    expect(state.holdings).toHaveLength(1); // NOT two
    expect(state.holdings[0]!.avg_fill).toBe(9600);
  });

  it("does NOT debit the wallet a second time", async () => {
    await settleFill(live(), APP_FILL);
    expect(state.wallets[0]!.balance).toBe(1000); // untouched
    expect(state.ledger["700002"]!.settled_cash_rands).toBe(0);
  });

  it("reports the charged-vs-actual variance instead of silently moving cash", async () => {
    const r = await settleFill(live(), APP_FILL);
    // charged 1 x R102,489 against an actual R96,00.
    expect(r.plan.cashVarianceRands).toBeCloseTo(6.49, 2);
    expect(state.wallets[0]!.balance).toBe(1000);
  });

  it("refuses when the order names a holding that does not exist", async () => {
    const p = await planSettlement({ institutional: inst, retail }, { ...APP_FILL, holdingId: "ghost" });
    expect(p.blocked).toMatch(/does not exist/);
  });
});

/**
 * A minor's holdings sit under the PARENT's user_id, distinguished only by
 * family_member_id. Live data has users holding both their own and a child's lots
 * on the same security, with identical created_at values. FIFO without the filter
 * liquidates a child's shares to pay an adult.
 */
describe("settlement — a sell never reaches a child's shares", () => {
  beforeEach(() => {
    reset({
      wallets: [{ id: "w-1", user_id: USER, balance: 0, status: "active" }],
      holdings: [
        // The CHILD's lot is older, so plain FIFO would take it first.
        { id: "child-lot", user_id: USER, security_id: SEC, quantity: 5, avg_fill: 5000, is_active: true, family_member_id: "kid-1", created_at: "2026-01-01T00:00:00Z" },
        { id: "own-lot", user_id: USER, security_id: SEC, quantity: 5, avg_fill: 9000, is_active: true, family_member_id: null, created_at: "2026-06-01T00:00:00Z" },
      ],
    });
  });

  it("closes the holder's own lot and leaves the child's untouched", async () => {
    const r = await settleFill(live(), { ...BUY_FILL, side: "sell", filledQty: 5, avgFillCents: 9600 });
    expect(r.applied).toBe(true);
    expect(state.holdings.find((h) => h.id === "child-lot")!.is_active).toBe(true);
    expect(state.holdings.find((h) => h.id === "own-lot")!.is_active).toBe(false);
    expect(state.wallets[0]!.balance).toBeCloseTo(480.0, 2);
  });

  it("refuses rather than dipping into a child's lot for the shortfall", async () => {
    const r = await settleFill(live(), { ...BUY_FILL, side: "sell", filledQty: 8, avgFillCents: 9600 });
    expect(r.applied).toBe(false);
    expect(r.error).toMatch(/unaccounted/);
    expect(state.holdings.find((h) => h.id === "child-lot")!.is_active).toBe(true);
    expect(state.wallets[0]!.balance).toBe(0);
  });
});

describe("settlement — a user with two wallet rows", () => {
  it("settles against the ACTIVE wallet, not the test one", async () => {
    // wallets is unique on (user_id, status), so both can exist. A bare
    // maybeSingle() on user_id throws and blocks the user permanently.
    reset({
      wallets: [
        { id: "w-test", user_id: USER, balance: 322910, status: "test" },
        { id: "w-live", user_id: USER, balance: 1000, status: "active" },
      ],
    });
    const r = await settleFill(live(), BUY_FILL);
    expect(r.applied).toBe(true);
    expect(r.plan.walletId).toBe("w-live");
    expect(state.wallets.find((w) => w.id === "w-live")!.balance).toBeCloseTo(904.0, 2);
    expect(state.wallets.find((w) => w.id === "w-test")!.balance).toBe(322910); // untouched
  });
});

describe("settlement — gates", () => {
  it("writes nothing when disabled", async () => {
    const r = await settleFill({ institutional: inst, retail, enabled: false, dryRun: false }, BUY_FILL);
    expect(r.applied).toBe(false);
    expect(state.wallets[0]!.balance).toBe(1000);
    expect(state.holdings).toHaveLength(0);
  });

  it("writes nothing in dry run, but reports the exact deltas", async () => {
    const r = await settleFill({ institutional: inst, retail, enabled: true, dryRun: true }, BUY_FILL);
    expect(r.applied).toBe(false);
    expect(r.dryRun).toBe(true);
    expect(r.plan.walletBefore).toBe(1000);
    expect(r.plan.walletAfter).toBeCloseTo(904.0, 2);
    expect(r.plan.lotsToOpen).toEqual([{ quantity: 1, avgFillCents: 9600, unitMarkCents: 9612 }]);
    expect(state.wallets[0]!.balance).toBe(1000); // untouched
    expect(state.holdings).toHaveLength(0);
  });
});

describe("settlement — refuses to guess", () => {
  it("blocks a fill with no average price rather than booking a zero cost basis", async () => {
    const p = await planSettlement({ institutional: inst, retail }, { ...BUY_FILL, avgFillCents: 0 });
    expect(p.blocked).toMatch(/no average price/);
  });

  it("blocks when the client has no wallet", async () => {
    reset({ wallets: [] });
    const p = await planSettlement({ institutional: inst, retail }, BUY_FILL);
    expect(p.blocked).toMatch(/no wallet/);
  });

  it("blocks an order with no client attribution", async () => {
    const p = await planSettlement({ institutional: inst, retail }, { ...BUY_FILL, userId: "" });
    expect(p.blocked).toMatch(/no user_id/);
  });

  it("records the buy even if it overdraws — the trade already happened", async () => {
    reset({ wallets: [{ id: "w-1", user_id: USER, balance: 10, status: "active" }] });
    const r = await settleFill(live(), BUY_FILL);
    expect(r.applied).toBe(true);
    expect(state.wallets[0]!.balance).toBeCloseTo(-86.0, 2);
    expect(state.holdings).toHaveLength(1);
  });
});

describe("observedFillFromAudit", () => {
  const row = {
    order_id: "700002",
    symbol: "FSR.JO",
    side: "buy",
    status: "filled",
    payload: { user_id: USER, security_id: SEC, filled: 1, avgPx: 9600, strategy: "MANUAL" },
  };

  it("reads a filled client order", () => {
    expect(observedFillFromAudit(row)).toEqual({
      orderId: "700002",
      userId: USER,
      securityId: SEC,
      symbol: "FSR.JO",
      side: "buy",
      filledQty: 1,
      avgFillCents: 9600,
      strategy: "MANUAL",
      holdingId: null,
    });
  });

  it("reads a partial too — money must move as it fills", () => {
    expect(observedFillFromAudit({ ...row, status: "partial" })?.filledQty).toBe(1);
  });

  it("ignores non-executions", () => {
    for (const status of ["parked", "working", "cancelled", "rejected", "expired", "failed"]) {
      expect(observedFillFromAudit({ ...row, status })).toBeNull();
    }
  });

  it("ignores a desk order with no client attribution", () => {
    expect(observedFillFromAudit({ ...row, payload: { ...row.payload, user_id: undefined } })).toBeNull();
  });

  it("ignores a filled row that carries no price", () => {
    expect(observedFillFromAudit({ ...row, payload: { ...row.payload, avgPx: 0 } })).toBeNull();
  });
});
