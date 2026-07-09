/**
 * `IressProvider` — wraps the existing IRESS read paths into the shared
 * `MarketDataProvider` shape.
 *
 * Where the data lives:
 * - Quotes: `fetchQuotesSafe` in `lib/iress/live-queries.ts` (DB-first when
 *   `USE_SUPABASE_QUOTES=true`, otherwise live SOAP via the worker; seed
 *   fallback on failure).
 * - Intraday ticks: the Railway worker is the only path; the BFF reads
 *   `stock_intraday_c` directly today. We delegate to the existing worker
 *   HTTP client when the BFF chooses the non-DB path.
 * - History: the worker's `/history` endpoint, which proxies
 *   TimeSeriesGet2. Falls back to empty when the worker is unconfigured
 *   or fails (the BFF surfaces `source: "unavailable"`).
 *
 * Health reflects the worker / IRESS config (mode + worker URL). Never
 * throws.
 */

import { isIressWorkerConfigured } from "@/lib/data-policy";
import { iressConfig } from "@/lib/iress";
import { type QuoteWithSource, fetchQuote, fetchQuotesSafe } from "@/lib/iress/live-queries";
import { callWorker } from "@/lib/iress/worker-api";
import type { Bar, MarketDataProvider, ProviderHealth, ProviderQuote } from "./types";

const SOURCE_MAP: Record<QuoteWithSource["source"], ProviderQuote["source"]> = {
  live: "iress",
  "seed-fallback": "mock",
  mock: "mock",
  supabase: "supabase",
  unavailable: "iress",
};

function toProviderQuote(row: QuoteWithSource): ProviderQuote {
  return {
    symbol: row.symbol,
    last: row.quote.last > 0 ? row.quote.last : null,
    prevClose: row.quote.prevClose > 0 ? row.quote.prevClose : null,
    bid: row.quote.bid > 0 ? row.quote.bid : null,
    ask: row.quote.ask > 0 ? row.quote.ask : null,
    volume: row.quote.volume > 0 ? row.quote.volume : null,
    timestamp: new Date(row.quote.ts > 0 ? row.quote.ts : Date.now()).toISOString(),
    source: SOURCE_MAP[row.source] ?? "iress",
    ...(row.source === "unavailable" ? { error: "unavailable" } : {}),
  };
}

const RANGE_DAYS: Record<"1D" | "5D" | "1M" | "3M" | "6M" | "1Y" | "5Y", number> = {
  "1D": 1,
  "5D": 8,
  "1M": 33,
  "3M": 95,
  "6M": 190,
  "1Y": 370,
  "5Y": 1830,
};

export class IressProvider implements MarketDataProvider {
  readonly name = "iress" as const;

  async fetchQuotes(symbols: string[]): Promise<ProviderQuote[]> {
    if (symbols.length === 0) return [];
    const rows = await fetchQuotesSafe(symbols, "JSE");
    return rows.map(toProviderQuote);
  }

  async fetchIntraday(symbol: string): Promise<Bar[]> {
    if (!isIressWorkerConfigured()) return [];
    const code = symbol.replace(/\.(JO|JSE)$/i, "").toUpperCase();
    // Worker exposes `/intraday?sym=…&limit=…` mirroring the BFF; reuse the
    // same 90-row default so the chart line and the live panel line up.
    const res = await callWorker<{ ok: boolean; points?: Array<{ t: number; v: number }> }>({
      path: `/intraday?sym=${encodeURIComponent(code)}&limit=90`,
      timeoutMs: 15_000,
    });
    if (!res.ok || !res.body?.ok || !Array.isArray(res.body.points)) return [];
    return res.body.points
      .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.v))
      .sort((a, b) => a.t - b.t)
      .map((p) => ({
        timestamp: new Date(p.t).toISOString(),
        // Yahoo/IRESS daily `v` is the close in native currency. Intraday
        // workers may send Rands or cents depending on the upstream; we
        // trust the worker here.
        open: p.v,
        high: p.v,
        low: p.v,
        close: p.v,
        volume: 0,
      }));
  }

  async fetchHistory(symbol: string, range: "1D" | "5D" | "1M" | "3M" | "6M" | "1Y" | "5Y"): Promise<Bar[]> {
    if (!isIressWorkerConfigured()) return [];
    const code = symbol.replace(/\.(JO|JSE)$/i, "").toUpperCase();
    const days = RANGE_DAYS[range] ?? 370;
    const res = await callWorker<{ ok: boolean; points?: Array<{ t: number; v: number }> }>({
      path: `/history?sym=${encodeURIComponent(code)}&days=${days}&exchange=JSE`,
      timeoutMs: 30_000,
    });
    if (!res.ok || !res.body?.ok || !Array.isArray(res.body.points)) return [];
    return res.body.points
      .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.v) && p.v > 0)
      .sort((a, b) => a.t - b.t)
      .map((p) => ({
        timestamp: new Date(p.t).toISOString(),
        open: p.v,
        high: p.v,
        low: p.v,
        close: p.v,
        volume: 0,
      }));
  }

  async fetchSnapshot(symbol: string): Promise<ProviderQuote | null> {
    const row = await fetchQuote(symbol.replace(/\.(JO|JSE)$/i, "").toUpperCase(), "JSE");
    if (!row) return null;
    if (row.source === "unavailable") return null;
    return toProviderQuote(row);
  }

  async health(): Promise<ProviderHealth> {
    const lastChecked = new Date().toISOString();
    if (iressConfig.mode === "live" || iressConfig.mode === "wsdl-stub") {
      return {
        status: isIressWorkerConfigured() ? "ok" : "degraded",
        message: isIressWorkerConfigured()
          ? `IRESS ${iressConfig.mode} (worker attached)`
          : `IRESS ${iressConfig.mode} but worker URL not configured`,
        lastChecked,
      };
    }
    return {
      status: "ok",
      message: `IRESS mock (${iressConfig.mode})`,
      lastChecked,
    };
  }
}
