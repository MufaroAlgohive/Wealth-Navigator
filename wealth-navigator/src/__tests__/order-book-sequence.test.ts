import { describe, expect, it } from "vitest";

import {
  computeLiveBookSequence,
  filterOutPromotedBooks,
  type ExecutionRow,
  type OrderBookSummary,
} from "@/components/admin/order-book/execution-view";

/**
 * 2026-07-23: CRM-style order-book numbering — computeLiveBookSequence()
 * mirrors CRM's getNextFilledOrderbookSequence() semantics (a live book
 * shows its own number while in progress; the badge only advances past a
 * book once it's fully filled). filterOutPromotedBooks() is the
 * corresponding row-level filter that drops a fully-filled book's orders
 * out of the live strategy-grouped view.
 */

function book(overrides: Partial<OrderBookSummary> = {}): OrderBookSummary {
  return {
    sequence: overrides.sequence ?? 1,
    released_at: overrides.released_at ?? "2026-07-23T10:00:00.000Z",
    released_by: overrides.released_by ?? "admin@example.com",
    total_count: overrides.total_count ?? 1,
    filled_count: overrides.filled_count ?? 1,
    fully_filled: overrides.fully_filled ?? true,
  };
}

describe("computeLiveBookSequence", () => {
  it("returns 1 when no books exist yet", () => {
    expect(computeLiveBookSequence([])).toBe(1);
  });

  it("returns the book's own sequence when it's still in progress (not fully filled)", () => {
    expect(computeLiveBookSequence([book({ sequence: 3, fully_filled: false })])).toBe(3);
  });

  it("returns sequence + 1 once the only book is fully filled", () => {
    expect(computeLiveBookSequence([book({ sequence: 5, fully_filled: true })])).toBe(6);
  });

  it("prefers the higher in-progress sequence when one book is filled and a later one is still working", () => {
    const books = [book({ sequence: 1, fully_filled: true }), book({ sequence: 2, fully_filled: false })];
    expect(computeLiveBookSequence(books)).toBe(2);
  });

  it("returns max+1 when every known book is fully filled", () => {
    const books = [book({ sequence: 1, fully_filled: true }), book({ sequence: 2, fully_filled: true })];
    expect(computeLiveBookSequence(books)).toBe(3);
  });
});

function row(overrides: Partial<ExecutionRow> = {}): ExecutionRow {
  return {
    id: overrides.id ?? "row-1",
    order_book_seq: overrides.order_book_seq ?? null,
    order_id: overrides.order_id ?? "ORD-1",
    client_account: "client@example.com",
    broker_account: null,
    ts: "2026-07-23T10:00:00.000Z",
    strategy: null,
    side: "BUY",
    symbol: "NPN",
    isin: null,
    qty: 100,
    filled: 100,
    filled_pct: 100,
    limit_price: null,
    avg_fill_price: null,
    vwap: null,
    slippage_cents: null,
    day1_pnl_cents: null,
    venue: "JSE",
    tif: "DAY",
    sent_by: null,
    state: "FILLED",
    broker: null,
    ...overrides,
  };
}

function group(parent: ExecutionRow) {
  return { parent, children: [] };
}

describe("filterOutPromotedBooks", () => {
  it("always keeps rows with no order_book_seq (still parked, never released)", () => {
    const rows = [group(row({ id: "a", order_book_seq: null }))];
    expect(filterOutPromotedBooks(rows, [book({ sequence: 1, fully_filled: true })])).toHaveLength(1);
  });

  it("drops a row whose order_book_seq matches a fully-filled book", () => {
    const rows = [group(row({ id: "a", order_book_seq: 1 }))];
    expect(filterOutPromotedBooks(rows, [book({ sequence: 1, fully_filled: true })])).toHaveLength(0);
  });

  it("keeps a row whose order_book_seq matches a book that is NOT yet fully filled", () => {
    const rows = [group(row({ id: "a", order_book_seq: 2 }))];
    expect(filterOutPromotedBooks(rows, [book({ sequence: 2, fully_filled: false })])).toHaveLength(1);
  });

  it("returns all rows unchanged when there are no fully-filled books at all", () => {
    const rows = [group(row({ id: "a", order_book_seq: 1 })), group(row({ id: "b", order_book_seq: null }))];
    expect(filterOutPromotedBooks(rows, [])).toHaveLength(2);
  });
});
