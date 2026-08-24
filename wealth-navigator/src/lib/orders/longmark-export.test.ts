import { describe, expect, it } from "vitest";

import { longmarkExportFilename, longmarkOrdersCsv } from "./longmark-export";

describe("Longmark order export", () => {
  it("keeps same-security client orders separate in the exact three-column format", () => {
    expect(
      longmarkOrdersCsv([
        { side: "BUY", symbol: "MTN.JO", qty: 2 },
        { side: "BUY", symbol: "MTN.JO", qty: 2 },
        { side: "BUY", symbol: "MTN.JO", qty: 2 },
        { side: "BUY", symbol: "MTN.JO", qty: 2 },
      ]),
    ).toBe(
      '"Buy/sell","Equity code","Nominal"\n' +
        '"BUY","MTN","2"\n' +
        '"BUY","MTN","2"\n' +
        '"BUY","MTN","2"\n' +
        '"BUY","MTN","2"',
    );
  });

  it("marks selected filenames without changing the ticket format", () => {
    expect(longmarkExportFilename(38, "2026-08-24", false)).toBe("orderbook-38-2026-08-24.csv");
    expect(longmarkExportFilename(38, "2026-08-24", true)).toBe("orderbook-38-selected-2026-08-24.csv");
  });
});
