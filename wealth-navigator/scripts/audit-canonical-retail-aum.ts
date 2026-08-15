import { loadCanonicalRetailAum } from "../src/lib/aum/canonical-retail-aum";
import { createRetailServiceRoleClient } from "../src/lib/supabase/server";

const result = await loadCanonicalRetailAum(createRetailServiceRoleClient());

console.log(
  JSON.stringify(
    {
      as_of: result.asOf,
      total_aum_cents: result.totalAumCents,
      total_aum_rands: result.totalAumCents / 100,
      consumed_aum_fee_cents: result.totalConsumedAumFeeCents,
      investor_count: result.investorCount,
      holding_count: result.holdingCount,
      strategies: [...result.byStrategy.entries()]
        .map(([strategyId, row]) => ({
          strategy_id: strategyId,
          aum_cents: row.aumCents,
          securities_cents: row.securitiesCents,
          reserve_cents: row.reserveCents,
          residual_cents: row.residualCents,
          consumed_aum_fee_cents: row.consumedAumFeeCents,
          investor_count: row.users.size,
          holding_count: row.holdingCount,
        }))
        .sort((left, right) => right.aum_cents - left.aum_cents),
    },
    null,
    2,
  ),
);
