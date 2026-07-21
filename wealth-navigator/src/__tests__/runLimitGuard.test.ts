import { beforeEach, describe, expect, it, vi } from "vitest";

// Stub `@/lib/supabase/server` so the route's module-level imports
// (`createInstitutionalServiceRoleClient`, `createSupabaseServerClient`)
// resolve cleanly. The actual supabase client used in runLimitGuard is
// passed in by the caller, so we only need the module to load.
vi.mock("@/lib/supabase/server", () => ({
  createInstitutionalServiceRoleClient: () => ({
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }),
    }),
  }),
  createRetailServiceRoleClient: () => ({
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }),
    }),
  }),
  createSupabaseServerClient: async () => ({}),
}));

const { runLimitGuard } = await import("../app/api/admin/orderbook/send-to-market/route");

/**
 * BFF `runLimitGuard` — the bulk-path pre-trade guard that runs before
 * `oems_order_audit` rows are written in `/api/admin/orderbook/send-to-market`.
 *
 * 2026-07-20 regression coverage:
 *   - Partial-fill sells reserve ONLY their remaining quantity
 *     (`qty - filled`), not the full original quantity. The previous
 *     implementation reserved the full `o.quantity` and blocked
 *     legitimate subsequent sells on the same position.
 *   - The query filters on the typed `broker_account_code` column
 *     (replacing the `payload->>` workaround). Legacy rows that only
 *     carry `payload.broker_account_code` and not the typed column are
 *     NOT counted in the in-flight snapshot — they need the migration
 *     to be backfilled (see
 *     `supabase/migrations/20260720000001_oems_order_audit_broker_account.sql`).
 */

interface AccountRow {
  cash_balance: number;
  nav_value: number;
  account_status: string;
}
interface PositionRow {
  security_code: string;
  quantity: number;
  account_code: string;
}
interface AuditRow {
  order_id: string;
  symbol: string;
  side: string;
  quantity: number;
  price_cents: number | null;
  status: string;
  broker_account_code: string;
  payload: Record<string, unknown> | null;
}

interface FakeDbState {
  account?: AccountRow | null;
  accountError?: string;
  positions?: PositionRow[];
  positionsError?: string;
  audit?: AuditRow[];
  auditError?: string;
}

function fakeDb(opts: FakeDbState) {
  // Expose via the factory closure so tests can post-mutate `audit` /
  // `positions` etc. if they need to (e.g. set broker_account_code after
  // the row is built).
  const state = { ...opts };
  const db = {
    from(table: string) {
      // Apply .eq()/.in() filters as we encounter them, so that the
      // broker_account_code column filter actually narrows the audit set
      // in `runLimitGuard`. This mirrors the (very small) subset of the
      // Supabase JS query builder surface we exercise.
      const filters: Array<{ kind: "eq" | "in"; column: string; value: unknown }> = [];
      const builder: Record<string, unknown> = {};
      const chain = () => builder;
      builder.select = chain;
      builder.eq = (column: string, value: unknown) => {
        filters.push({ kind: "eq", column, value });
        return builder;
      };
      builder.in = (column: string, value: unknown) => {
        filters.push({ kind: "in", column, value });
        return builder;
      };
      builder.maybeSingle = () =>
        Promise.resolve(
          table === "oems_account_c"
            ? {
                data: state.account ?? null,
                error: state.accountError ? { message: state.accountError } : null,
              }
            : { data: null, error: null },
        );
      builder.then = (resolve: (v: unknown) => unknown) => {
        let rows: unknown[] = [];
        if (table === "oems_position_c") rows = (state.positions ?? []) as unknown[];
        else if (table === "oems_order_audit") rows = (state.audit ?? []) as unknown[];
        for (const f of filters) {
          rows = rows.filter((r) => {
            const row = r as Record<string, unknown>;
            const v = row[f.column];
            // Skip the filter if the row simply doesn't have that column
            // — Supabase matches "row missing the column" as "not equal",
            // but for tests we want oems_position_c rows to pass through
            // even though they don't carry broker_account_code directly.
            if (v === undefined) return false;
            if (f.kind === "eq") return v === f.value;
            if (f.kind === "in") return Array.isArray(f.value) && (f.value as unknown[]).includes(v);
            return true;
          });
        }
        const v =
          table === "oems_position_c"
            ? { data: rows, error: state.positionsError ? { message: state.positionsError } : null }
            : table === "oems_order_audit"
              ? { data: rows, error: state.auditError ? { message: state.auditError } : null }
              : { data: rows, error: null };
        return Promise.resolve(v).then(resolve);
      };
      return builder as never;
    },
  };
  return { db, state };
}

