import { NextResponse } from "next/server";

import { getAdminContext } from "@/lib/admin/rbac";
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
    .select('id,security_id,quantity,avg_fill,"Expected_fill",market_value,unrealized_pnl,trade_side')
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
      return {
        id: String(holding.id),
        source_ids: [String(holding.id)],
        instrument: security?.name ?? "Unknown instrument",
        ticker: security?.ticker ?? "-",
        side: String(holding.trade_side ?? "BUY").toUpperCase(),
        qty: Number(holding.quantity ?? 0),
        avg_fill_rands: Number.isFinite(avgFill) && avgFill > 0 ? avgFill / 100 : null,
        expected_fill_rands: Number.isFinite(expected) && expected > 0 ? expected : null,
        market_value_rands: holding.market_value == null ? null : Number(holding.market_value),
        pnl_rands: holding.unrealized_pnl == null ? null : Number(holding.unrealized_pnl),
      };
    }),
  });
}
