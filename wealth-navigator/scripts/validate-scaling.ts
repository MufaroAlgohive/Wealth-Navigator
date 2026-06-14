/**
 * Validate the reference-anchored scaler against the captured coverage data.
 * Reconstructs the worker's mapped `last` (Rands) from scan-coverage.json,
 * runs chooseDisplayCents against the Yahoo reference, and reports how close
 * the *corrected* IRESS price lands to Yahoo. Read-only, local, no worker call.
 *
 * Run from wealth-navigator/:  bun run scripts/validate-scaling.ts
 */
import { readFile } from "node:fs/promises";
import { chooseDisplayCents } from "../workers/iress-ingest/src/scale";

interface CovRow {
  symbol: string;
  covered: boolean;
  iress_last_cents: number | null; // = round(worker.last * 100) from the probe
  yahoo_last_cents: number | null;
}

async function main(): Promise<void> {
  const rows = JSON.parse(await readFile("scripts/scan-coverage.json", "utf-8")) as CovRow[];
  const covered = rows.filter((r) => r.covered && r.iress_last_cents != null && r.yahoo_last_cents);

  let within10 = 0;
  let within25 = 0;
  let big = 0;
  let stillBy100 = 0;
  const examples: Array<Record<string, unknown>> = [];

  for (const r of covered) {
    const lastRands = (r.iress_last_cents as number) / 100; // reconstruct worker.last
    const ref = r.yahoo_last_cents as number;
    const fixed = chooseDisplayCents(lastRands, ref).cents;
    const deltaPct = Math.round(((fixed - ref) / ref) * 1000) / 10;
    const ad = Math.abs(deltaPct);
    if (ad <= 10) within10 += 1;
    else if (ad <= 25) within25 += 1;
    else big += 1;
    if (ad > 5000) stillBy100 += 1; // would indicate the fix did NOT correct a 100x error
    if (examples.length < 18) {
      examples.push({ symbol: r.symbol, fixed_cents: fixed, yahoo_cents: ref, delta_pct: deltaPct });
    }
  }

  console.log(
    JSON.stringify(
      {
        covered_with_ref: covered.length,
        within_10pct: within10,
        within_10_to_25pct: within25,
        over_25pct: big,
        still_off_by_100x: stillBy100,
        examples,
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
