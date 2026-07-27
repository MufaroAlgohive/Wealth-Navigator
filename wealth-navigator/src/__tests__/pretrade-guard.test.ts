import { describe, expect, it } from "vitest";

import {
  availableToBuy,
  availableToBuyForClient,
  availableToSell,
  availableToSellForClient,
  resolveHolderKind,
} from "../../workers/iress-ingest/src/pretrade-guard";
import type { WorkerSupabase } from "../../workers/iress-ingest/src/supabase";

/**
 * Pre-trade naked-short guard. IRESS does not block oversells, so this is the
 * gate that stops selling more than we hold. These tests pin the two position
 * sources (IPS settled position vs derived-from-filled-orders), the open-sell
 * reservation, and fail-closed behaviour.
 */

type PosRow = { quantity: number } | null;
type AcctRow = { cash_balance: number } | null;
type AuditRow = {
  id: string;
  side: string;
  quantity: number;
  status: string;
  payload: Record<string, unknown> | null;
  price_cents?: number | null;
  result_payload?: Record<string, unknown> | null;
};

/**
 * Minimal Supabase stub. Single-row reads (oems_position_c, oems_account_c) end
 * in .maybeSingle(); the oems_order_audit query is awaited.
 */
function fakeDb(opts: {
  position?: PosRow;
  positionError?: string;
  account?: AcctRow;
  accountError?: string;
  audit?: AuditRow[];
  auditError?: string;
}): WorkerSupabase {
  return {
    from(table: string) {
      const builder: Record<string, unknown> = {};
      const chain = () => builder;
      builder.select = chain;
      builder.eq = chain;
      builder.in = chain;
      builder.maybeSingle = () =>
        Promise.resolve(
          table === "oems_position_c"
            ? { data: opts.position ?? null, error: opts.positionError ? { message: opts.positionError } : null }
            : table === "oems_account_c"
              ? { data: opts.account ?? null, error: opts.accountError ? { message: opts.accountError } : null }
              : { data: null, error: null },
        );
      // Awaiting the builder (audit query) resolves the rows.
      builder.then = (resolve: (v: unknown) => unknown) =>
        Promise.resolve({
          data: table === "oems_order_audit" ? opts.audit ?? [] : [],
          error: opts.auditError ? { message: opts.auditError } : null,
        }).then(resolve);
      return builder;
    },
  } as unknown as WorkerSupabase;
}

const buy = (id: string, quantity: number, status = "filled", filled?: number): AuditRow => ({
  id,
  side: "buy",
  quantity,
  status,
  payload: filled != null ? { filled } : null,
});
const sell = (id: string, quantity: number, status = "working", filled?: number): AuditRow => ({
  id,
  side: "sell",
  quantity,
  status,
  payload: filled != null ? { filled } : null,
});

