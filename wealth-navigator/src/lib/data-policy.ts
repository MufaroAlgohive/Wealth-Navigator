/**
 * Real-data policy — when Supabase quotes mode is on, the UI must never
 * display seed/mock prices or synthetic KPIs. Empty/honest states only.
 */

import type { Quote } from "@/types/iress";

/** Server-side: `USE_SUPABASE_QUOTES=true` */
export function isUseSupabaseQuotesEnabled(): boolean {
  const raw = process.env.USE_SUPABASE_QUOTES;
  if (!raw) return false;
  return raw === "1" || raw.toLowerCase() === "true";
}

/** Client-side mirror of `NEXT_PUBLIC_USE_SUPABASE_QUOTES`. */
export function isRealDataOnlyClient(): boolean {
  if (typeof window === "undefined") {
    const raw = process.env.NEXT_PUBLIC_USE_SUPABASE_QUOTES;
    return raw === "1" || raw?.toLowerCase() === "true";
  }
  const raw = process.env.NEXT_PUBLIC_USE_SUPABASE_QUOTES;
  if (!raw) return false;
  return raw === "1" || raw.toLowerCase() === "true";
}

/** Zero quote — safe to render as "—" in NumberCell (ts === 0). */
export function emptyQuote(symbol: string, exchange = "JSE"): Quote {
  return {
    symbol,
    last: 0,
    bid: 0,
    ask: 0,
    bidSize: 0,
    askSize: 0,
    open: 0,
    high: 0,
    low: 0,
    close: 0,
    prevClose: 0,
    change: 0,
    changePct: 0,
    volume: 0,
    vwap: 0,
    currency: "ZAR",
    marketState: "CLOSED",
    ts: 0,
  };
}

export const FEED_NOT_CONFIGURED = "Data feed not configured";

/** Alias for production mandate checks in UI and API routes. */
export function isProductionRealDataMode(): boolean {
  return isRealDataOnlyClient();
}
