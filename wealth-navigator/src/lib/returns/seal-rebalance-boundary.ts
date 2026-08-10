import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Seal a strategy's return boundary at the moment its composition changes.
 *
 * A rebalance changes WHAT a strategy holds, not how it has performed. Left
 * alone, the EOD return publisher would price the new basket against the old
 * basket's complete value and book the difference as a one-day return — the
 * composition change would masquerade as investment performance, and because
 * the publisher chains (`chain_factor *= 1 + oneDay/100`), that phantom move
 * is permanent: it shifts YTD for the rest of the year and drags every chart
 * and factsheet with it.
 *
 * `finalize_rebalance_return_boundary` (retail RPC, SETTLEMENT_CHAIN_V1) is
 * the existing, guarded mechanism that prevents this. It carries the prior
 * chain factor and YTD across the boundary untouched, and absorbs the value
 * the new securities no longer represent into "continuity cash" so the
 * strategy's COMPLETE value (securities + continuity cash) is preserved
 * across the change. The next EOD run then measures its one-day move from
 * that preserved base — real market movement only.
 *
 * The RPC keys off `rebalance_batch`, so an OEM rebalance records one batch
 * row for its settlement and seals against it. Both the RPC's writes
 * (`strategy_valuation_rules_c`, `strategy_return_publication_audit_c`) are
 * ON CONFLICT DO UPDATE at daily granularity, so re-sealing the same strategy
 * on the same day converges on the latest settlement's numbers rather than
 * double-counting — which is the RPC's own stated intent.
 *
 * Prices come from `stock_intraday_c`, deliberately the SAME source the EOD
 * publisher uses. Sealing against a different price source than the publisher
 * reads would itself create a step change at the boundary — the exact bug
 * this function exists to prevent. `securities_c.last_price` is not used here
 * for that reason.
 */

export interface BoundaryHolding {
  symbol: string;
  shares: number;
}

export interface SealBoundaryResult {
  sealed: boolean;
  /** Set when sealing was refused or failed; the caller must not treat the rebalance as settled. */
  error?: string;
  securitiesValueCents?: number;
  continuityCashCents?: number;
  completeValueCents?: number;
  ytdPct?: number;
  batchId?: string;
  idempotent?: boolean;
}

function bare(symbol: string): string {
  return String(symbol ?? "")
    .trim()
    .toUpperCase()
    .replace(/\.(JO|JSE)$/i, "");
}

/**
 * Latest intraday price (cents) per base symbol, mirroring the EOD
 * publisher's own lookup: last four days of ticks, newest first, first
 * positive price per symbol wins.
 */
async function latestPrices(
  retailDb: SupabaseClient,
  symbols: string[],
): Promise<{ priceCents: Map<string, number>; freshestAt: string | null }> {
  const universe = [...new Set(symbols.flatMap((s) => [s, `${s}.JO`]))];
  const since = new Date(Date.now() - 4 * 86_400_000).toISOString();
  const res = await retailDb
    .from("stock_intraday_c")
    .select("symbol, current_price, timestamp")
    .in("symbol", universe)
    .gte("timestamp", since)
    .order("timestamp", { ascending: false });

  const priceCents = new Map<string, number>();
  let freshestAt: string | null = null;
  for (const row of (res.data ?? []) as Array<{
    symbol: string;
    current_price: number | string | null;
    timestamp: string;
  }>) {
    const base = bare(row.symbol);
    const price = Number(row.current_price);
    if (priceCents.has(base) || !(price > 0)) continue;
    priceCents.set(base, price);
    if (!freshestAt || row.timestamp > freshestAt) freshestAt = row.timestamp;
  }
  return { priceCents, freshestAt };
}

export async function sealRebalanceBoundary(
  retailDb: SupabaseClient,
  params: {
    strategyId: string;
    strategyName: string;
    /** The composition the strategy is moving TO. */
    holdings: BoundaryHolding[];
    actorId: string;
    holdingsBefore?: unknown;
    effectiveAt?: Date;
  },
): Promise<SealBoundaryResult> {
  const { strategyId, strategyName, actorId } = params;
  const effectiveAt = params.effectiveAt ?? new Date();

  const holdings = params.holdings
    .map((h) => ({ symbol: bare(h.symbol), shares: Math.max(0, Math.round(Number(h.shares) || 0)) }))
    .filter((h) => h.symbol && h.shares > 0);
  if (holdings.length === 0) return { sealed: false, error: "no positive holdings to value" };
  if (!actorId) return { sealed: false, error: "no actor to attribute the settlement to" };

  const { priceCents, freshestAt } = await latestPrices(
    retailDb,
    holdings.map((h) => h.symbol),
  );

  // Full coverage or nothing. A boundary sealed on a partially-priced basket
  // understates securities value, which the RPC would then absorb into
  // continuity cash — silently and permanently misstating what the strategy
  // holds. Refusing to seal keeps the rebalance visibly unfinished instead,
  // which is recoverable; a bad seal is not.
  const missing = holdings.filter((h) => !priceCents.has(h.symbol)).map((h) => h.symbol);
  if (missing.length > 0) {
    return {
      sealed: false,
      error: `no recent price for ${missing.join(", ")} — refusing to seal a partial boundary`,
    };
  }

  const securitiesValueCents = Math.round(
    holdings.reduce((sum, h) => sum + h.shares * (priceCents.get(h.symbol) ?? 0), 0),
  );

  // The RPC resolves the strategy from its batch, so the settlement needs one.
  const batchRes = await retailDb
    .from("rebalance_batch")
    .insert({
      strategy_id: strategyId,
      strategy_name_snapshot: strategyName,
      status: "SETTLED",
      settlement_state: "COMPLETE",
      effective_date: effectiveAt.toISOString().slice(0, 10),
      holdings_snapshot_before: params.holdingsBefore ?? null,
      holdings_snapshot_planned: holdings,
      created_by: actorId,
      settled_by: actorId,
      settled_at: effectiveAt.toISOString(),
      is_reversed: false,
    })
    .select("id")
    .maybeSingle();
  if (batchRes.error)
    return { sealed: false, error: `rebalance_batch insert failed: ${batchRes.error.message}` };
  const batchId = batchRes.data?.id as string | undefined;
  if (!batchId) return { sealed: false, error: "rebalance_batch insert returned no id" };

  const rpcRes = await retailDb.rpc("finalize_rebalance_return_boundary", {
    p_batch_id: batchId,
    p_securities_value_cents: securitiesValueCents,
    p_holdings_snapshot: holdings,
    p_effective_at: effectiveAt.toISOString(),
    p_price_observed_at: freshestAt ?? effectiveAt.toISOString(),
    p_actor: actorId,
  });
  if (rpcRes.error) return { sealed: false, error: `boundary RPC failed: ${rpcRes.error.message}`, batchId };

  const out = (rpcRes.data ?? {}) as {
    idempotent?: boolean;
    securities_value_cents?: number;
    continuity_cash_cents?: number;
    complete_value_cents?: number;
    ytd_pct?: number;
  };
  return {
    sealed: true,
    batchId,
    idempotent: out.idempotent === true,
    securitiesValueCents: Number(out.securities_value_cents ?? securitiesValueCents),
    continuityCashCents: Number(out.continuity_cash_cents ?? 0),
    completeValueCents: Number(out.complete_value_cents ?? 0),
    ytdPct: out.ytd_pct == null ? undefined : Number(out.ytd_pct),
  };
}
