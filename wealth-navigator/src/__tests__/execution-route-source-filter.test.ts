import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * 2026-07-23: GET /api/admin/orderbook/execution?source=A,B — regression
 * coverage for the bug where a basket buy's real strategy name (e.g.
 * "Yield Basket") never showed up in the OEM panel at all, because the
 * panel only ever polled the two fixed book ids (UAT-ADHOC, CLIENT-BUY)
 * it knew about in advance. `source` is a stable, small dimension (unlike
 * book_id, which a basket buy can set to any string) — filtering by it
 * returns every current AND future strategy's orders with no code change.
 */

vi.mock("@/lib/admin/rbac", () => ({
  getAdminContext: async () => ({
    status: "ok",
    ctx: { email: "desk@mint.test", permissions: {}, approverTier: "master" },
  }),
}));

function makeMockSupabase(rows: Array<{ source: string; payload: Record<string, unknown>; status?: string }>) {
  let capturedSources: string[] | null = null;
  const statusFilters: Array<{ op: "eq" | "neq"; value: string }> = [];
  const client = {
    from: () => {
      const obj: Record<string, unknown> = {};
      obj.select = () => obj;
      obj.in = (_col: string, values: string[]) => {
        capturedSources = values;
        return obj;
      };
      obj.eq = (col: string, value: string) => {
        if (col === "status") statusFilters.push({ op: "eq", value });
        return obj;
      };
      obj.neq = (col: string, value: string) => {
        if (col === "status") statusFilters.push({ op: "neq", value });
        return obj;
      };
      obj.or = () => obj;
      obj.order = () => obj;
      obj.limit = () =>
        Promise.resolve({
          // Apply the captured status filter so the route's default (hide
          // cancelled) vs status=cancelled (only cancelled) split is exercised.
          data: rows
            .filter((r) =>
              statusFilters.every((f) =>
                f.op === "eq" ? (r.status ?? "parked") === f.value : (r.status ?? "parked") !== f.value,
              ),
            )
            .map((r, i) => ({
              id: `row-${i}`,
              order_id: `ORD-${i}`,
              client_account: "c@x.com",
              symbol: "NPN",
              side: "buy",
              quantity: 1,
              price_cents: null,
              status: r.status ?? "parked",
              source: r.source,
              payload: r.payload,
              result_payload: {},
              created_at: "2026-07-23T00:00:00.000Z",
              updated_at: "2026-07-23T00:00:00.000Z",
            })),
          error: null,
        });
      return obj;
    },
  } as unknown as SupabaseClient;
  return { client, getCapturedSources: () => capturedSources };
}

beforeEach(() => vi.resetModules());
afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("GET /api/admin/orderbook/execution?source=", () => {
  it("filters by source (comma-separated) and returns rows regardless of their book_id/strategy value", async () => {
    const mock = makeMockSupabase([
      { source: "MINT_CLIENT_ORDER", payload: { book_id: "Yield Basket", strategy: "Yield Basket" } },
      { source: "UAT_ADHOC_ORDER", payload: { book_id: "UAT-ADHOC", strategy: "UAT-ADHOC" } },
    ]);
    vi.doMock("@/lib/supabase/server", () => ({ createInstitutionalServiceRoleClient: () => mock.client }));

    const { GET } = await import("@/app/api/admin/orderbook/execution/route");
    const res = await GET(
      new Request("http://x/execution?source=UAT_ADHOC_ORDER,MINT_CLIENT_ORDER"),
    );
    const body = (await res.json()) as { ok: boolean; rows: Array<{ strategy: string | null }> };

    expect(mock.getCapturedSources()).toEqual(["UAT_ADHOC_ORDER", "MINT_CLIENT_ORDER"]);
    expect(body.ok).toBe(true);
    // Both rows returned — a basket's arbitrary strategy name is NOT
    // filtered out just because it isn't a known book_id.
    expect(body.rows).toHaveLength(2);
    expect(body.rows.map((r) => r.strategy).sort()).toEqual(["UAT-ADHOC", "Yield Basket"]);
  });

  it("default (active) view hides cancelled orders from the blotter", async () => {
    const mock = makeMockSupabase([
      { source: "MINT_CLIENT_ORDER", payload: { strategy: "Yield Basket" }, status: "working" },
      { source: "MINT_CLIENT_ORDER", payload: { strategy: "Yield Basket" }, status: "cancelled" },
    ]);
    vi.doMock("@/lib/supabase/server", () => ({ createInstitutionalServiceRoleClient: () => mock.client }));

    const { GET } = await import("@/app/api/admin/orderbook/execution/route");
    const res = await GET(new Request("http://x/execution?source=MINT_CLIENT_ORDER"));
    const body = (await res.json()) as { ok: boolean; rows: Array<{ state: string }> };

    expect(body.ok).toBe(true);
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]!.state).not.toBe("CANCELLED");
  });

  it("status=cancelled view returns ONLY cancelled orders", async () => {
    const mock = makeMockSupabase([
      { source: "MINT_CLIENT_ORDER", payload: { strategy: "Yield Basket" }, status: "working" },
      { source: "MINT_CLIENT_ORDER", payload: { strategy: "Yield Basket" }, status: "cancelled" },
    ]);
    vi.doMock("@/lib/supabase/server", () => ({ createInstitutionalServiceRoleClient: () => mock.client }));

    const { GET } = await import("@/app/api/admin/orderbook/execution/route");
    const res = await GET(
      new Request("http://x/execution?source=MINT_CLIENT_ORDER&status=cancelled"),
    );
    const body = (await res.json()) as { ok: boolean; rows: Array<{ state: string }> };

    expect(body.ok).toBe(true);
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]!.state).toBe("CANCELLED");
  });
});
