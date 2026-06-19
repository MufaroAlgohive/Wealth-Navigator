import { NextResponse } from "next/server";

import { getAdminContext, isAdminRole } from "@/lib/admin/rbac";
import { createRetailServiceRoleClient } from "@/lib/supabase/server";

/**
 * Client View Studio. Ports `/api/studio-config` + the client/portfolio reads
 * studio.html did directly against Supabase. Impersonation (`/api/team?action=
 * impersonate`) is a Supabase auth-admin generateLink → DEFERRED (auth bucket).
 * Studio is admin-only.
 */

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const auth = await getAdminContext();
  if (auth.status === "no-session") return NextResponse.json({ ok: false, error: "no-session" }, { status: 401 });
  if (auth.status !== "ok" || !isAdminRole(auth.ctx)) return NextResponse.json({ ok: false, error: "Admins only" }, { status: 403 });

  const url = new URL(req.url);
  const action = url.searchParams.get("action") || "config";

  if (action === "config") {
    return NextResponse.json({
      ok: true,
      dev: process.env.MINT_APP_URL_DEV || "",
      live: process.env.MINT_APP_URL_LIVE || "",
    });
  }

  let db;
  try {
    db = createRetailServiceRoleClient();
  } catch {
    return NextResponse.json({ ok: true, clients: [], notice: "RETAIL database not configured." });
  }

  if (action === "clients") {
    const scope = url.searchParams.get("scope") === "all" ? "all" : "invested";
    if (scope === "all") {
      const { data } = await db.from("profiles").select("id, first_name, last_name, email, mint_number").order("created_at", { ascending: false }).limit(1000);
      return NextResponse.json({ ok: true, clients: (data ?? []).map((p) => ({ id: p.id, name: `${p.first_name || ""} ${p.last_name || ""}`.trim() || p.email, email: p.email, strategy: null })) });
    }
    // invested: distinct holders + a strategy label
    const { data: holds } = await db.from("stock_holdings_c").select("user_id, strategy_name_snapshot").eq("is_active", true).limit(5000);
    const stratByUser: Record<string, string> = {};
    const ids = new Set<string>();
    for (const h of holds ?? []) {
      if (!h.user_id) continue;
      ids.add(h.user_id as string);
      if (!stratByUser[h.user_id as string] && h.strategy_name_snapshot) stratByUser[h.user_id as string] = h.strategy_name_snapshot as string;
    }
    if (ids.size === 0) return NextResponse.json({ ok: true, clients: [] });
    const { data: profiles } = await db.from("profiles").select("id, first_name, last_name, email, mint_number").in("id", [...ids]);
    const clients = (profiles ?? []).map((p) => ({ id: p.id, name: `${p.first_name || ""} ${p.last_name || ""}`.trim() || p.email, email: p.email, strategy: stratByUser[p.id as string] ?? null }));
    return NextResponse.json({ ok: true, clients });
  }

  if (action === "portfolio") {
    const userId = url.searchParams.get("user_id") || "";
    if (!userId) return NextResponse.json({ ok: false, error: "user_id required" }, { status: 400 });
    const { data: holds } = await db
      .from("stock_holdings_c")
      .select("id, security_id, quantity, avg_fill, Expected_fill, market_value, strategy_id, strategy_name_snapshot")
      .eq("user_id", userId)
      .eq("is_active", true);
    const secIds = [...new Set((holds ?? []).map((h) => h.security_id).filter(Boolean))];
    const secMap: Record<string, { symbol: string; name: string | null; logo_url: string | null; last_price: number | null }> = {};
    if (secIds.length) {
      const { data: secs } = await db.from("securities_c").select("id, symbol, name, logo_url, last_price").in("id", secIds);
      for (const s of secs ?? []) secMap[s.id as string] = s as never;
    }
    const holdings = (holds ?? []).map((h) => {
      const sec = secMap[h.security_id as string];
      const qty = Number(h.quantity || 0);
      const expected = Number(h.Expected_fill || 0);
      const avg = Number(h.avg_fill || 0);
      const cost = expected > 0 && !(avg > 0 && expected > avg * 5) ? expected : avg || expected;
      const live = sec?.last_price != null && Number(sec.last_price) > 0 ? Number(sec.last_price) : cost;
      const marketValue = qty * live;
      const costTotal = qty * cost;
      return {
        id: h.id, symbol: sec?.symbol ?? "—", name: sec?.name ?? sec?.symbol ?? "—", logo_url: sec?.logo_url ?? null,
        quantity: qty, cost, live, marketValue, pnl: marketValue - costTotal, strategy: h.strategy_name_snapshot ?? null,
      };
    });
    const totalValue = holdings.reduce((s, h) => s + h.marketValue, 0);
    const totalPnl = holdings.reduce((s, h) => s + h.pnl, 0);
    const invested = totalValue - totalPnl;
    const { data: txns } = await db.from("transactions").select("id, name, description, amount, direction, transaction_date").eq("user_id", userId).order("transaction_date", { ascending: false }).limit(6);
    const strategies = [...new Set(holdings.map((h) => h.strategy).filter(Boolean))];
    return NextResponse.json({
      ok: true,
      holdings: holdings.sort((a, b) => b.marketValue - a.marketValue),
      transactions: txns ?? [],
      totalValue, totalPnl, pnlPct: invested > 0 ? (totalPnl / invested) * 100 : 0,
      strategyCount: strategies.length,
    });
  }

  return NextResponse.json({ ok: false, error: `Unknown action: ${action}` }, { status: 400 });
}

export async function POST() {
  // impersonate → Supabase auth-admin generateLink. Deferred to the auth/backend phase.
  return NextResponse.json({ ok: false, error: "Client impersonation (auth sign-in link) is deferred to the auth/backend phase.", deferred: true }, { status: 501 });
}
