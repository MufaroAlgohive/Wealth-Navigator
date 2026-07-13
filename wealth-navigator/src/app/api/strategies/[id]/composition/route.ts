import { NextResponse } from "next/server";

import { getAdminContext } from "@/lib/admin/rbac";
import { createRetailServiceRoleClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * GET /api/strategies/[id]/composition
 *
 * The real current basket for a strategy, read from RETAIL strategies_c.holdings
 * (JSONB array of { ticker, name, shares, symbol, weight, quantity }). Used by the
 * Rebalance Builder as the baseline basket so a rebalance is built on the actual
 * strategy composition, not a mock. Read-only.
 */
interface HoldingItem {
  ticker?: string | null;
  symbol?: string | null;
  name?: string | null;
  shares?: number | null;
  quantity?: number | null;
  weight?: number | null;
}

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const auth = await getAdminContext();
  if (auth.status === "no-session") {
    return NextResponse.json({ ok: false, error: "no-session" }, { status: 401 });
  }
  if (auth.status !== "ok") {
    return NextResponse.json({ ok: true, strategy: null, holdings: [], notice: "Composition not available for this session." });
  }

  const db = createRetailServiceRoleClient();
  const { data: strat, error } = await db
    .from("strategies_c")
    .select("id, name, slug, holdings")
    .eq("id", id)
    .maybeSingle();

  if (error) {
    return NextResponse.json({ ok: true, strategy: null, holdings: [], notice: "strategies_c not available." });
  }
  if (!strat) {
    return NextResponse.json({ ok: false, error: `No strategy '${id}'` }, { status: 404 });
  }

  const raw = Array.isArray(strat.holdings) ? (strat.holdings as HoldingItem[]) : [];
  const holdings = raw
    .map((h) => {
      const ticker = String(h.ticker ?? h.symbol ?? "").trim();
      if (!ticker) return null;
      const shares = Number(h.shares ?? h.quantity ?? 0) || 0;
      return {
        ticker: ticker.replace(/\.(JO|JSE)$/i, ""),
        name: String(h.name ?? ticker),
        shares,
        weight: typeof h.weight === "number" ? h.weight : null,
      };
    })
    .filter((h): h is { ticker: string; name: string; shares: number; weight: number | null } => h != null);

  return NextResponse.json({
    ok: true,
    strategy: { id: strat.id, name: strat.name ?? strat.slug ?? "Strategy" },
    holdings,
  });
}
