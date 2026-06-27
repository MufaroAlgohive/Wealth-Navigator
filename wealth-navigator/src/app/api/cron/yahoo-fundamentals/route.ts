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
 * Write gate: DEFAULT SHADOW. Set `YAHOO_FUNDAMENTALS_WRITE=1` to write live to
 * the RETAIL securities_c. In production, IRESS owns last_price/change_percent and
 * this leaves them untouched. During UAT (`IRESS_PRICE_OVERLAY=0`) IRESS quotes are
 * test data, so this ALSO refreshes last_price/change_percent from Yahoo to keep
 * the live board/ticker accurate.
 *
 * Suggested schedule (vercel.json): daily, e.g. "0 5 * * *".
 */

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const GAP_FIELDS = ["market_cap", "pe_ratio", "dividend_per_share", "dividend_yield", "ytd_performance"] as const;

/**
 * securities_c stores bare JSE codes (NPN, CPI, SOL). Yahoo's quoteSummary needs
 * the `.JO` suffix for the Johannesburg listing; without it a bare code can
 * resolve to a same-named foreign ticker (e.g. `CPI` is a US ETF in USD, not
 * Capitec on the JSE) and we would write a wrong-currency price as ZAc. Always
 * query the explicit JSE symbol.
 */
function toYahooJseSymbol(sym: string): string {
  return `${sym.replace(/\.(JO|JSE)$/i, "").toUpperCase()}.JO`;
}

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
  price?: {
    marketCap?: YahooModule;
    regularMarketPrice?: YahooModule;
    regularMarketChangePercent?: YahooModule;
    currency?: string;
  };
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

  let updated = 0, failed = 0, covered = 0, ticks = 0;
  const sample: Array<Record<string, unknown>> = [];
  // One timestamp per run: each cycle writes a fresh stock_intraday_c tick per
  // security so the LATEST tick (what retail consumers like MINT-LIVE read as
  // the fill price) is always the current Yahoo price, superseding any stale
  // IRESS UAT test tick left in the table.
  const tickTs = new Date().toISOString();

  for (const sec of securities ?? []) {
    const sym = String(sec.symbol || "").trim();
    if (!sym) continue;
    const ySym = toYahooJseSymbol(sym);
    try {
      const r = await fetch(
        `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(ySym)}?modules=price,summaryDetail,defaultKeyStatistics&crumb=${encodeURIComponent(session.crumb)}`,
        { headers: { "User-Agent": "Mozilla/5.0", cookie: session.cookie, Accept: "application/json" } },
      );
      if (!r.ok) { failed++; continue; }
      const j = (await r.json()) as { quoteSummary?: { result?: YahooResult[] } };
      const res = j?.quoteSummary?.result?.[0];
      if (!res) { failed++; continue; }
      // Reject a same-named non-JSE listing: only the Johannesburg quote is in
      // ZAc. If Yahoo reports a currency and it is not ZAc, this resolved to the
      // wrong entity (a US/global collision), so skip rather than write garbage.
      const cur = res.price?.currency;
      if (cur && cur !== "ZAc") { failed++; continue; }

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

      // UAT phase (IRESS_PRICE_OVERLAY=0): IRESS quotes are test data, so Yahoo
      // owns last_price + change_percent too, keeping the live board/ticker
      // accurate. JSE Yahoo quotes are in ZAc (cents) and securities_c.last_price
      // is cents, so regularMarketPrice is stored directly. In production the
      // IRESS worker owns these fields, so we leave them untouched there.
      let tickRow:
        | { security_id: string; symbol: string; current_price: number; "1d_pct": number | null; "1d_abs": number | null; timestamp: string }
        | null = null;
      if (process.env.IRESS_PRICE_OVERLAY === "0") {
        const px = res.price?.regularMarketPrice?.raw;
        const chg = res.price?.regularMarketChangePercent?.raw;
        if (px != null && px > 0) {
          const pxCents = Math.round(px);
          update.last_price = pxCents;
          let pct: number | null = null;
          let abs: number | null = null;
          if (chg != null) {
            pct = Math.round(chg * 10000) / 100;
            update.change_percent = pct;
            const prevCents = chg !== -100 ? Math.round(pxCents / (1 + chg / 100)) : pxCents;
            abs = pxCents - prevCents;
          }
          // Fresh Yahoo intraday tick for the retail table (see tickTs above).
          tickRow = { security_id: String(sec.id), symbol: sym, current_price: pxCents, "1d_pct": pct, "1d_abs": abs, timestamp: tickTs };
        }
      }

      if (Object.keys(update).length === 0) { continue; }
      covered++;
      if (sample.length < 8) sample.push({ symbol: sym, ...update });

      if (writesOn) {
        const { error: upErr } = await db.from("securities_c").update(update).eq("id", sec.id);
        if (upErr) { failed++; continue; }
        updated++;
        if (tickRow) {
          const { error: tickErr } = await db
            .from("stock_intraday_c")
            .upsert(tickRow, { onConflict: "symbol,timestamp" });
          if (tickErr) console.warn(`[yahoo-fundamentals] stock_intraday_c upsert(${sym}) failed: ${tickErr.message}`);
          else ticks++;
        }
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
    ticks,
    failed,
    sample,
    note: writesOn ? undefined : "Shadow run — set YAHOO_FUNDAMENTALS_WRITE=1 to write gap fields to securities_c.",
  });
}
