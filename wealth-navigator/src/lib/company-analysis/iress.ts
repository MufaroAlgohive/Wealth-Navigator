/**
 * IRESS price overlay for the Analysis tab.
 *
 * We pay for IRESS, so JSE prices should come from IRESS, not Yahoo. The heavy
 * fundamentals stay Yahoo (IRESS fundamentals are not entitled on this profile),
 * but the live last / change is overlaid from the institutional
 * `quote_snapshot_c` (populated by the IRESS worker). This runs on every request
 * OUTSIDE the fundamentals cache, so the price stays current while statements,
 * estimates etc. are reused from cache.
 *
 * US / global symbols have no IRESS coverage on this profile, so they pass
 * through unchanged (Yahoo price). Best-effort: any failure leaves Yahoo's price.
 */

import { createServiceRoleClient, isSupabaseConfigured } from "@/lib/supabase/server";
import type { CompanyAnalysis } from "./yahoo";

const bareCode = (sym: string) => sym.replace(/\.(JO|JSE)$/i, "").toUpperCase();

function isJseSymbol(a: CompanyAnalysis): boolean {
  const s = a.symbol.toUpperCase();
  return s.endsWith(".JO") || s.endsWith(".JSE") || a.currency === "ZAR" || a.currency === "ZAc";
}

/**
 * Overlay the live IRESS last / change onto a (cached) Yahoo analysis for JSE
 * symbols. `quote_snapshot_c.last` / `prev_close` are integer cents, the same
 * scale as Yahoo's ZAc, so the conversion to major units is ÷100. Returns the
 * analysis unchanged when there is no IRESS row, no DB, or any error.
 */
export async function overlayIressPrice(analysis: CompanyAnalysis): Promise<CompanyAnalysis> {
  if (!analysis.ok || !isJseSymbol(analysis) || !isSupabaseConfigured()) return analysis;
  try {
    const sb = createServiceRoleClient();
    const { data, error } = await sb
      .from("quote_snapshot_c")
      .select("security_code,last,prev_close")
      .eq("security_code", bareCode(analysis.symbol))
      .limit(1)
      .maybeSingle();
    const lastCents = data?.last == null ? null : Number(data.last);
    if (error || !data || lastCents == null || !(lastCents > 0)) return analysis;

    const last = lastCents / 100;
    const prevCents = data.prev_close == null ? null : Number(data.prev_close);
    const prev = prevCents != null && prevCents > 0 ? prevCents / 100 : null;
    const change = prev != null ? last - prev : analysis.price.change;
    const changePct = prev != null ? ((last - prev) / prev) * 100 : analysis.price.changePct;

    return {
      ...analysis,
      price: { ...analysis.price, last, change, changePct, priceSource: "iress" },
    };
  } catch {
    return analysis;
  }
}