describe("availableToSell", () => {
  it("derives held from filled UAT buys when there is no IPS position (the CAC scenario)", async () => {
    // Bought 100 (filled), no sells → available 100. Selling 150 must be blocked.
    const db = fakeDb({ position: null, audit: [buy("b1", 100)] });
    const r = await availableToSell(db, "56378", "CAC", "current-sell");
    expect(r.source).toBe("derived");
    expect(r.held).toBe(100);
    expect(r.available).toBe(100);
    expect(150 > r.available).toBe(true); // guard blocks
    expect(100 > r.available).toBe(false); // selling exactly 100 is allowed
  });

  it("prefers the IPS settled position when oems_position_c has a row", async () => {
    const db = fakeDb({ position: { quantity: 40 }, audit: [buy("b1", 100)] });
    const r = await availableToSell(db, "56378", "CAC");
    expect(r.source).toBe("ips");
    expect(r.held).toBe(40);
    expect(r.available).toBe(40);
  });

  it("reserves other open sells so two sells can't each drain the position", async () => {
    // Held 100, an open sell of 60 already working → only 40 left to sell.
    const db = fakeDb({ position: null, audit: [buy("b1", 100), sell("s1", 60, "working")] });
    const r = await availableToSell(db, "56378", "CAC", "current-sell");
    expect(r.held).toBe(100);
    expect(r.inflightSells).toBe(60);
    expect(r.available).toBe(40);
  });

  it("excludes the order being sent from the open-sell reservation", async () => {
    const db = fakeDb({ position: null, audit: [buy("b1", 100), sell("self", 100, "working")] });
    const r = await availableToSell(db, "56378", "CAC", "self");
    expect(r.inflightSells).toBe(0); // the current order is not counted against itself
    expect(r.available).toBe(100);
  });

  it("no holdings at all → available 0 (any sell blocked)", async () => {
    const db = fakeDb({ position: null, audit: [] });
    const r = await availableToSell(db, "56378", "CAC");
    expect(r.held).toBe(0);
    expect(r.available).toBe(0);
    expect(r.source).toBe("none");
  });

  it("fails CLOSED: throws on a data error so the caller blocks the sell", async () => {
    const db = fakeDb({ positionError: "db down" });
    await expect(availableToSell(db, "56378", "CAC")).rejects.toThrow(/oems_position_c/);
  });

  // 2026-07-20 fix — partial-fill orders reserve ONLY their remaining quantity.
  // Previously a partial-fill sell reserved its full original quantity, which
  // blocked legitimate subsequent sells on the same position. The bulk
  // runLimitGuard had the same bug; both now use `qty - filled`.
  it("partial fill: reserves only remaining quantity (qty - filled)", async () => {
    // Held 100, one sell of 150 already partial with 60 filled → 90 remaining
    // reserved, only 10 left to sell. The previous code reserved 150 (the full
    // original quantity) and let this scenario block the next sell.
    const db = fakeDb({
      position: { quantity: 100 },
      audit: [buy("b1", 100), sell("s1", 150, "partial", 60)],
    });
    const r = await availableToSell(db, "56378", "CAC", "current-sell");
    expect(r.held).toBe(100);
    expect(r.inflightSells).toBe(90);
    expect(r.available).toBe(10);
  });

  // 2026-07-20 alignment — `cancel_pending` reserves too. The BFF
  // IN_FLIGHT_STATUSES set already reserves it; the worker's
  // OPEN_SELL_STATES now matches. A fill racing a cancel instruction
  // is a real risk on a single-seat broker, so the safer default is
  // to keep reserving until IRESS confirms cancellation.
  it("cancel_pending: reserves quantity until IRESS confirms cancellation", async () => {
    const db = fakeDb({
      position: { quantity: 100 },
      audit: [buy("b1", 100), sell("s1", 50, "cancel_pending", 0)],
    });
    const r = await availableToSell(db, "56378", "CAC", "current-sell");
    expect(r.inflightSells).toBe(50);
    expect(r.available).toBe(50);
  });

  // `amend_pending` is reserved for the same reason — an amend can change
  // quantity upward (e.g. operator raises a 50-share limit to 80 shares).
  it("amend_pending: reserves quantity while a desk amend is in flight", async () => {
    const db = fakeDb({
      position: { quantity: 100 },
      audit: [buy("b1", 100), sell("s1", 50, "amend_pending", 0)],
    });
    const r = await availableToSell(db, "56378", "CAC", "current-sell");
    expect(r.inflightSells).toBe(50);
    expect(r.available).toBe(50);
  });
});

const openBuy = (id: string, quantity: number, priceCents: number | null, status = "working"): AuditRow => ({
  id,
  side: "buy",
  quantity,
  status,
  payload: null,
  price_cents: priceCents,
  result_payload: null,
});

describe("availableToBuy", () => {
  it("uses oems_account_c cash and reserves the value of other open buys", async () => {
    // Cash R1000; one other open buy of 100 @ R2 (200c) = R200 reserved → R800 left.
    const db = fakeDb({ account: { cash_balance: 1000 }, audit: [openBuy("b1", 100, 200)] });
    const r = await availableToBuy(db, "56378", "current-buy");
    expect(r.source).toBe("ips");
    expect(r.cash).toBe(1000);
    expect(r.inflightBuys).toBe(200);
    expect(r.available).toBe(800);
  });

  it("excludes the order being sent from the open-buy reservation", async () => {
    const db = fakeDb({ account: { cash_balance: 1000 }, audit: [openBuy("self", 100, 200)] });
    const r = await availableToBuy(db, "56378", "self");
    expect(r.inflightBuys).toBe(0);
    expect(r.available).toBe(1000);
  });

  it("is ADVISORY when there is no cash source and no cap (available null)", async () => {
    const db = fakeDb({ account: null, audit: [] });
    const r = await availableToBuy(db, "56378");
    expect(r.source).toBe("none");
    expect(r.cash).toBeNull();
    expect(r.available).toBeNull(); // caller allows the buy (advisory), does not block
  });

  it("falls back to a configured cap when oems_account_c has no row", async () => {
    const db = fakeDb({ account: null, audit: [] });
    const r = await availableToBuy(db, "56378", undefined, { fallbackCapRands: 500 });
    expect(r.source).toBe("cap");
    expect(r.cash).toBe(500);
    expect(r.available).toBe(500);
  });

  it("does not reserve an open buy whose price cannot be resolved", async () => {
    const db = fakeDb({ account: { cash_balance: 1000 }, audit: [openBuy("b1", 100, null)] });
    const r = await availableToBuy(db, "56378", "current-buy");
    expect(r.inflightBuys).toBe(0);
    expect(r.available).toBe(1000);
    expect(r.note).toMatch(/unpriced/);
  });

  it("fails CLOSED on an infrastructure error: throws on an account read error", async () => {
    const db = fakeDb({ accountError: "db down" });
    await expect(availableToBuy(db, "56378")).rejects.toThrow(/oems_account_c/);
  });
});

