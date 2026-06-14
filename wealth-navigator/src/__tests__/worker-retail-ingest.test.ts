import { describe, expect, it } from "vitest";

import { toIressCode } from "../../workers/iress-ingest/src/retail-ingest";

/**
 * The retail universe stores JSE tickers with a `.JO` suffix (e.g. MTN.JO);
 * IRESS expects bare codes (MTN). `toIressCode` is the mapping that lets the
 * worker poll IRESS for a retail symbol and write the result back to that row.
 */
describe("toIressCode", () => {
  it("strips a .JO suffix", () => {
    expect(toIressCode("MTN.JO")).toBe("MTN");
  });
  it("strips a .JSE suffix", () => {
    expect(toIressCode("NPN.JSE")).toBe("NPN");
  });
  it("uppercases and trims whitespace", () => {
    expect(toIressCode(" stx40.jo ")).toBe("STX40");
  });
  it("leaves a bare code unchanged", () => {
    expect(toIressCode("SBK")).toBe("SBK");
  });
  it("handles ETF tickers", () => {
    expect(toIressCode("SYGEMF.JO")).toBe("SYGEMF");
  });
});
