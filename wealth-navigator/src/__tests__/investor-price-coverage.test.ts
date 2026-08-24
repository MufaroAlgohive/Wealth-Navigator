import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("investor price coverage hardening", () => {
  const source = readFileSync(resolve(process.cwd(), "src/app/api/admin/investors/data/route.ts"), "utf8");
  const cancelSource = readFileSync(resolve(process.cwd(), "src/app/api/admin/orderbook/cancel-parked/route.ts"), "utf8");

  it("bounds the append-heavy intraday query", () => {
    expect(source).toContain('.gte("timestamp", intradaySince)');
    expect(source).toContain(".limit(5000)");
  });

  it("rate-limits Yahoo fallback", () => {
    expect(source).toContain("maxYahoo: 8, concurrency: 2");
  });

  it("returns explicit provisional coverage instead of crashing the book", () => {
    expect(source).toContain('price_source: referencePrice > 0 ? "securities_c_reference" : "unavailable"');
    expect(source).not.toContain("throw new Error(`price coverage incomplete");
  });

  it("excludes parked and cancelled placeholders until a real fill exists", () => {
    expect(source).toContain("Boolean(holding.Fill_date || Number(holding.avg_fill) > 0)");
    expect(cancelSource).toContain('.update({ is_active: false, quantity: 0, Status: "cancelled" })');
    expect(cancelSource).toContain("!holding.Fill_date && !(Number(holding.avg_fill) > 0)");
  });
});
