import { NextResponse } from "next/server";

import { getAdminContext } from "@/lib/admin/rbac";
import { createRetailServiceRoleClient } from "@/lib/supabase/server";

/**
 * Order Book. Read the live/closed holdings ledger (stock_holdings_c + profiles
 * + securities). CSV export is derived client-side from this. Settlement WRITES
 * — price/fill edits, reverse investor, daily snapshot capture, Strate BIR
 * export — are DEFERRED (live trade data / settlement = data phase). Admin-gated
 * by nav; reads require team membership.
 */

export const dynamic = "force-dynamic";

function costRands(h: { avg_fill?: number | null; Expected_fill?: number | null }): number {
  const avgCents = Number(h.avg_fill) || 0;
  const expectedRaw = Number(h.Expected_fill) || 0;
  const avgRands = avgCents > 0 ? avgCents / 100 : 0;
  if (expectedRaw > 0) return avgRands > 0 && expectedRaw > avgRands * 5 ? expectedRaw / 100 : expectedRaw;
  return avgRands;
}

export async function GET(req: Request) {
  const auth = await getAdminContext();
  if (auth.status === "no-session") return NextResponse.json({ ok: false, error: "no-session" }, { status: 401 });
  if (auth.status !== "ok") return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });

  const url = new URL(req.url);
  const status = url.searchParams.get("status") === "closed" ? "closed" : "active";
  const scope = url.searchParams.get("scope") === "uat" ? "uat" : "live";

  let db;
  try {
    db = createRetailServiceRoleClient();
  } catch {
    return NextResponse.json({ ok: true, rows: [], notice: "RETAIL database not configured." });
  }

  const { data: holds } = await db
    .from("stock_holdings_c")
    .select("id, user_id, security_id, quantity, avg_fill, Expected_fill, trade_side, Status, Fill_date, strategy_name_snapshot")
    .eq("is_active", status === "active")
    .order("created_at", { ascending: false })
    .limit(3000);
  let rows = holds ?? [];

  // Live/UAT scope by profiles.is_test.
  const userIds = [...new Set(rows.map((h) => h.user_id).filter(Boolean))];
  const profMap: Record<string, { email: string | null; is_test: boolean | null; first_name: string | null; last_name: string | null }> = {};
  if (userIds.length) {
    const { data: profs } = await db.from("profiles").select("id, email, first_name, last_name, is_test").in("id", userIds);
    for (const p of profs ?? []) profMap[p.id as string] = p as never;
  }
  rows = rows.filter((h) => {
    const t = !!profMap[h.user_id as string]?.is_test;
    return scope === "uat" ? t : !t;
  });

  const secIds = [...new Set(rows.map((h) => h.security_id).filter(Boolean))];
  const secMap: Record<string, { symbol: string; name: string | null; isin: string | null; last_price: number | null }> = {};
  if (secIds.length) {
    const { data: secs } = await db.from("securities_c").select("id, symbol, name, isin, last_price").in("id", secIds);
    for (const s of secs ?? []) secMap[s.id as string] = s as never;
  }

  const out = rows.map((h) => {
    const prof = profMap[h.user_id as string];
    const sec = secMap[h.security_id as string];
    const qty = Number(h.quantity) || 0;
    const avgRands = (Number(h.avg_fill) || 0) / 100;
    const expectedRands = costRands(h);
    const liveRands = sec?.last_price != null && Number(sec.last_price) > 0 ? Number(sec.last_price) : expectedRands;
    return {
      id: h.id,
      security_id: (h.security_id as string) ?? null,
      user_id: (h.user_id as string) ?? null,
      email: prof?.email ?? "—",
      client: `${prof?.first_name || ""} ${prof?.last_name || ""}`.trim() || prof?.email || "—",
      instrument: sec?.name ?? sec?.symbol ?? "—",
      ticker: sec?.symbol ?? "—",
      isin: sec?.isin ?? "",
      side: (h.trade_side as string) || "BUY",
      qty,
      avgFill: avgRands,
      expectedFill: expectedRands,
      livePrice: liveRands,
      status: (h.Status as string) ?? null,
      fillDate: (h.Fill_date as string) ?? null,
      strategy: (h.strategy_name_snapshot as string) ?? null,
      clientPnl: (liveRands - expectedRands) * qty,
      mintPnl: Math.max(0, expectedRands - avgRands) * qty,
    };
  });

  return NextResponse.json({ ok: true, rows: out });
}

export async function POST() {
  // Price/fill edits, reverse investor, snapshot capture, Strate BIR export —
  // all mutate live trade/settlement data → deferred to the data phase.
  return NextResponse.json({ ok: false, error: "Order Book settlement actions (price/fill/reverse/snapshot/Strate BIR) are deferred to the data phase.", deferred: true }, { status: 501 });
}
