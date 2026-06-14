/**
 * Drive the worker's /debug/coverage probe across the full retail universe
 * (read from scripts/scan-securities.json) and compare IRESS vs the existing
 * Yahoo price. Read-only. Writes a report to scripts/scan-coverage.json.
 *
 * Run from wealth-navigator/:  bun run scripts/run-coverage.ts
 */
import { readFile, writeFile } from "node:fs/promises";

const WORKER = process.env.WORKER_URL ?? "https://iress-worker-production.up.railway.app";
const BATCH = 40;

interface Sec {
  symbol: string;
  name?: string | null;
  sector?: string | null;
  last_price?: number | null;
}
interface Row {
  symbol: string;
  iressCode: string;
  ok: boolean;
  outcome: string;
  last: number | null;
  marketState: string | null;
  currency: string | null;
  error: string | null;
}

const isEtf = (name: string | null | undefined): boolean =>
  /etf|satrix|sygnia|1nvest|itrix|feeder|index fund/i.test(name ?? "");

async function main(): Promise<void> {
  const secs = JSON.parse(await readFile("scripts/scan-securities.json", "utf-8")) as Sec[];
  const symbols = secs.map((s) => s.symbol).filter(Boolean);
  const yahoo = new Map(secs.map((s) => [s.symbol, s.last_price ?? null]));
  const nameOf = new Map(secs.map((s) => [s.symbol, s.name ?? ""]));

  const rows: Row[] = [];
  for (let i = 0; i < symbols.length; i += BATCH) {
    const batch = symbols.slice(i, i + BATCH);
    try {
      const res = await fetch(`${WORKER}/debug/coverage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ symbols: batch }),
        signal: AbortSignal.timeout(120_000),
      });
      if (!res.ok) {
        console.error(`batch ${i / BATCH + 1}: HTTP ${res.status}`);
        continue;
      }
      const json = (await res.json()) as { rows: Row[] };
      rows.push(...(json.rows ?? []));
      console.error(
        `batch ${i / BATCH + 1}/${Math.ceil(symbols.length / BATCH)}: +${batch.length}, covered so far ${rows.filter((r) => r.ok).length}/${rows.length}`,
      );
    } catch (err) {
      console.error(`batch ${i / BATCH + 1}: failed — ${err instanceof Error ? err.message : err}`);
    }
  }

  const detail = rows.map((r) => {
    const yCents = yahoo.get(r.symbol);
    const iCents = r.last != null ? Math.round(r.last * 100) : null;
    let deltaPct: number | null = null;
    if (iCents != null && typeof yCents === "number" && yCents > 0) {
      deltaPct = Math.round(((iCents - yCents) / yCents) * 1000) / 10;
    }
    return {
      symbol: r.symbol,
      name: nameOf.get(r.symbol),
      etf: isEtf(nameOf.get(r.symbol)),
      covered: r.ok,
      outcome: r.outcome,
      iress_last_cents: iCents,
      yahoo_last_cents: typeof yCents === "number" ? yCents : null,
      delta_pct: deltaPct,
      marketState: r.marketState,
      error: r.error,
    };
  });
  await writeFile("scripts/scan-coverage.json", JSON.stringify(detail, null, 2));

  const covered = detail.filter((d) => d.covered);
  const notCovered = detail.filter((d) => !d.covered);
  const etfs = detail.filter((d) => d.etf);
  const mismatches = detail
    .filter((d) => d.covered && d.delta_pct != null && Math.abs(d.delta_pct) > 5)
    .sort((a, b) => Math.abs(b.delta_pct ?? 0) - Math.abs(a.delta_pct ?? 0));
  const closeMatch = detail.filter((d) => d.covered && d.delta_pct != null && Math.abs(d.delta_pct) <= 5);

  const summary = {
    total: detail.length,
    covered: covered.length,
    not_covered: notCovered.length,
    not_covered_list: notCovered.map((d) => ({ symbol: d.symbol, name: d.name, outcome: d.outcome, error: d.error })),
    etf_total: etfs.length,
    etf_covered: etfs.filter((d) => d.covered).length,
    etf_not_covered: etfs.filter((d) => !d.covered).map((d) => d.symbol),
    price_check_within_5pct: closeMatch.length,
    price_mismatch_over_5pct: mismatches.length,
    worst_mismatches: mismatches.slice(0, 30).map((d) => ({
      symbol: d.symbol,
      iress_cents: d.iress_last_cents,
      yahoo_cents: d.yahoo_last_cents,
      delta_pct: d.delta_pct,
    })),
  };
  console.log(JSON.stringify(summary, null, 2));
  console.log("\nfull per-symbol detail → wealth-navigator/scripts/scan-coverage.json");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
