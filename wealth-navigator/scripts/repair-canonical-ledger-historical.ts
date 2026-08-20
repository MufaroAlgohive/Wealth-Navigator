// Phase 2 of the canonical-ledger YTD chain-linking fix (PR #142 fixed the calculation going
// forward for every strategy; this recomputes historical rows with the fixed logic).
//
// Computes only by default - writes nothing anywhere. Set APPLY_CANONICAL_LEDGER_REPAIR=1 to
// write the computed rows into the shadow table (strategy_canonical_daily_ledger_repair_c). This
// NEVER writes to strategy_canonical_daily_ledger_c and NEVER certifies or promotes anything -
// promotion is a separate, explicit, human-invoked action (see the accompanying migration's
// promote_canonical_ledger_repair_row_c, and the PR description for why it is not called here).
//
// Usage:
//   bun scripts/repair-canonical-ledger-historical.ts                     # dry run, all affected strategies
//   APPLY_CANONICAL_LEDGER_REPAIR=1 bun scripts/repair-canonical-ledger-historical.ts   # write to shadow table
//   CANONICAL_LEDGER_REPAIR_STRATEGY_ID=<uuid> bun scripts/repair-canonical-ledger-historical.ts  # one strategy

import { runFullPlatformRepair } from "../src/lib/returns/repair-canonical-ledger-historical";

const result = await runFullPlatformRepair({
  apply: process.env.APPLY_CANONICAL_LEDGER_REPAIR === "1",
  strategyId: process.env.CANONICAL_LEDGER_REPAIR_STRATEGY_ID?.trim() || undefined,
  asOfDate: process.env.CANONICAL_LEDGER_REPAIR_AS_OF?.trim() || undefined,
});

console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exitCode = 1;
