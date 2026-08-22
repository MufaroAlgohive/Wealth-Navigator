import type { SupabaseClient } from "@supabase/supabase-js";

import { createRetailServiceRoleClient, isRetailSupabaseConfigured } from "../supabase/server";

/**
 * Phase 2 of the canonical-ledger YTD chain-linking fix (see
 * publish-canonical-ledger-draft.ts's directMetric()).
 *
 * PR #142 fixed the calculation going forward, but every historical row already written to
 * strategy_canonical_daily_ledger_c for every strategy that has ever rebalanced was computed with
 * the old, buggy leg-sum-denominator logic and understates the true return. This module finds
 * every strategy affected by that bug - by QUERY, not a hardcoded list - so the bulk historical
 * reprocessor (repair-canonical-ledger-historical.ts) knows what to recompute.
 *
 * "Affected" = has rebalanced at least once, i.e. either:
 *   - more than one row in strategy_composition_log_c (a strategy that has only ever had its
 *     inception composition has nothing to chain-link across), OR
 *   - at least one rebalance_batch row with status = 'SETTLED' (the batch that actually produced a
 *     boundary rewrite in the ledger).
 * A strategy can satisfy either or both; both are reported so a reviewer can sanity-check the
 * discovery logic against what they already know about a given strategy's history.
 */

export type AffectedStrategyReason = "MULTIPLE_COMPOSITIONS" | "SETTLED_REBALANCE_BATCH" | "BOTH";

export type AffectedStrategy = {
  id: string;
  name: string;
  /** The strategy's TRUE inception date/time - strategies_c.created_at, NOT
   *  strategy_composition_log_c's effective_from, which has been observed to carry a placeholder
   *  value (e.g. "2026-01-01") unrelated to when the strategy actually launched. */
  createdAt: string;
  status: string;
  compositionRowCount: number;
  settledBatchCount: number;
  reason: AffectedStrategyReason;
};

/**
 * Pure aggregation over raw rows - no DB access - so this is directly unit-testable without a
 * live database. Exported separately from findAffectedStrategies() for exactly that reason.
 */
export function affectedStrategyCounts(
  compositionRows: Array<{ strategy_id: string | null }>,
  batchRows: Array<{ strategy_id: string | null; status: string | null }>,
): Map<string, { compositionRowCount: number; settledBatchCount: number; reason: AffectedStrategyReason }> {
  const compositionCounts = new Map<string, number>();
  for (const row of compositionRows) {
    const id = String(row.strategy_id ?? "").trim();
    if (!id) continue;
    compositionCounts.set(id, (compositionCounts.get(id) ?? 0) + 1);
  }
  const settledCounts = new Map<string, number>();
  for (const row of batchRows) {
    const id = String(row.strategy_id ?? "").trim();
    if (!id || row.status !== "SETTLED") continue;
    settledCounts.set(id, (settledCounts.get(id) ?? 0) + 1);
  }
  const multiComposition = new Set(
    [...compositionCounts.entries()].filter(([, count]) => count > 1).map(([id]) => id),
  );
  const settled = new Set(settledCounts.keys());
  const ids = new Set([...multiComposition, ...settled]);
  const result = new Map<
    string,
    { compositionRowCount: number; settledBatchCount: number; reason: AffectedStrategyReason }
  >();
  for (const id of ids) {
    const hasMulti = multiComposition.has(id);
    const hasSettled = settled.has(id);
    result.set(id, {
      compositionRowCount: compositionCounts.get(id) ?? 0,
      settledBatchCount: settledCounts.get(id) ?? 0,
      reason:
        hasMulti && hasSettled ? "BOTH" : hasMulti ? "MULTIPLE_COMPOSITIONS" : "SETTLED_REBALANCE_BATCH",
    });
  }
  return result;
}

async function many<T>(
  label: string,
  query: PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
) {
  const { data, error } = await query;
  if (error) throw new Error(`${label}: ${error.message}`);
  return data ?? [];
}

/**
 * Queries the live database for every strategy affected by the leg-sum-denominator bug.
 * Deliberately does NOT filter by strategy status (unlike the daily publisher) - a strategy that
 * has since been retired/paused still has historically-wrong CERTIFIED rows that a human may want
 * to review and correct, even if it's no longer actively traded.
 */
export async function findAffectedStrategies(db: SupabaseClient): Promise<AffectedStrategy[]> {
  const [compositionRows, batchRows] = await Promise.all([
    many<{ strategy_id: string | null }>(
      "composition log",
      db.from("strategy_composition_log_c").select("strategy_id"),
    ),
    many<{ strategy_id: string | null; status: string | null }>(
      "rebalance batches",
      db.from("rebalance_batch").select("strategy_id,status"),
    ),
  ]);
  const counts = affectedStrategyCounts(compositionRows, batchRows);
  if (!counts.size) return [];
  const strategies = await many<{ id: string; name: string; created_at: string; status: string }>(
    "strategies",
    db
      .from("strategies_c")
      .select("id,name,created_at,status")
      .in("id", [...counts.keys()]),
  );
  return strategies
    .map((strategy) => {
      const counted = counts.get(strategy.id);
      if (!counted) return null;
      return {
        id: strategy.id,
        name: strategy.name,
        createdAt: strategy.created_at,
        status: strategy.status,
        compositionRowCount: counted.compositionRowCount,
        settledBatchCount: counted.settledBatchCount,
        reason: counted.reason,
      };
    })
    .filter((row): row is AffectedStrategy => row !== null)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export type AffectedStrategyDiscoveryResult = {
  ok: boolean;
  strategies: AffectedStrategy[];
  note?: string;
};

/** Convenience wrapper matching the ok/note shape used by publish-canonical-ledger-draft.ts and
 *  publish-canonical-ledger-certification.ts, for callers (API routes, scripts) that want it. */
export async function discoverAffectedStrategies(): Promise<AffectedStrategyDiscoveryResult> {
  if (!isRetailSupabaseConfigured()) {
    return { ok: false, strategies: [], note: "retail supabase not configured" };
  }
  const db = createRetailServiceRoleClient();
  const strategies = await findAffectedStrategies(db);
  return { ok: true, strategies };
}
