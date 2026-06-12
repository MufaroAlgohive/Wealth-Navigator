import { afterEach, describe, expect, it } from "vitest";

import { loadWorkerEnv } from "../../workers/iress-ingest/src/env";

/**
 * Tests for `loadWorkerEnv` watchlist parsing.
 *
 * The worker reads `IRESS_WATCHLIST_SYMBOLS` (comma-separated, case-insensitive,
 * whitespace-tolerant) and falls back to a 20-name JSE Top-40 subset when the
 * variable is missing/empty. Each entry is normalised by `normaliseSymbol`
 * (strips `.JSE`, removes spaces, uppercases) before `pricingQuoteGet`.
 *
 * This guards the production watchlist expansion (NPN → 10 symbols) against
 * silent regressions in the parse step — a typo in a separator or a missing
 * `.filter(Boolean)` would otherwise let an empty string reach IRESS.
 */

const ORIGINAL_ENV = { ...process.env };
const WATCHLIST_KEYS = [
  "IRESS_WATCHLIST_SYMBOLS",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "IRESS_USERNAME",
  "IRESS_PASSWORD",
  "IRESS_COMPANY_NAME",
  "IRESS_BASE_URL",
  "IRESS_REGION",
  "IRESS_DEFAULT_EXCHANGE",
  "IRESS_APPLICATION_LABEL",
  "IRESS_ACCOUNT_CODE",
  "IRESS_WORKER_DRY_RUN",
  "SUPABASE_ALLOW_WRITES",
  "IRESS_WORKER_HEARTBEAT_SEC",
  "IRESS_WORKER_QUOTE_INTERVAL_SEC",
  "IRESS_WORKER_ORDER_POLL_SEC",
  "IRESS_WORKER_INSTRUMENT_SYNC",
  "WORKER_ID",
  "IRESS_MODE",
];

function clearEnv() {
  for (const key of WATCHLIST_KEYS) delete process.env[key];
}

afterEach(() => {
  clearEnv();
  process.env = { ...ORIGINAL_ENV };
});

describe("loadWorkerEnv watchlist parsing", () => {
  it("splits a comma-separated list into an array of uppercase symbols", () => {
    clearEnv();
    process.env.IRESS_WATCHLIST_SYMBOLS = "NPN,PRX,FSR,SBK,AGL,BHG,MTN,SOL,SHP,CPI";
    const env = loadWorkerEnv();
    expect(env.watchlistSymbols).toEqual([
      "NPN", "PRX", "FSR", "SBK", "AGL", "BHG", "MTN", "SOL", "SHP", "CPI",
    ]);
  });

  it("uppercases lowercase entries and trims surrounding whitespace", () => {
    clearEnv();
    process.env.IRESS_WATCHLIST_SYMBOLS = " npn ,  prx , fsr ";
    const env = loadWorkerEnv();
    expect(env.watchlistSymbols).toEqual(["NPN", "PRX", "FSR"]);
  });

  it("filters empty entries from a list with trailing/leading commas", () => {
    clearEnv();
    process.env.IRESS_WATCHLIST_SYMBOLS = ",NPN,,PRX,,";
    const env = loadWorkerEnv();
    expect(env.watchlistSymbols).toEqual(["NPN", "PRX"]);
  });

  it("strips a `.JSE` exchange suffix on the symbols (normalised downstream by quotes.ts)", () => {
    clearEnv();
    process.env.IRESS_WATCHLIST_SYMBOLS = "NPN.JSE,PRX.JSE";
    const env = loadWorkerEnv();
    // env.ts only uppercases/trims; `.JSE` stripping happens per-symbol in
    // quotes.ts `normaliseSymbol`. This test documents the current split so a
    // future refactor that moves the strip into env.ts surfaces here.
    expect(env.watchlistSymbols).toEqual(["NPN.JSE", "PRX.JSE"]);
  });

  it("falls back to the 20-name JSE Top-40 subset when the env var is missing", () => {
    clearEnv();
    const env = loadWorkerEnv();
    expect(env.watchlistSymbols.length).toBe(20);
    expect(env.watchlistSymbols).toContain("NPN");
    expect(env.watchlistSymbols).toContain("PRX");
    // All entries are uppercased, non-empty tickers.
    for (const sym of env.watchlistSymbols) {
      expect(sym).toMatch(/^[A-Z0-9]+$/);
    }
  });

  it("falls back to the default watchlist when the env var is an empty string", () => {
    clearEnv();
    process.env.IRESS_WATCHLIST_SYMBOLS = "";
    const env = loadWorkerEnv();
    expect(env.watchlistSymbols.length).toBe(20);
  });

  it("parses the production 10-symbol JSE watchlist used on Railway", () => {
    clearEnv();
    process.env.IRESS_WATCHLIST_SYMBOLS =
      "AGL,BHG,CPI,FSR,MTN,NPN,PRX,SBK,SHP,SOL";
    const env = loadWorkerEnv();
    expect(env.watchlistSymbols).toEqual([
      "AGL", "BHG", "CPI", "FSR", "MTN", "NPN", "PRX", "SBK", "SHP", "SOL",
    ]);
    expect(new Set(env.watchlistSymbols).size).toBe(10);
  });
});
