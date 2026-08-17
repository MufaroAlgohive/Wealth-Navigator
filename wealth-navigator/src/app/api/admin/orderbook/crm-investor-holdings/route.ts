import { NextResponse } from "next/server";

import { getAdminContext } from "@/lib/admin/rbac";
import { costCentsPerShare } from "@/lib/holdings/cost-basis";
import { createRetailServiceRoleClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const auth = await getAdminContext();
  if (auth.status === "no-session") {
    return NextResponse.json({ ok: false, error: "no-session" }, { status: 401 });
  }
  if (auth.status !== "ok") {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  const ids = (new URL(req.url).searchParams.get("ids") ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean)
    .slice(0, 250);
  if (!ids.length) return NextResponse.json({ ok: true, holdings: [] });

  let retail: ReturnType<typeof createRetailServiceRoleClient>;
  try {
    retail = createRetailServiceRoleClient();
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Retail database unavailable" },
      { status: 503 },
    );
  }

  const { data: holdings, error } = await retail
    .from("stock_holdings_c")
    .select('id,security_id,quantity,avg_fill,"Expected_fill",market_value,trade_side')
    .in("id", ids);
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  const securityIds = [...new Set((holdings ?? []).map((holding) => holding.security_id).filter(Boolean))];
  const { data: securities } = securityIds.length
    ? await retail.from("securities_c").select("id,name,symbol").in("id", securityIds)
    : { data: [] };
  const securityById = new Map(
    (securities ?? []).map((security) => [
      String(security.id),
      { name: String(security.name ?? security.symbol ?? "Unknown instrument"), ticker: String(security.symbol ?? "-") },
    ]),
  );

  return NextResponse.json({
    ok: true,
    holdings: (holdings ?? []).map((holding) => {
      const security = securityById.get(String(holding.security_id));
      const avgFill = Number(holding.avg_fill);
      const expected = Number(holding.Expected_fill);
      const qty = Number(holding.quantity ?? 0);
      // stock_holdings_c.market_value is CENTS (verified against last_price_cents
      // for real filled rows — e.g. ABG.JO qty=1: market_value 22341 ≈
      // last_price_cents 22310). This previously passed through with no /100,
      // showing a 100x-inflated Rand value in this table.
      const marketValueRands = holding.market_value == null ? null : Number(holding.market_value) / 100;
      // Recomputed here (shared helper) instead of passed through from
      // stock_holdings_c.unrealized_pnl, which is written by a DIFFERENT
      // app's worker (MINT retail's refreshHeldSecurities) on its own
      // cadence/convention — the exact class of bug that let this column
      // show green here while other admin screens showed the same holding
      // red, because nobody agreed on what "cost" meant.
      const costRands = costCentsPerShare(holding) / 100;
      const pnlRands = marketValueRands != null && costRands > 0 ? marketValueRands - costRands * qty : null;
      return {
        id: String(holding.id),
        source_ids: [String(holding.id)],
        instrument: security?.name ?? "Unknown instrument",
        ticker: security?.ticker ?? "-",
        side: String(holding.trade_side ?? "BUY").toUpperCase(),
        qty,
        avg_fill_rands: Number.isFinite(avgFill) && avgFill > 0 ? avgFill / 100 : null,
        expected_fill_rands: Number.isFinite(expected) && expected > 0 ? expected : null,
        market_value_rands: marketValueRands,
        pnl_rands: pnlRands,
      };
    }),
  });
}
