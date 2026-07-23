import { describe, expect, it } from "vitest";

import {
  buildOrderBookDisplayItems,
  groupOrdersByStrategy,
  type ExecutionRow,
} from "@/components/admin/order-book/execution-view";

/**
 * 2026-07-23: raw books (UAT-ADHOC/CLIENT-BUY — where `strategy` is just
 * the originating book id, not a real basket name) should render as PLAIN
 * top-level order rows, not wrapped behind a "22 orders" summary click —
 * only a genuine multi-security strategy keeps the Holdings/Investors
 * two-axis drill-down. This is the pure grouping/partitioning logic behind
 * that split; the actual GroupRow/strategy-block JSX is exercised only
 * via manual verification (no React render harness in this suite).
 */

function row(overrides: Partial<ExecutionRow> = {}): ExecutionRow {
  return {
    id: overrides.id ?? "row-1",
    order_book_seq: overrides.order_book_seq ?? null,
    order_id: overrides.order_id ?? "ORD-1",
    client_account: "client@example.com",
    broker_account: null,
    ts: overrides.ts ?? "2026-07-23T10:00:00.000Z",
    strategy: overrides.strategy ?? null,
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

function group(parent: ExecutionRow) {
  return { parent, children: [] };
}

describe("buildOrderBookDisplayItems", () => {
  it("flattens a raw book (strategy === one of this panel's bookIds) into individual order items", () => {
    const blocks = groupOrdersByStrategy([
      group(row({ id: "a", order_id: "ORD-A", strategy: "CLIENT-BUY" })),
      group(row({ id: "b", order_id: "ORD-B", strategy: "CLIENT-BUY" })),
    ]);
    const items = buildOrderBookDisplayItems(blocks, ["UAT-ADHOC", "CLIENT-BUY"]);
    expect(items).toHaveLength(2);
    expect(items.every((i) => i.type === "order")).toBe(true);
  });

  it("keeps a genuine strategy (not matching any bookId) as one wrapped strategy item", () => {
    const blocks = groupOrdersByStrategy([
      group(row({ id: "a", order_id: "ORD-A", strategy: "Yield Basket" })),
      group(row({ id: "b", order_id: "ORD-B", strategy: "Yield Basket" })),
    ]);
    const items = buildOrderBookDisplayItems(blocks, ["UAT-ADHOC", "CLIENT-BUY"]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ type: "strategy" });
    if (items[0]!.type === "strategy") {
      expect(items[0]!.block.groups).toHaveLength(2);
    }
  });

  it("treats 'Unassigned' (no strategy stamped at all) the same as a raw book — flattened, not wrapped", () => {
    const blocks = groupOrdersByStrategy([group(row({ id: "a", order_id: "ORD-A", strategy: null }))]);
    const items = buildOrderBookDisplayItems(blocks, ["UAT-ADHOC", "CLIENT-BUY"]);
    expect(items).toEqual([{ type: "order", group: expect.anything(), ts: expect.any(Number) }]);
  });

  it("interleaves flattened raw orders and a real strategy block by most-recent activity", () => {
    const blocks = groupOrdersByStrategy([
      group(row({ id: "old-adhoc", order_id: "ORD-OLD", strategy: "UAT-ADHOC", ts: "2026-01-01T00:00:00.000Z" })),
      group(row({ id: "s1", order_id: "ORD-S1", strategy: "Yield Basket", ts: "2026-07-23T09:00:00.000Z" })),
      group(row({ id: "s2", order_id: "ORD-S2", strategy: "Yield Basket", ts: "2026-07-23T09:00:00.000Z" })),
      group(row({ id: "new-adhoc", order_id: "ORD-NEW", strategy: "UAT-ADHOC", ts: "2026-07-23T12:00:00.000Z" })),
    ]);
    const items = buildOrderBookDisplayItems(blocks, ["UAT-ADHOC", "CLIENT-BUY"]);
    // Newest-first: the fresh adhoc order, then the strategy block, then the old adhoc order.
    expect(items.map((i) => (i.type === "order" ? i.group.parent.id : "STRATEGY"))).toEqual([
      "new-adhoc",
      "STRATEGY",
      "old-adhoc",
    ]);
  });
});
