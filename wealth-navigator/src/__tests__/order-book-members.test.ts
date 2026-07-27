import { describe, expect, it } from "vitest";

import { toMember, type MemberAuditRow } from "@/app/api/admin/orderbook/order-books/route";

/**
 * Unit contract for order fill prices, pinned against a REAL production row.
 *
 * `oems_order_audit` mixes two units in one jsonb blob, and every 100x bug on
 * this desk has come from reading one as the other:
 *
 *   payload.avgPx                 CENTS   (raw IRESS OrderPad; JSE quotes in cents)
 *   result_payload.avgFillPrice   CENTS   (same value, mirrored)
 *   payload.limitPrice            RANDS
 *   result_payload.arrivalMid     RANDS
 *   price_cents                   CENTS   (column, not payload)
 *
 * Live order 700002 is the proof: avgPx = 9600 sat next to arrivalMid = 96.07
 * for the same FSR fill, minutes apart. Any change that makes this file fail is
 * either fixing the contract everywhere or reintroducing the bug.
 */

/** Order 700002 — FSR.JO market buy, 1 share, FILLED at R96,00 on 2026-07-27. */
const ORDER_700002: MemberAuditRow = {
  id: "e0b1e0e2-0000-4000-8000-000000000002",
  order_id: "700002",
  client_account: "juan@autonama.co.za",
  symbol: "FSR.JO",
  side: "buy",
  quantity: 1,
  price_cents: null, // market order — no limit
  status: "filled",
  source: "MANUAL_CLIENT_ORDER",
  payload: {
    avgPx: 9600,
    filled: 1,
    broker: "LONGMARK CARE",
    limitPrice: null,
    order_type: "market",
    orderValueCents: null,
    lastFillAt: "2026-07-27T13:51:43.246Z",
    order_book_seq: 2,
  },
  result_payload: {
    avgFillPrice: 9600,
    arrivalMid: 96.07,
    venue: "JSE",
    state: "FILLED",
  },
  updated_at: "2026-07-27T13:49:40.640Z",
};

describe("order book member fill prices", () => {
  it("renders order 700002 as R96,00 — not R9 600,00", () => {
    const m = toMember(ORDER_700002);
    expect(m.avg_fill_price_rands).toBeCloseTo(96.0, 2);
    // The rands fill must land within a rand of the arrival mid it traded
    // against. A 100x error is ~9 504 out and can never pass this.
    expect(Math.abs((m.avg_fill_price_rands as number) - 96.07)).toBeLessThan(1);
  });

  it("computes order value from filled qty x rands fill", () => {
    const m = toMember(ORDER_700002);
    expect(m.value_rands).toBeCloseTo(96.0, 2);
    expect(m.filled).toBe(1);
    expect(m.qty).toBe(1);
  });

  it("classifies a null-limit order as market, not limit", () => {
    expect(toMember(ORDER_700002).order_type).toBe("market");
    expect(toMember(ORDER_700002).limit_price_rands).toBeNull();
  });

  it("carries the identifying detail the archive row was missing", () => {
    const m = toMember(ORDER_700002);
    expect(m.order_id).toBe("700002");
    expect(m.client_account).toBe("juan@autonama.co.za");
    expect(m.symbol).toBe("FSR.JO");
    expect(m.side).toBe("BUY");
    expect(m.status).toBe("filled");
    expect(m.venue).toBe("JSE");
    expect(m.broker).toBe("LONGMARK CARE");
    expect(m.filled_at).toBe("2026-07-27T13:51:43.246Z");
  });

  it("reads limitPrice as RANDS while avgPx is CENTS, in the same row", () => {
    const m = toMember({
      ...ORDER_700002,
      payload: { ...ORDER_700002.payload, limitPrice: 97.5, order_type: "limit" },
    });
    expect(m.limit_price_rands).toBeCloseTo(97.5, 2); // NOT 0.975
    expect(m.avg_fill_price_rands).toBeCloseTo(96.0, 2); // NOT 9600
    expect(m.order_type).toBe("limit");
  });

  it("falls back to the price_cents column when payload has no limitPrice", () => {
    const m = toMember({
      ...ORDER_700002,
      price_cents: 9750,
      payload: { ...ORDER_700002.payload, limitPrice: null },
    });
    expect(m.limit_price_rands).toBeCloseTo(97.5, 2);
  });

  it("prefers IRESS orderValueCents over the computed value", () => {
    const m = toMember({
      ...ORDER_700002,
      payload: { ...ORDER_700002.payload, orderValueCents: 9612, filled: 1 },
    });
    expect(m.value_rands).toBeCloseTo(96.12, 2);
  });

  it("leaves the fill price null on an unfilled order rather than guessing 0", () => {
    const m = toMember({
      ...ORDER_700002,
      status: "parked",
      payload: { ...ORDER_700002.payload, avgPx: 0, filled: 0 },
      result_payload: { arrivalMid: 96.07 },
    });
    expect(m.avg_fill_price_rands).toBeNull();
    expect(m.value_rands).toBeNull();
  });

  it("surfaces an IRESS rejection reason instead of dropping it", () => {
    const m = toMember({
      ...ORDER_700002,
      status: "rejected",
      result_payload: { errorNumber: 25008, errorDescription: "No license seat" },
    });
    expect(m.iress_error).toBe("25008: No license seat");
  });

  it("has no error string on a clean fill", () => {
    expect(toMember(ORDER_700002).iress_error).toBeNull();
  });
});
