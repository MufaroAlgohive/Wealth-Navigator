import { NextResponse } from "next/server";

import { getAdminContext } from "@/lib/admin/rbac";
import { createRetailServiceRoleClient } from "@/lib/supabase/server";

/**
 * Factsheets (read-only). Gallery + single-strategy detail over strategies_c,
 * strategies_returns_c, securities_c, client_strategy_returns_c (RETAIL).
 * Daily returns are derived from the basket_value series (the per-period pct
 * columns are digit-prefixed and awkward in PostgREST).
 */

export const dynamic = "force-dynamic";

interface ReturnRow { strategy_id: string; as_of_date: string; ytd_pct: number | null; all_pct: number | null; basket_value: number | null; }

export async function GET(req: Request) {
  const auth = await getAdminContext();
  if (auth.status === "no-session") return NextResponse.json({ ok: false, error: "no-session" }, { status: 401 });
  if (auth.status === "not-member") return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });

  const url = new URL(req.url);
  const action = url.searchParams.get("action") || "list";

  let db;
  try {
    db = createRetailServiceRoleClient();
  } catch {
    return NextResponse.json({ ok: true, strategies: [], returns: {}, securities: {}, investors: {}, notice: "RETAIL database not configured." });
  }

  const securitiesFor = async (strategies: Array<{ holdings: unknown }>) => {
    const symbols = new Set<string>();
    for (const s of strategies) {
      const hs = Array.isArray(s.holdings) ? (s.holdings as Array<Record<string, unknown>>) : [];
      for (const h of hs) { const sym = (h.ticker || h.symbol) as string | undefined; if (sym) symbols.add(String(sym)); }
    }
    const out: Record<string, unknown> = {};
    if (symbols.size) {
      const { data } = await db!.from("securities_c").select("symbol, name, logo_url, last_price, change_percent").in("symbol", [...symbols]);
      for (const sec of data ?? []) out[sec.symbol as string] = sec;
    }
    return out;
  };

  if (action === "detail") {
    const id = url.searchParams.get("id") || "";
    if (!id) return NextResponse.json({ ok: false, error: "id required" }, { status: 400 });
    const { data: strategy } = await db.from("strategies_c").select("*").eq("id", id).maybeSingle();
    if (!strategy) return NextResponse.json({ ok: false, error: "not found" }, { status: 404 });
    const { data: returns } = await db
      .from("strategies_returns_c")
      .select("strategy_id, as_of_date, ytd_pct, all_pct, basket_value")
      .eq("strategy_id", id)
      .order("as_of_date", { ascending: true })
      .limit(800);
    const securities = await securitiesFor([strategy]);
    return NextResponse.json({ ok: true, strategy, returns: returns ?? [], securities });
  }

  if (action === "list") {
    const { data: strategies, error } = await db.from("strategies_c").select("*").order("created_at", { ascending: false });
    if (error) return NextResponse.json({ ok: true, strategies: [], returns: {}, securities: {}, investors: {}, notice: error.message });
    const rows = strategies ?? [];

    // Recent returns series grouped by strategy (newest-first fetch → ascending series).
    const { data: ret } = await db
      .from("strategies_returns_c")
      .select("strategy_id, as_of_date, ytd_pct, all_pct, basket_value")
      .order("as_of_date", { ascending: false })
      .limit(4000);
    const returns: Record<string, { latest: ReturnRow | null; series: number[] }> = {};
    for (const r of (ret ?? []) as ReturnRow[]) {
      const g = (returns[r.strategy_id] ||= { latest: null, series: [] });
      if (!g.latest) g.latest = r; // first seen = newest
      if (r.basket_value != null) g.series.push(Number(r.basket_value));
    }
    for (const g of Object.values(returns)) g.series.reverse(); // → ascending

    // Investor counts (distinct users per strategy, capped).
    const investors: Record<string, number> = {};
    const { data: csr } = await db.from("client_strategy_returns_c").select("strategy_id, user_id").limit(5000);
    const seen = new Set<string>();
    for (const c of csr ?? []) {
      const key = `${c.strategy_id}|${c.user_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      investors[c.strategy_id as string] = (investors[c.strategy_id as string] || 0) + 1;
    }

    const securities = await securitiesFor(rows);
    return NextResponse.json({ ok: true, strategies: rows, returns, securities, investors });
  }

  return NextResponse.json({ ok: false, error: `Unknown action: ${action}` }, { status: 400 });
}
