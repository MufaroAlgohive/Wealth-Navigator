import { buildStrategyReturnEngineWorkbook } from "@/lib/returns/strategy-return-engine-workbook";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";

describe("strategy return engine workbook", () => {
  it("keeps the original model tabs, formulas, chart and inception-to-latest rows", async () => {
    const bytes = await buildStrategyReturnEngineWorkbook({
      strategyName: "Demo Strategy",
      strategyCreatedAt: "2026-01-29",
      rows: [
        {
          asOf: "2026-01-30",
          securitiesCents: 100_000,
          continuityCashCents: 0,
          completeValueCents: 100_000,
          currentAppOneMonthPct: 0,
          legs: [{ ticker: "AAA", units: 1, counts_in_current_strategy: true }],
          periods: { "1M": { return_pct: 0, reference_date: "2026-01-30" } },
        },
        {
          asOf: "2026-02-27",
          securitiesCents: 98_000,
          continuityCashCents: 5_000,
          completeValueCents: 103_000,
          currentAppOneMonthPct: 3,
          legs: [{ ticker: "BBB", units: 1, counts_in_current_strategy: true }],
          periods: { "1M": { return_pct: 3, reference_date: "2026-01-30" } },
        },
      ],
    });

    const zip = await JSZip.loadAsync(bytes);
    const workbookFile = zip.file("xl/workbook.xml");
    const ledgerFile = zip.file("xl/worksheets/sheet4.xml");
    const chartFile = zip.file("xl/charts/chart1.xml");
    expect(workbookFile).not.toBeNull();
    expect(ledgerFile).not.toBeNull();
    expect(chartFile).not.toBeNull();
    const workbook = await workbookFile?.async("string");
    const ledger = await ledgerFile?.async("string");
    const chart = await chartFile?.async("string");

    expect([...(workbook ?? "").matchAll(/<sheet name="([^"]+)/g)].map((match) => match[1])).toEqual([
      "00_Start_Here",
      "01_Master_Data",
      "05_Rebalance_Events",
      "06_Strategy_Ledger",
      "07_Public_Strategy_View",
      "Chart_Data",
      "13_Checks",
    ]);
    expect(ledger).toContain("2026-01-30");
    expect(ledger).toContain("2026-02-27");
    expect(ledger).toContain("<f>B5+C5</f>");
    expect(ledger).toContain("D4");
    expect(chart).toContain("Chart_Data!$A$4:$A$5");
    expect(zip.file("xl/styles.xml")).not.toBeNull();
  });
});
