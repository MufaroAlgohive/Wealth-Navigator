/**
 * GET /api/research/identify/[sym]
 *
 * Identify-step lookup for the Research note wizard. Returns the best
 * available master-data for a ticker so sector / ISIN / company name can
 * auto-fill (still editable in the form), plus the retail strategies that
 * currently hold the name (read-only linked-strategies chip).
 *
 * Sources:
 *   - securities_c (retail) — name, sector, industry, isin
 *   - strategies_c.holdings (retail) — which model portfolios include the ticker
 *
 * Honest empty: missing fields come back null; linkedStrategies is [] when
 * no strategy holds the name. Never fabricates ISINs or sectors.
 */
import { createRetailServiceRoleClient, isRetailSupabaseConfigured } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function bareCode(sym: string): string {
  return sym.replace(/\.(JO|JSE)$/i, "").toUpperCase();
}

function holdingSymbol(holding: unknown): string {
  if (typeof holding === "string") return bareCode(holding);
  if (!holding || typeof holding !== "object") return "";
  const row = holding as Record<string, unknown>;
  return bareCode(String(row.ticker ?? row.symbol ?? ""));
}

export async function GET(_req: Request, { params }: { params: Promise<{ sym: string }> }) {
  const { sym: raw } = await params;
  const code = bareCode(raw ?? "");
  if (!code) {
    return Response.json({ ok: false, error: "sym path param required" }, { status: 400 });
  }

  if (!isRetailSupabaseConfigured()) {
    return Response.json({
      ok: true,
      symbol: code,
      name: null,
      sector: null,
      industry: null,
      isin: null,
      linkedStrategies: [] as string[],
      source: "unavailable",
      reason: "supabase_not_configured",
    });
  }

  const sb = createRetailServiceRoleClient();

  const [secRes, stratRes] = await Promise.all([
    sb
      .from("securities_c")
      .select("symbol,name,sector,industry,isin")
      .in("symbol", [code, `${code}.JO`])
      .limit(1),
    sb.from("strategies_c").select("id,name,short_name,holdings,status").limit(500),
  ]);

  if (secRes.error) {
    return Response.json(
      { ok: false, symbol: code, error: secRes.error.message },
      { status: 500 },
    );
  }

  const sec = (secRes.data ?? [])[0] as
    | {
        symbol: string;
        name: string | null;
        sector: string | null;
        industry: string | null;
        isin: string | null;
      }
    | undefined;

  const linkedStrategies: string[] = [];
  if (!stratRes.error && Array.isArray(stratRes.data)) {
    for (const row of stratRes.data as Array<{
      name: string | null;
      short_name: string | null;
      holdings: unknown;
      status: string | null;
    }>) {
      if (!Array.isArray(row.holdings)) continue;
      const hit = row.holdings.some((h) => holdingSymbol(h) === code);
      if (!hit) continue;
      const label = (row.short_name || row.name || "").trim();
      if (label && !linkedStrategies.includes(label)) linkedStrategies.push(label);
    }
  }

  return Response.json({
    ok: true,
    symbol: code,
    name: sec?.name ?? null,
    sector: sec?.sector ?? null,
    industry: sec?.industry ?? null,
    isin: sec?.isin ?? null,
    linkedStrategies,
    source: sec ? "supabase" : "unavailable",
    reason: sec ? undefined : "no_security",
  });
}
