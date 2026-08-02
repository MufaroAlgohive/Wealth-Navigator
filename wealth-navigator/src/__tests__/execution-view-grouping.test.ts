import { describe, expect, it } from "vitest";

import {
  groupOrdersByStrategy,
  isGiftOrderBlock,
  type ExecutionRow,
} from "@/components/admin/order-book/execution-view";

/**
 * 2026-07-22: regression coverage for the order-book panel consolidation —
 * the new strategy-grouping stage that sits AFTER the existing SSE/poll
 * reconciliation (execution-view.tsx's `rows` → `groupedRows` → this).
 * Confirms rows with no real strategy fall back to their originating book
 * id (the mint client-order / ad-hoc ticket case today), and that rows
 * sharing a real strategy name (a future basket buy) interleave into one
 * group regardless of which book/order they came from.
 */

function row(overrides: Partial<ExecutionRow> = {}): ExecutionRow {
  return {
    id: overrides.id ?? "row-1",
    order_book_seq: overrides.order_book_seq ?? null,
    order_id: overrides.order_id ?? "ORD-1",
    client_account: "client@example.com",
    broker_account: null,
    ts: "2026-07-22T10:00:00.000Z",
    strategy: null,
    side: "BUY",
    symbol: "NPN",
    isin: null,
    qty: 100,
    filled: 0,
    filled_pct: 0,
    limit_price: null,
    avg_fill_price: null,
    vwap: null,
    slippage_cents: null,
    day1_pnl_cents: null,
    venue: "JSE",
    tif: "DAY",
    sent_by: null,
    state: "WORKING",
    broker: null,
    ...overrides,
  };
}

function group(parent: ExecutionRow, children: ExecutionRow[] = []) {
  return { parent, children };
}

describe("groupOrdersByStrategy", () => {
  it("falls back to 'Unassigned' when a row has no strategy at all", () => {
    const blocks = groupOrdersByStrategy([group(row({ id: "a", strategy: null }))]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.strategy).toBe("Unassigned");
  });

  it("groups mint client-order / ad-hoc rows by their originating book id (stamped into `strategy`)", () => {
    const blocks = groupOrdersByStrategy([
      group(row({ id: "a", order_id: "ORD-A", strategy: "CLIENT-BUY", symbol: "NPN" })),
      group(row({ id: "b", order_id: "ORD-B", strategy: "CLIENT-BUY", symbol: "BHG" })),
      group(row({ id: "c", order_id: "ORD-C", strategy: "UAT-ADHOC", symbol: "AGL" })),
    ]);
    expect(blocks).toHaveLength(2);
    const clientBuy = blocks.find((b) => b.strategy === "CLIENT-BUY");
    const adhoc = blocks.find((b) => b.strategy === "UAT-ADHOC");
    expect(clientBuy?.groups).toHaveLength(2);
    expect(adhoc?.groups).toHaveLength(1);
  });

  it("interleaves rows from different underlying orders into one group when they share a real strategy name", () => {
    const blocks = groupOrdersByStrategy([
      group(row({ id: "a", order_id: "ORD-A", strategy: "Yield Basket", symbol: "NPN" })),
      group(row({ id: "b", order_id: "ORD-B", strategy: "Yield Basket", symbol: "SBK" })),
    ]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.strategy).toBe("Yield Basket");
    expect(blocks[0]!.groups.map((g) => g.parent.symbol).sort()).toEqual(["NPN", "SBK"]);
  });

  it("sorts blocks by most-recent activity (latest parent ts) descending", () => {
    const blocks = groupOrdersByStrategy([
      group(row({ id: "old", order_id: "ORD-OLD", strategy: "Old Strategy", ts: "2026-01-01T00:00:00.000Z" })),
      group(row({ id: "new", order_id: "ORD-NEW", strategy: "New Strategy", ts: "2026-07-22T00:00:00.000Z" })),
    ]);
    expect(blocks.map((b) => b.strategy)).toEqual(["New Strategy", "Old Strategy"]);
  });

  it("returns an empty array for an empty input (no execution rows for the book yet)", () => {
    expect(groupOrdersByStrategy([])).toEqual([]);
  });
});

describe("isGiftOrderBlock", () => {
  it("recognises a claimed gift book so its assets can be revealed directly", () => {
    expect(isGiftOrderBlock("GIFT-8f44da9f-3c83-4f93-b434-f20f70d94655")).toBe(true);
    expect(isGiftOrderBlock("gift-uat_claim_42")).toBe(true);
  });

  it("does not flatten normal strategy and client-order books", () => {
    expect(isGiftOrderBlock("Yield Basket")).toBe(false);
    expect(isGiftOrderBlock("CLIENT-BUY")).toBe(false);
    expect(isGiftOrderBlock("GIFT-")).toBe(false);
  });
});
