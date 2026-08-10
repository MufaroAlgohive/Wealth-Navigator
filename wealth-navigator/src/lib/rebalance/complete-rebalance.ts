import type { SupabaseClient } from "@supabase/supabase-js";

import { sealRebalanceBoundary } from "@/lib/returns/seal-rebalance-boundary";

/**
 * Once every order booked for a rebalance (reconcile-parked-holdings.ts /
 * book-settled-rebalance-orders.ts, both tag their orders with
 * `payload.rebalance_request_id`) has finished — filled, cancelled, or
 * rejected, nothing left outstanding — the strategy's own canonical model
 * composition (`strategies_c.holdings`) is what should finally flip to the
 * new target. Not at IC approval, not at Send to Order Book: only once the
 * market has actually confirmed it, matching the same "nothing changes until
 * filled" rule applied to every individual client's holdings. Called from
 * the fill path (admin/orderbook/fills/route.ts) after each fill.
 *
 * Flipping the composition and sealing the strategy's return boundary are one
 * atomic decision, not two steps: `strategies_c.holdings` is what the EOD
 * return publisher prices, so a flip without a matching boundary makes the
 * next publication read the composition change as a one-day return and chain
 * it into YTD permanently. The boundary is therefore sealed FIRST and the
 * flip only happens if it succeeded — leaving the rebalance visibly
 * unfinished (and retryable) is recoverable; a corrupted return chain is not.
 */

function bare(sym: string): string {
  return String(sym ?? "")
    .trim()
    .toUpperCase()
    .replace(/\.(JO|JSE)$/i, "");
}

interface ProposedLine {
  ticker: string;
  name?: string;
  action?: string;
  shares?: number | null;
}

export interface CompleteRebalanceResult {
  completed: boolean;
  error?: string;
  /** Return-boundary outcome, when the rebalance reached the flip step. */
  boundary?: {
    sealed: boolean;
    error?: string;
    ytdPct?: number;
    continuityCashCents?: number;
    completeValueCents?: number;
  };
}

export async function maybeCompleteRebalance(
  retailDb: SupabaseClient,
  institutionalDb: SupabaseClient,
  rebalanceRequestId: string,
  actorId?: string,
): Promise<CompleteRebalanceResult> {
  const siblingsRes = await institutionalDb
    .from("oems_order_audit")
    .select("status")
    .eq("payload->>rebalance_request_id", rebalanceRequestId);
  if (siblingsRes.error) return { completed: false, error: siblingsRes.error.message };
  const siblings = siblingsRes.data ?? [];
  if (siblings.length === 0) return { completed: false };
  const allDone = siblings.every((r) => ["filled", "cancelled", "rejected"].includes(r.status as string));
  if (!allDone) return { completed: false };

  const reqRes = await institutionalDb
    .from("rebalance_request_c")
    .select("strategy_id, proposed_composition")
    .eq("id", rebalanceRequestId)
    .maybeSingle();
  if (reqRes.error) return { completed: false, error: reqRes.error.message };
  if (!reqRes.data) return { completed: false };

  const strategyName = reqRes.data.strategy_id as string;
  const proposed = (
    Array.isArray(reqRes.data.proposed_composition) ? reqRes.data.proposed_composition : []
  ) as ProposedLine[];
  const lines = proposed.filter(
    (p) => (p.action ?? "hold") !== "sell" && Math.round(Number(p.shares) || 0) > 0,
  );
  if (lines.length === 0) return { completed: false, error: "proposed composition has no positive lines" };

  const symbols = lines.map((p) => bare(p.ticker));
  const symbolCandidates = symbols.flatMap((s) => [s, `${s}.JO`]);
  const secRes = await retailDb
    .from("securities_c")
    .select("symbol, last_price")
    .in("symbol", symbolCandidates);
  if (secRes.error) return { completed: false, error: secRes.error.message };
  const priceBySymbol = new Map<string, number>();
  for (const s of secRes.data ?? []) priceBySymbol.set(bare(s.symbol as string), Number(s.last_price) || 0);

  const valued = lines.map((p) => {
    const sym = bare(p.ticker);
    const shares = Math.max(0, Math.round(Number(p.shares) || 0));
    const priceCents = priceBySymbol.get(sym) ?? 0;
    return { ticker: p.ticker, name: p.name ?? sym, shares, valueCents: shares * priceCents };
  });
  const totalCents = valued.reduce((s, v) => s + v.valueCents, 0) || 1;
  const holdings = valued.map((v) => ({
    name: v.name,
    shares: v.shares,
    symbol: v.ticker,
    ticker: v.ticker,
    quantity: v.shares,
    weight: Math.round((v.valueCents / totalCents) * 10000) / 100,
  }));

  const stratRes = await retailDb
    .from("strategies_c")
    .select("id, holdings")
    .eq("name", strategyName)
    .maybeSingle();
  if (stratRes.error) return { completed: false, error: stratRes.error.message };
  if (!stratRes.data?.id) return { completed: false, error: `strategy "${strategyName}" not found` };
  const strategyId = stratRes.data.id as string;

  // Seal the return boundary before the composition moves. See this module's
  // doc comment: the publisher prices whatever `strategies_c.holdings` says,
  // so a flip that outruns its boundary is an unrecoverable YTD corruption.
  const boundary = await sealRebalanceBoundary(retailDb, {
    strategyId,
    strategyName,
    holdings: holdings.map((h) => ({ symbol: h.symbol, shares: h.shares })),
    actorId: actorId ?? "",
    holdingsBefore: stratRes.data.holdings ?? null,
  });
  if (!boundary.sealed) {
    return {
      completed: false,
      error: `return boundary not sealed, composition left unchanged: ${boundary.error ?? "unknown"}`,
      boundary: { sealed: false, error: boundary.error },
    };
  }

  const updRes = await retailDb
    .from("strategies_c")
    .update({ holdings, updated_at: new Date().toISOString() })
    .eq("id", strategyId);
  if (updRes.error) return { completed: false, error: updRes.error.message };

  return {
    completed: true,
    boundary: {
      sealed: true,
      ytdPct: boundary.ytdPct,
      continuityCashCents: boundary.continuityCashCents,
      completeValueCents: boundary.completeValueCents,
    },
  };
}
