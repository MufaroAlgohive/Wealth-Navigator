import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("admin investor performance", () => {
  const api = readFileSync(resolve("src/app/api/admin/investors/data/route.ts"), "utf8");
  const page = readFileSync(resolve("src/app/admin/investors/page.tsx"), "utf8");

  it("reads the canonical effective client return history", () => {
    expect(api).toContain('.from("client_strategy_returns_effective_c")');
    expect(api).toContain('"1d_pct"');
    expect(api).not.toContain('.from("client_strategy_returns_c")');
  });

  it("plots canonical return percentages instead of basket value", () => {
    expect(page).toContain("r.inception_pct");
    expect(page).toContain("value: p.v");
    expect(page).not.toContain("Math.round(p.v / 100)");
  });

  it("uses the same canonical inception figure for all-time", () => {
    expect(page).toContain("pctStr(inv.inceptionPct ?? inv.ytdPct)} all-time");
  });
});