// ── Per-client holder guards (production client orders; retail ledger) ──
function fakeRetailDb(opts: {
  security?: { id: string } | null;
  securityError?: string;
  holdings?: Array<{ quantity: number; trade_side: string }>;
  holdingsError?: string;
  wallet?: { balance: number } | null;
  walletError?: string;
  audit?: Array<{
    id: string;
    side: string;
    quantity: number;
    status: string;
    payload: Record<string, unknown> | null;
    price_cents?: number | null;
  }>;
}): WorkerSupabase {
  return {
    from(table: string) {
      const builder: Record<string, unknown> = {};
      const chain = () => builder;
      builder.select = chain;
      builder.eq = chain;
      builder.in = chain;
      builder.or = chain; // 2026-07-20: per-client reservation uses `.or(...)` to filter on either user_id OR client_account
      builder.limit = chain;
      builder.maybeSingle = () =>
        Promise.resolve(
          table === "securities_c"
            ? { data: opts.security ?? null, error: opts.securityError ? { message: opts.securityError } : null }
            : table === "wallets"
              ? { data: opts.wallet ?? null, error: opts.walletError ? { message: opts.walletError } : null }
              : { data: null, error: null },
        );
      builder.then = (resolve: (v: unknown) => unknown) =>
        Promise.resolve({
          data:
            table === "stock_holdings_c"
              ? (opts.holdings ?? [])
              : table === "oems_order_audit"
                ? (opts.audit ?? [])
                : [],
          error:
            opts.holdingsError
              ? { message: opts.holdingsError }
              : opts.walletError
                ? { message: opts.walletError }
                : null,
        }).then(resolve);
      return builder;
    },
  } as unknown as WorkerSupabase;
}

describe("availableToSellForClient (retail per-client ledger)", () => {
  it("nets active BUY minus SELL rows for the client", async () => {
    const db = fakeRetailDb({
      security: { id: "sec-1" },
      holdings: [
        { quantity: 100, trade_side: "BUY" },
        { quantity: 50, trade_side: "BUY" },
        { quantity: 30, trade_side: "SELL" },
      ],
    });
    const r = await availableToSellForClient(db, db, "user-1", "AGL");
    expect(r.source).toBe("retail_holdings");
    expect(r.held).toBe(120);
    expect(r.available).toBe(120);
  });

  it("fails closed (available 0) when the security is unknown in the retail universe", async () => {
    const db = fakeRetailDb({ security: null });
    const r = await availableToSellForClient(db, db, "user-1", "ZZZ");
    expect(r.available).toBe(0);
    expect(r.source).toBe("none");
  });

  it("throws on a stock_holdings_c read error (fail-closed)", async () => {
    const db = fakeRetailDb({ security: { id: "sec-1" }, holdingsError: "db down" });
    await expect(availableToSellForClient(db, db, "user-1", "AGL")).rejects.toThrow(/stock_holdings_c/);
  });
});

describe("availableToBuyForClient (retail wallet)", () => {
  it("uses the client's wallet balance (RANDS)", async () => {
    const db = fakeRetailDb({ wallet: { balance: 5000 } });
    const r = await availableToBuyForClient(db, db, "user-1");
    expect(r.source).toBe("wallet");
    expect(r.cash).toBe(5000);
    expect(r.available).toBe(5000);
  });

  it("is advisory (available null) when the client has no wallet row", async () => {
    const db = fakeRetailDb({ wallet: null });
    const r = await availableToBuyForClient(db, db, "user-1");
    expect(r.source).toBe("none");
    expect(r.available).toBeNull();
  });

  it("throws on a wallets read error (fail-closed on infra failure)", async () => {
    const db = fakeRetailDb({ walletError: "db down" });
    await expect(availableToBuyForClient(db, db, "user-1")).rejects.toThrow(/wallets/);
  });

  // 2026-07-20: per-client reservation is wired up. A client's own open
  // sells now reserve against their available-to-sell so two of their
  // sells can't each consume the whole position.
  it("reserves the client's own open sells against their own available-to-sell", async () => {
    const db = fakeRetailDb({
      security: { id: "sec-1" },
      holdings: [{ quantity: 100, trade_side: "BUY" }],
      audit: [
        {
          id: "s-self-1",
          side: "sell",
          quantity: 60,
          status: "working",
          payload: null,
        },
      ],
    });
    const r = await availableToSellForClient(db, db, "user-1", "AGL");
    expect(r.held).toBe(100);
    expect(r.inflightSells).toBe(60);
    expect(r.available).toBe(40);
    expect(r.note).toMatch(/60 in open sells/);
  });

  it("reserves the client's own open buys' notional against their own available cash", async () => {
    const db = fakeRetailDb({
      wallet: { balance: 1000 },
      audit: [
        {
          id: "b-self-1",
          side: "buy",
          quantity: 100,
          status: "working",
          payload: null,
          price_cents: 200, // 100 @ R2 = R200 reserved
        },
      ],
    });
    const r = await availableToBuyForClient(db, db, "user-1");
    expect(r.cash).toBe(1000);
    expect(r.inflightBuys).toBe(200);
    expect(r.available).toBe(800);
    expect(r.note).toMatch(/R200\.00 in open buys/);
  });
});

