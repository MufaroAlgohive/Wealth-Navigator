import { NextResponse } from "next/server";

import { getAdminContext } from "@/lib/admin/rbac";
import { createRetailServiceRoleClient } from "@/lib/supabase/server";

/**
 * Strategy catalogue. Legacy `strategies.html` talked to Supabase directly.
 * READS ported: list strategies (+ a securities price map for holdings) and
 * security search. WRITES (create/edit `strategies_c`) are DEFERRED — they
 * mutate the live retail catalogue (data phase). POST returns 501 + notice.
 */

export const dynamic = "force-dynamic";

const DEFER = "Strategy create/edit is deferred — it writes the live strategies_c catalogue (data phase).";

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
    return NextResponse.json({ ok: true, strategies: [], securities: {}, notice: "RETAIL database not configured." });
  }

  if (action === "search-securities") {
    const q = (url.searchParams.get("q") || "").trim();
    if (!q) return NextResponse.json({ ok: true, securities: [] });
    const { data } = await db
      .from("securities_c")
      .select("symbol, name, logo_url, last_price")
      .or(`symbol.ilike.%${q}%,name.ilike.%${q}%`)
      .limit(20);
    return NextResponse.json({ ok: true, securities: data ?? [] });
  }

  if (action === "list") {
    const { data: strategies, error } = await db.from("strategies_c").select("*").order("created_at", { ascending: false });
    if (error) return NextResponse.json({ ok: true, strategies: [], securities: {}, notice: error.message });
    const rows = strategies ?? [];
    const symbols = new Set<string>();
    for (const s of rows) {
      const hs = Array.isArray(s.holdings) ? (s.holdings as Array<Record<string, unknown>>) : [];
      for (const h of hs) {
        const sym = (h.ticker || h.symbol || (typeof h === "string" ? h : null)) as string | null;
        if (sym) symbols.add(String(sym));
      }
    }
    const securities: Record<string, unknown> = {};
    if (symbols.size) {
      const { data: secs } = await db.from("securities_c").select("symbol, name, logo_url, last_price, change_percent").in("symbol", [...symbols]);
      for (const sec of secs ?? []) securities[sec.symbol as string] = sec;
    }
    return NextResponse.json({ ok: true, strategies: rows, securities });
  }

  return NextResponse.json({ ok: false, error: `Unknown action: ${action}` }, { status: 400 });
}

export async function POST() {
  return NextResponse.json({ ok: false, error: DEFER, deferred: true }, { status: 501 });
}
