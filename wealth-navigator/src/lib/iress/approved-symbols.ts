import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * The set of symbols that may be sourced from IRESS(PROD) instead of Yahoo.
 *
 * A symbol qualifies ONLY when BOTH gates are true in iress_price_validation_c:
 *  - `validated`: the backend (Railway worker + scoreboard) has seen IRESS track
 *    Yahoo within tolerance for a stable streak — i.e. IRESS is accurate & current.
 *  - `approved`:  a human has signed off the cutover for that symbol.
 *
 * This is the ONE gate that both the Yahoo cron (skip these) and the worker
 * (write these) consult, so a symbol is never written by both.
 *
 * FAIL-CLOSED: any error / missing table / null client returns an EMPTY set, so
 * a lookup failure keeps the entire universe on Yahoo and NEVER overwrites Yahoo
 * blindly. Returns BARE upper-case JSE codes (e.g. "AGL").
 */
export async function loadApprovedIressSymbols(
  client: SupabaseClient | null | undefined,
): Promise<Set<string>> {
  if (!client) return new Set();
  try {
    const { data, error } = await client
      .from("iress_price_validation_c")
      .select("symbol")
      .eq("approved", true)
      .eq("validated", true);
    if (error || !data) return new Set();
    return new Set(
      data.map((r) =>
        String((r as { symbol: string }).symbol ?? "")
          .trim()
          .toUpperCase()
          .replace(/\.(JO|JSE)$/i, ""),
      ).filter(Boolean),
    );
  } catch {
    return new Set();
  }
}
