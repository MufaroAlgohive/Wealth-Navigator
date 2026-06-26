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
import { iressPriceOverlayEnabled, iressQuoteMaxAgeMs, IRESS_DIVERGENCE } from "@/lib/iress/overlay-policy";
import type { CompanyAnalysis, CompanyDeep } from "./yahoo";

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
  if (!analysis.ok || !isJseSymbol(analysis) || !isSupabaseConfigured() || !iressPriceOverlayEnabled())
    return analysis;
  try {
    const sb = createServiceRoleClient();
    const { data, error } = await sb
      .from("quote_snapshot_c")
      .select("security_code,last,prev_close,as_of,updated_at")
      .eq("security_code", bareCode(analysis.symbol))
      .limit(1)
      .maybeSingle();
    const lastCents = data?.last == null ? null : Number(data.last);
    if (error || !data || lastCents == null || !(lastCents > 0)) return analysis;

    // Freshness gate: a STALE IRESS snapshot must NOT override the live price.
    // The CT/test feed can hold values days (or years) old — e.g. a 2023 close
    // would show as today's price. When the snapshot is stale, keep the current
    // price (Yahoo) rather than ship a wrong IRESS number.
    const tsRaw = (data.as_of ?? data.updated_at) as string | null;
    const ts = tsRaw ? Date.parse(tsRaw) : NaN;
    if (!Number.isFinite(ts) || Date.now() - ts > iressQuoteMaxAgeMs()) return analysis;

    const last = lastCents / 100;
    // Sanity: if the IRESS snapshot diverges materially from the live market
    // (the Yahoo price already on `analysis`), it is almost certainly a stale or
    // test CT value (e.g. a 2023 close) -> keep the market price, not a wrong one.
    const yLast = analysis.price.last;
    if (yLast != null && yLast > 0 && Math.abs(last - yLast) / yLast > IRESS_DIVERGENCE) return analysis;
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

/**
 * Overlay the live IRESS last onto the DEEP payload's research.currentPrice for
 * JSE symbols, so the Research / Ownership / DCF tabs use the same live price as
 * the Overview header (not a separate Yahoo value). Same freshness gate: a stale
 * snapshot is ignored, keeping the Yahoo currentPrice. Best-effort.
 */
export async function overlayIressDeep(deep: CompanyDeep): Promise<CompanyDeep> {
  const s = deep.symbol.toUpperCase();
  const isJse = s.endsWith(".JO") || s.endsWith(".JSE") || deep.currency === "ZAR" || deep.currency === "ZAc";
  if (!deep.ok || !isJse || !isSupabaseConfigured() || !iressPriceOverlayEnabled()) return deep;
  try {
    const sb = createServiceRoleClient();
    const { data, error } = await sb
      .from("quote_snapshot_c")
      .select("last,as_of,updated_at")
      .eq("security_code", bareCode(deep.symbol))
      .limit(1)
      .maybeSingle();
    const lastCents = data?.last == null ? null : Number(data.last);
    if (error || !data || lastCents == null || !(lastCents > 0)) return deep;
    const tsRaw = (data.as_of ?? data.updated_at) as string | null;
    const ts = tsRaw ? Date.parse(tsRaw) : NaN;
    if (!Number.isFinite(ts) || Date.now() - ts > iressQuoteMaxAgeMs()) return deep;
    const lastR = lastCents / 100;
    const yLast = deep.research.currentPrice;
    if (yLast != null && yLast > 0 && Math.abs(lastR - yLast) / yLast > IRESS_DIVERGENCE) return deep;
    return { ...deep, research: { ...deep.research, currentPrice: lastR } };
  } catch {
    return deep;
  }
}
