export interface LongmarkOrderExportRow {
  side: string;
  symbol: string;
  qty: number;
}

const csvField = (value: unknown): string => `"${String(value ?? "").replace(/"/g, '""')}"`;

/** Longmark's exact three-column format, with one line per order. */
export function longmarkOrdersCsv(rows: LongmarkOrderExportRow[]): string {
  const header = ["Buy/sell", "Equity code", "Nominal"].map(csvField).join(",");
  const lines = rows.map((row) => {
    const ticker = String(row.symbol || "").replace(/\.(JO|JSE)$/i, "").trim();
    return [row.side, ticker, row.qty].map(csvField).join(",");
  });
  return [header, ...lines].join("\n");
}

export function longmarkExportFilename(bookSeq: number, date: string, selected: boolean): string {
  return `orderbook-${String(bookSeq).padStart(2, "0")}${selected ? "-selected" : ""}-${date}.csv`;
}
