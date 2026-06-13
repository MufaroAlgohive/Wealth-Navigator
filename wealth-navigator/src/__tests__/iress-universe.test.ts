import { describe, expect, it } from "vitest";

import {
  JSE_RATE_CODES,
  JSE_TRACKED_UNIVERSE,
  WORKER_TRACKED_SYMBOLS,
  WORKER_TRACKED_SYMBOL_SET,
} from "@/lib/iress/universe";

/**
 * The shared `JSE_TRACKED_UNIVERSE` is the contract between the
 * Railway `iress-ingest` worker's default watchlist and the Next.js
 * UI's cockpit/security/equities subscriptions. If either side
 * diverges, a click on a UI symbol returns "no tick" or the worker
 * wastes writes on a symbol no UI displays.
 *
 * These tests pin:
 *   - the 10-name JSE equity baseline (audit #4)
 *   - the 2-name rate-code companion (USDZAR, JIBAR_3M)
 *   - the full worker symbol set (12 total, supersedes the old 22)
 *   - the JSE rate codes ride the FX/MM exchanges
 */
describe("JSE_TRACKED_UNIVERSE", () => {
  it("contains the 10-name JSE equity baseline", () => {
    expect(JSE_TRACKED_UNIVERSE).toHaveLength(10);
    const syms = JSE_TRACKED_UNIVERSE.map((e) => e.symbol);
    expect(syms).toEqual([
      "NPN", "PRX", "FSR", "SBK", "AGL", "BHG", "MTN", "SOL", "SHP", "CPI",
    ]);
  });

  it("tags every equity entry as kind=equity", () => {
    for (const e of JSE_TRACKED_UNIVERSE) {
      expect(e.kind).toBe("equity");
    }
  });

  it("carries RIC + ISIN + name + sector on every equity row", () => {
    for (const e of JSE_TRACKED_UNIVERSE) {
      expect(e.ric).toMatch(/^[A-Z]+\.J$/);
      expect(e.isin).toMatch(/^ZAE|^GB|^NL|^US/);
      expect(e.name.length).toBeGreaterThan(0);
      expect(e.sector.length).toBeGreaterThan(0);
    }
  });

  it("contains the 2-name rate-code companion (USDZAR + JIBAR_3M)", () => {
    expect(JSE_RATE_CODES).toHaveLength(2);
    const syms = JSE_RATE_CODES.map((e) => e.symbol);
    expect(syms).toEqual(["USDZAR", "JIBAR_3M"]);
  });

  it("tags USDZAR as fx and JIBAR_3M as mm", () => {
    expect(JSE_RATE_CODES.find((e) => e.symbol === "USDZAR")?.kind).toBe("fx");
    expect(JSE_RATE_CODES.find((e) => e.symbol === "JIBAR_3M")?.kind).toBe("mm");
  });

  it("computes a stable 12-symbol worker set (10 equity + 2 rate codes)", () => {
    expect(WORKER_TRACKED_SYMBOLS).toHaveLength(12);
    // Set dedupes, so a duplicate symbol would shrink the array — guard
    // against accidental double-listing of e.g. USDZAR in both lists.
    expect(WORKER_TRACKED_SYMBOL_SET.size).toBe(12);
  });

  it("includes every UI equity symbol in the worker set (no orphan UI rows)", () => {
    for (const e of JSE_TRACKED_UNIVERSE) {
      expect(WORKER_TRACKED_SYMBOL_SET.has(e.symbol)).toBe(true);
    }
    expect(WORKER_TRACKED_SYMBOL_SET.has("USDZAR")).toBe(true);
    expect(WORKER_TRACKED_SYMBOL_SET.has("JIBAR_3M")).toBe(true);
  });
});