const buy = (
  id: string,
  symbol: string,
  quantity: number,
  priceCents: number | null,
  status: string,
  filled = 0,
): AuditRow => ({
  order_id: id,
  symbol,
  side: "buy",
  quantity,
  price_cents: priceCents,
  status,
  broker_account_code: "56378",
  payload: filled > 0 ? { filled } : null,
});
const sell = (
  id: string,
  symbol: string,
  quantity: number,
  priceCents: number | null,
  status: string,
  filled = 0,
): AuditRow => ({
  order_id: id,
  symbol,
  side: "sell",
  quantity,
  price_cents: priceCents,
  status,
  broker_account_code: "56378",
  payload: filled > 0 ? { filled } : null,
});

describe("runLimitGuard — partial-fill reservation (2026-07-20 fix)", () => {
  it("partial sell reserves only remaining quantity (qty - filled)", async () => {
    // IPS position: 200 SOL. An open sell of 150 SOL is partially filled
    // (60/150), leaving 90 remaining. A new book with another sell of 90 SOL
    // on the same symbol should be ALLOWED (90 + 90 = 180 ≤ held 200).
    const { db } = fakeDb({
      account: { cash_balance: 100_000, nav_value: 0, account_status: "active" },
      positions: [{ security_code: "SOL", quantity: 200, account_code: "56378" }],
      audit: [buy("b1", "SOL", 200, 17_700, "filled"), sell("s1", "SOL", 150, 17_700, "partial", 60)],
    });
    const guard = await runLimitGuard(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db as any,
      "56378",
      [
        {
          id: "h-new",
          user_id: "u1",
          security_id: "sec-sol",
          quantity: 90,
          avg_fill: 17_700,
          Expected_fill: 17_700,
          trade_side: "sell",
          strategy_name_snapshot: "TEST",
        },
      ],
      { "sec-sol": { id: "sec-sol", symbol: "SOL", name: "Sasol", isin: null, last_price: 17_700 } },
      "limit",
    );
    expect(guard.skipReason).toBeNull();
    expect(guard.enforced).toBe(true);
    expect(guard.violations).toEqual([]);
    // Snapshot forensics: confirm the partial reserved 90, not 150.
    const s1 = guard.snapshot?.in_flight.find((o) => o.symbol === "SOL" && o.side === "sell");
    expect(s1?.remaining).toBe(90);
    expect(s1?.filled).toBe(60);
    expect(s1?.quantity).toBe(150);
  });

  it("full sell whose quantity equals a partial's remaining reserves correctly", async () => {
    // Held 100; partial sell 150 of which 50 filled → 100 remaining. The
    // previous bug reserved 150 (full qty), leaving available=−50; the fix
    // reserves 100, leaving available=0 → next 100 sell blocked (fail-closed).
    const { db } = fakeDb({
      account: { cash_balance: 100_000, nav_value: 0, account_status: "active" },
      positions: [{ security_code: "SOL", quantity: 100, account_code: "56378" }],
      audit: [sell("s1", "SOL", 150, 17_700, "partial", 50)],
    });
    const guard = await runLimitGuard(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db as any,
      "56378",
      [
        {
          id: "h-new",
          user_id: "u1",
          security_id: "sec-sol",
          quantity: 100,
          avg_fill: 17_700,
          Expected_fill: 17_700,
          trade_side: "sell",
          strategy_name_snapshot: "TEST",
        },
      ],
      { "sec-sol": { id: "sec-sol", symbol: "SOL", name: "Sasol", isin: null, last_price: 17_700 } },
      "limit",
    );
    expect(guard.skipReason).toBeNull();
    // enforced=true ⇔ no violations; enforced=false ⇔ violations present OR guard skipped.
    expect(guard.enforced).toBe(false);
    expect(guard.violations.length).toBeGreaterThan(0);
    expect(guard.violations[0]?.reason).toMatch(/naked short|net short/);
  });

  it("buy notional reserves by REMAINING not by full quantity (cash math)", async () => {
    // Cash R1000; one other open buy of 200 @ R5 with payload.filled=100.
    // After partial fill 100 of 200, only 100 remain → R500 reserved →
    // R500 left. The previous bug reserved R1000 (full qty * price) and
    // blocked a new R300 buy; the fix reserves R500 and allows the new
    // R250 buy.
    const { db } = fakeDb({
      account: { cash_balance: 1000, nav_value: 0, account_status: "active" },
      positions: [],
      audit: [buy("b1", "SOL", 200, 500, "partial", 100)],
    });
    const guard = await runLimitGuard(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db as any,
      "56378",
      [
        {
          id: "h-new",
          user_id: "u1",
          security_id: "sec-sol",
          quantity: 50,
          avg_fill: 500,
          Expected_fill: 500,
          trade_side: "buy",
          strategy_name_snapshot: "TEST",
        },
      ],
      { "sec-sol": { id: "sec-sol", symbol: "SOL", name: "Sasol", isin: null, last_price: 500 } },
      "limit",
    );
    expect(guard.skipReason).toBeNull();
    // enforced=true ⇔ no violations; enforced=false ⇔ violations present OR guard skipped.
    expect(guard.enforced).toBe(true);
    // 1000 cash - (100 remaining × 5) - (50 × 5) = 1000 - 500 - 250 = 250 ≥ 0 → pass
    expect(guard.violations).toEqual([]);
  });

  it("cancel_pending + amend_pending both reserve against the next sell", async () => {
    // 2026-07-20 alignment: the BFF `IN_FLIGHT_STATUSES` already reserves
    // these. We keep the same behaviour on the bulk path so the two
    // guards never disagree.
    const { db } = fakeDb({
      account: { cash_balance: 100_000, nav_value: 0, account_status: "active" },
      positions: [{ security_code: "SOL", quantity: 100, account_code: "56378" }],
      audit: [
        sell("s1", "SOL", 30, 17_700, "cancel_pending"),
        sell("s2", "SOL", 20, 17_700, "amend_pending"),
      ],
    });
    const guard = await runLimitGuard(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db as any,
      "56378",
      [
        {
          id: "h-new",
          user_id: "u1",
          security_id: "sec-sol",
          quantity: 51,
          avg_fill: 17_700,
          Expected_fill: 17_700,
          trade_side: "sell",
          strategy_name_snapshot: "TEST",
        },
      ],
      { "sec-sol": { id: "sec-sol", symbol: "SOL", name: "Sasol", isin: null, last_price: 17_700 } },
      "limit",
    );
    expect(guard.skipReason).toBeNull();
    // enforced=true ⇔ no violations; enforced=false ⇔ violations present OR guard skipped.
    expect(guard.enforced).toBe(false);
    // 30 + 20 + 51 = 101 > 100 → violation
    expect(guard.violations.length).toBeGreaterThan(0);
  });

  it("filters on the typed broker_account_code column", async () => {
    // An in-flight order for a DIFFERENT account must NOT count against this
    // account's limit — i.e. the new typed column is the only filter.
    const { db, state } = fakeDb({
      account: { cash_balance: 100_000, nav_value: 0, account_status: "active" },
      positions: [{ security_code: "SOL", quantity: 50, account_code: "56378" }],
      audit: [sell("s-other", "SOL", 1000, 17_700, "working")],
    });
    state.audit![0]!.broker_account_code = "OTHER-ACCOUNT";
    const guard = await runLimitGuard(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db as any,
      "56378",
      [
        {
          id: "h-new",
          user_id: "u1",
          security_id: "sec-sol",
          quantity: 50,
          avg_fill: 17_700,
          Expected_fill: 17_700,
          trade_side: "sell",
          strategy_name_snapshot: "TEST",
        },
      ],
      { "sec-sol": { id: "sec-sol", symbol: "SOL", name: "Sasol", isin: null, last_price: 17_700 } },
      "limit",
    );
    expect(guard.skipReason).toBeNull();
    // enforced=true ⇔ no violations; enforced=false ⇔ violations present OR guard skipped.
    expect(guard.enforced).toBe(true);
    expect(guard.violations).toEqual([]);
  });
});
