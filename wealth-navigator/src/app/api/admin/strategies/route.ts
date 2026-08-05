import { NextResponse } from "next/server";

import { getAdminContext } from "@/lib/admin/rbac";
import { isAdminRole } from "@/lib/admin/pages";
import { createAnonServerClient, createRetailServiceRoleClient } from "@/lib/supabase/server";

/**
 * Strategy catalogue. Legacy `strategies.html` talked to Supabase directly.
 * READS ported: list strategies (+ a securities price map for holdings) and
 * security search and password-confirmed catalogue mutations.
 */

export const dynamic = "force-dynamic";

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

export async function POST(req: Request) {
  const auth = await getAdminContext();
  if (auth.status === "no-session") return NextResponse.json({ ok: false, error: "no-session" }, { status: 401 });
  if (auth.status !== "ok" || !isAdminRole(auth.ctx)) return NextResponse.json({ ok: false, error: "Admin access required" }, { status: 403 });
  const body = ((await req.json().catch(() => ({}))) ?? {}) as { action?: string; id?: string; password?: string; patch?: Record<string, unknown> };
  const action = String(body.action || "");
  const password = String(body.password || "");
  if (!password) return NextResponse.json({ ok: false, error: "Password is required" }, { status: 400 });

  // Both client constructors throw synchronously when their env vars aren't
  // configured on this deployment — previously that meant an unhandled
  // exception here became a raw HTML 500, which the browser's response.json()
  // can't parse, so the save silently did nothing with no visible error.
  let verifier, db;
  try {
    verifier = createAnonServerClient();
    db = createRetailServiceRoleClient();
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: `Strategy save is not configured on this deployment: ${(e as Error).message}` },
      { status: 503 },
    );
  }

  try {
    const { error: passwordError } = await verifier.auth.signInWithPassword({ email: auth.ctx.email, password });
    if (passwordError) return NextResponse.json({ ok: false, error: "Incorrect password" }, { status: 403 });
  } catch (e) {
    return NextResponse.json({ ok: false, error: `Password verification failed: ${(e as Error).message}` }, { status: 502 });
  }

  if (action === "details") {
    const { data, error } = await db.from("strategies_c").select("*").eq("id", body.id || "").maybeSingle();
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, strategy: data });
  }
  if (action === "delete") {
    const { error } = await db.from("strategies_c").delete().eq("id", body.id || "");
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  }
  if (action === "create" || action === "update" || action === "rename") {
    const allowed = new Set(["name","short_name","description","objective","risk_level","sector","base_currency","is_public","is_featured","investor_environment","status","holdings","min_investment"]);
    const patch = Object.fromEntries(Object.entries(body.patch ?? {}).filter(([key]) => allowed.has(key)));
    if (action === "rename" && (!patch.name || !String(patch.name).trim())) return NextResponse.json({ ok: false, error: "Strategy name is required" }, { status: 400 });
    if (action !== "rename" && patch.investor_environment && !["LIVE","UAT"].includes(String(patch.investor_environment).toUpperCase())) return NextResponse.json({ ok: false, error: "Invalid investor environment" }, { status: 400 });
    const query = action === "create"
      ? db.from("strategies_c").insert(patch).select().maybeSingle()
      : db.from("strategies_c").update(patch).eq("id", body.id || "").select().maybeSingle();
    const { data, error } = await query;
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, strategy: data });
  }
  return NextResponse.json({ ok: false, error: `Unknown action: ${action}` }, { status: 400 });
}
