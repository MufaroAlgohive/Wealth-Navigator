import { NextResponse } from "next/server";

import { getAdminContext, isAdminRole } from "@/lib/admin/rbac";
import { createRetailServiceRoleClient } from "@/lib/supabase/server";

/**
 * THIN Yahoo bridge — the only remaining Yahoo use after the Iress cutover.
 * Iress (worker retail-ingest) owns last_price + change_percent; this keeps the
 * fields Iress can't supply yet fresh: market_cap, pe_ratio, dividend_per_share,
 * dividend_yield, ytd_performance. Delete once Charles enables the Iress
 * fundamentals + TimeSeriesGet2 entitlements (see docs/PHASE1_IRESS_RETAIL_CUTOVER.md).
 *
 * Auth: Vercel cron `Authorization: Bearer ${CRON_SECRET}`, OR an admin session.
 * Write gate: DEFAULT SHADOW — set `YAHOO_FUNDAMENTALS_WRITE=1` to write live to
 * the RETAIL securities_c. NEVER writes last_price/change_percent (Iress owns those).
 *
 * Suggested schedule (vercel.json): daily, e.g. "0 5 * * *".
 */

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const GAP_FIELDS = ["market_cap", "pe_ratio", "dividend_per_share", "dividend_yield", "ytd_performance"] as const;

async function authorized(req: Request): Promise<boolean> {
  const secret = process.env.CRON_SECRET;
  const bearer = req.headers.get("authorization")?.replace("Bearer ", "");
  if (secret && bearer === secret) return true;
  const auth = await getAdminContext();
  return auth.status === "ok" && isAdminRole(auth.ctx);
}

async function yahooCrumb(): Promise<{ cookie: string; crumb: string } | null> {
  try {
    const c = await fetch("https://fc.yahoo.com/", { headers: { "User-Agent": "Mozilla/5.0" } });
    const cookie = c.headers.get("set-cookie")?.split(";")[0] ?? "";
    const cr = await fetch("https://query1.finance.yahoo.com/v1/test/getcrumb", {
      headers: { "User-Agent": "Mozilla/5.0", cookie, Accept: "text/plain" },
    });
    const crumb = (await cr.text()).trim();
    if (!crumb || crumb.includes("<")) return null;
    return { cookie, crumb };
  } catch {
    return null;
  }
}

interface YahooModule { raw?: number }
interface YahooResult {
  price?: { marketCap?: YahooModule };
  summaryDetail?: { trailingPE?: YahooModule; dividendRate?: YahooModule; dividendYield?: YahooModule };
  defaultKeyStatistics?: { trailingPE?: YahooModule; ytdReturn?: YahooModule; "52WeekChange"?: YahooModule };
}

export async function GET(req: Request) {
  if (!(await authorized(req))) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });

  const writesOn = process.env.YAHOO_FUNDAMENTALS_WRITE === "1";
  let db;
  try {
    db = createRetailServiceRoleClient();
  } catch {
    return NextResponse.json({ ok: false, error: "RETAIL database not configured" }, { status: 503 });
  }

  const { data: securities, error } = await db.from("securities_c").select("id, symbol").eq("is_active", true).limit(500);
  if (error) return NextResponse.json({ ok: false, error: error.message });

  const session = await yahooCrumb();
  if (!session) return NextResponse.json({ ok: false, error: "Could not establish a Yahoo session (cookie/crumb)" }, { status: 502 });

  let updated = 0, failed = 0, covered = 0;
  const sample: Array<Record<string, unknown>> = [];

  for (const sec of securities ?? []) {
    const sym = String(sec.symbol || "").trim();
    if (!sym) continue;
    try {
      const r = await fetch(
        `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(sym)}?modules=price,summaryDetail,defaultKeyStatistics&crumb=${encodeURIComponent(session.crumb)}`,
        { headers: { "User-Agent": "Mozilla/5.0", cookie: session.cookie, Accept: "application/json" } },
      );
      if (!r.ok) { failed++; continue; }
      const j = (await r.json()) as { quoteSummary?: { result?: YahooResult[] } };
      const res = j?.quoteSummary?.result?.[0];
      if (!res) { failed++; continue; }

      const update: Record<string, number> = {};
      const mc = res.price?.marketCap?.raw;
      if (mc != null) update.market_cap = Math.round(mc);
      const pe = res.summaryDetail?.trailingPE?.raw ?? res.defaultKeyStatistics?.trailingPE?.raw;
      if (pe != null) update.pe_ratio = pe;
      const dr = res.summaryDetail?.dividendRate?.raw;
      if (dr != null) update.dividend_per_share = dr;
      const dy = res.summaryDetail?.dividendYield?.raw;
      if (dy != null) update.dividend_yield = dy * 100;
      const ytd = res.defaultKeyStatistics?.ytdReturn?.raw ?? res.defaultKeyStatistics?.["52WeekChange"]?.raw;
      if (ytd != null) update.ytd_performance = ytd * 100;

      if (Object.keys(update).length === 0) { continue; }
      covered++;
      if (sample.length < 8) sample.push({ symbol: sym, ...update });

      if (writesOn) {
        const { error: upErr } = await db.from("securities_c").update(update).eq("id", sec.id);
        if (upErr) { failed++; continue; }
        updated++;
      }
    } catch {
      failed++;
    }
    await new Promise((r) => setTimeout(r, 150));
  }

  return NextResponse.json({
    ok: true,
    mode: writesOn ? "write" : "shadow",
    fields: GAP_FIELDS,
    requested: securities?.length ?? 0,
    covered,
    updated,
    failed,
    sample,
    note: writesOn ? undefined : "Shadow run — set YAHOO_FUNDAMENTALS_WRITE=1 to write gap fields to securities_c.",
  });
}
