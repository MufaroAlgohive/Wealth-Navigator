import { describe, expect, it } from "vitest";

import {
  preTradeCheck,
  rebalanceBlockReason,
  rebalanceBlockTooltip,
  getMarketState,
  marketStateBySymbol,
} from "@/lib/iress/strategy";

describe("preTradeCheck", () => {
  it("flags buying-power exceeded when notional > account.cash", () => {
    // 100 × 4 180 = 418 000 notional, account cash is only 100 000 → exceeds
    const r = preTradeCheck(
      { symbol: "NPN", side: "BUY", qty: 100, price: 4180 },
      { cash: 100_000 },
      "TRADE",
    );
    expect(r.bp).toBe("exceeded");
    expect(r.notional).toBe(418_000);
    // Other legs stay green
    expect(r.halt).toBe("ok");
    expect(r.mandate).not.toBe("outside");
    // A reason is populated for the tooltip on the Send button.
    expect(r.reason).toBeTruthy();
  });

  it("reports all green when notional is within cash, market is open, and no mandate constraint", () => {
    const r = preTradeCheck(
      { symbol: "NPN", side: "BUY", qty: 100, price: 4180 },
      { cash: 10_000_000 },
      "TRADE",
    );
    expect(r.halt).toBe("ok");
    expect(r.bp).toBe("ok");
    // Mandate: no `mandate` field passed → "n/a" (unknown / no strategy attached)
    // is treated as non-blocking. "Outside" is the only blocking verdict.
    expect(r.mandate).not.toBe("outside");
    expect(r.reason).toBeUndefined();
  });

  it("flags a halt when marketState is HALT (e.g. ZZZZZ)", () => {
    const r = preTradeCheck(
      { symbol: "ZZZZZ", side: "BUY", qty: 1, price: 1 },
      { cash: 1_000_000 },
      "HALT",
    );
    expect(r.halt).toBe("halt");
    expect(r.reason).toMatch(/halt/i);
  });

  it("flags a suspension when marketState is SUSPEND", () => {
    const r = preTradeCheck(
      { symbol: "XX", side: "BUY", qty: 1, price: 1 },
      { cash: 1_000_000 },
      "SUSPEND",
    );
    expect(r.halt).toBe("suspend");
  });

  it("flags mandate=outside when the symbol is not in the strategy mandate", () => {
    const r = preTradeCheck(
      { symbol: "FOO", side: "BUY", qty: 1, price: 1 },
      { cash: 1_000_000, mandate: ["NPN", "PRX"] },
      "TRADE",
    );
    expect(r.mandate).toBe("outside");
  });

  it("reports mandate=ok when the symbol is in the strategy mandate", () => {
    const r = preTradeCheck(
      { symbol: "NPN", side: "BUY", qty: 1, price: 1 },
      { cash: 1_000_000, mandate: ["NPN", "PRX"] },
      "TRADE",
    );
    expect(r.mandate).toBe("ok");
  });

  it("reports mandate=n/a when no mandate was passed (no strategy attached)", () => {
    const r = preTradeCheck(
      { symbol: "FOO", side: "BUY", qty: 1, price: 1 },
      { cash: 1_000_000 },
      "TRADE",
    );
    expect(r.mandate).toBe("n/a");
  });

  it("includes notional in the result so the UI can show 'Estimated notional'", () => {
    const r = preTradeCheck(
      { symbol: "NPN", side: "BUY", qty: 250, price: 5000 },
      { cash: 1_000_000 },
      "TRADE",
    );
    expect(r.notional).toBe(1_250_000);
  });
});

describe("rebalanceBlockReason / rebalanceBlockTooltip", () => {
  it("classifies a halted strategy with no investors as 'halted'", () => {
    expect(rebalanceBlockReason({ investorCount: 0, status: "halted" })).toBe("halted");
  });

  it("classifies a live strategy with no investors as 'no-investors'", () => {
    expect(rebalanceBlockReason({ investorCount: 0, status: "live" })).toBe("no-investors");
  });

  it("classifies a halted live strategy with investors as 'halted'", () => {
    expect(rebalanceBlockReason({ investorCount: 5, status: "halted" })).toBe("halted");
  });

  it("classifies a live strategy with investors as 'ok'", () => {
    expect(rebalanceBlockReason({ investorCount: 5, status: "live" })).toBe("ok");
  });

  it("renders a tooltip string for the halted case that mentions Risk + date", () => {
    const t = rebalanceBlockTooltip({
      investorCount: 5,
      status: "halted",
      lastRebalanced: "2026-06-04",
    });
    expect(t.toLowerCase()).toContain("halted");
    expect(t).toContain("2026-06-04");
  });

  it("renders a tooltip string for the no-investors case that mentions investors", () => {
    const t = rebalanceBlockTooltip({
      investorCount: 0,
      status: "paper",
      lastRebalanced: "2026-01-01",
    });
    expect(t.toLowerCase()).toContain("investor");
  });
});

describe("marketStateBySymbol / getMarketState", () => {
  it("exposes the test fixture (ZZZZZ → HALT, XX → SUSPEND)", () => {
    expect(marketStateBySymbol["ZZZZZ"]).toBe("HALT");
    expect(marketStateBySymbol["XX"]).toBe("SUSPEND");
  });

  it("falls back to TRADE for unknown symbols", () => {
    expect(getMarketState("NPN")).toBe("TRADE");
    expect(getMarketState("PRX")).toBe("TRADE");
    expect(getMarketState("ZZZZZ")).toBe("HALT");
  });
});
