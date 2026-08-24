import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("investor price coverage hardening", () => {
  const source = readFileSync(resolve(process.cwd(), "src/app/api/admin/investors/data/route.ts"), "utf8");

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
});
