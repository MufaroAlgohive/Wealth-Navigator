import { describe, expect, it } from "vitest";

import { availableToSell } from "../../workers/iress-ingest/src/pretrade-guard";
import type { WorkerSupabase } from "../../workers/iress-ingest/src/supabase";

/**
 * Pre-trade naked-short guard. IRESS does not block oversells, so this is the
 * gate that stops selling more than we hold. These tests pin the two position
 * sources (IPS settled position vs derived-from-filled-orders), the open-sell
 * reservation, and fail-closed behaviour.
 */

type PosRow = { quantity: number } | null;
type AuditRow = {
  id: string;
  side: string;
  quantity: number;
  status: string;
  payload: Record<string, unknown> | null;
};

/** Minimal Supabase stub: position query ends in .maybeSingle(), audit query is awaited. */
function fakeDb(opts: { position?: PosRow; positionError?: string; audit?: AuditRow[]; auditError?: string }): WorkerSupabase {
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
});