/**
 * REGRESSION — the two-database split.
 *
 * These guards read the client's wallet and holdings from RETAIL, but the order
 * book (`oems_order_audit`) lives on INSTITUTIONAL. The functions used to take a
 * single handle and pass it to both, so every call died with "Could not find the
 * table 'public.oems_order_audit' in the schema cache". The guard treats a
 * thrown read as unverifiable and refuses, so on 2026-07-27 a fully funded
 * client order was blocked at the last gate — R98 buy, R1 000 wallet.
 *
 * The tests above did not catch it because `fakeRetailDb` answers for BOTH
 * tables from one object, which is exactly the assumption the production code
 * got wrong. These use SEPARATE doubles: the retail one has no order book, so
 * anything reaching for `oems_order_audit` on it throws.
 */
describe("guards read the order book from INSTITUTIONAL, not RETAIL", () => {
  /** Retail-only double: throws if asked for the institutional order book. */
  function retailOnly(opts: Parameters<typeof fakeRetailDb>[0]) {
    const inner = fakeRetailDb(opts);
    return {
      from(table: string) {
        if (table === "oems_order_audit") {
          throw new Error(
            "Could not find the table 'public.oems_order_audit' in the schema cache",
          );
        }
        return (inner as unknown as { from: (t: string) => unknown }).from(table);
      },
    } as unknown as WorkerSupabase;
  }

  it("availableToBuyForClient does not look for the order book on retail", async () => {
    const retail = retailOnly({ wallet: { balance: 1000 } });
    const institutional = fakeRetailDb({ audit: [] });
    const r = await availableToBuyForClient(retail, institutional, "user-1");
    expect(r.cash).toBe(1000);
    expect(r.available).toBe(1000);
  });

  it("availableToSellForClient does not look for the order book on retail", async () => {
    const retail = retailOnly({
      security: { id: "sec-1" },
      holdings: [{ quantity: 100, trade_side: "BUY" }],
    });
    const institutional = fakeRetailDb({ audit: [] });
    const r = await availableToSellForClient(retail, institutional, "user-1", "AGL");
    expect(r.held).toBe(100);
    expect(r.available).toBe(100);
  });

  it("reserves in-flight buys read from the INSTITUTIONAL handle", async () => {
    const retail = retailOnly({ wallet: { balance: 1000 } });
    const institutional = fakeRetailDb({
      audit: [
        { id: "b-1", side: "buy", quantity: 100, status: "working", payload: null, price_cents: 200 },
      ],
    });
    const r = await availableToBuyForClient(retail, institutional, "user-1");
    expect(r.inflightBuys).toBe(200);
    expect(r.available).toBe(800);
  });
});

describe("resolveHolderKind", () => {
  it("routes UAT sources to the desk guard", () => {
    expect(resolveHolderKind({ source: "UAT_ADHOC_ORDER" })).toBe("desk");
    expect(resolveHolderKind({ source: "OB_SEND_TO_MARKET_UAT" })).toBe("desk");
  });
  it("routes uat_test payloads to the desk guard", () => {
    expect(resolveHolderKind({ source: "OTHER", payload: { uat_test: true } })).toBe("desk");
  });
  it("routes a production client order (holding_id / user_id) to the client guard", () => {
    expect(resolveHolderKind({ source: "OB_SEND_TO_MARKET", payload: { holding_id: "h1" } })).toBe("client");
    expect(resolveHolderKind({ source: "OB_SEND_TO_MARKET", payload: { user_id: "u1" } })).toBe("client");
  });
  it("defaults to desk when there is no clear client linkage", () => {
    expect(resolveHolderKind({ source: "OB_SEND_TO_MARKET", payload: {} })).toBe("desk");
  });
});
