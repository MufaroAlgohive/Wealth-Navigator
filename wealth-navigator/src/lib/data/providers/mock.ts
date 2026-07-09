/**
 * `MockProvider` — deterministic in-process fixtures.
 *
 * Used as the dev default (`ACTIVE_MARKET_DATA_PROVIDER=mock`) and as the
 * fallback when the active provider is unconfigured. Reads from
 * `lib/iress/seed.ts` so the BFF responses and seed-driven UI line up
 * shape-for-shape.
 *
 * No network, no Supabase — never throws. `health()` is always `ok`.
 */

import { initialQuotes, seedLastFor } from "@/lib/iress/seed";
import type { Bar, MarketDataProvider, ProviderHealth, ProviderQuote } from "./types";

/** Generate a deterministic, plausible intraday bar series for any symbol. */
function syntheticIntraday(symbol: string, points = 60): Bar[] {
  const last = seedLastFor(symbol) || 100;
  const out: Bar[] = [];
  // Use a tiny deterministic walk so the shape is stable across calls.
  let px = last * 0.998;
  const now = Date.now();
  for (let i = points - 1; i >= 0; i--) {
    const wave = Math.sin((i / points) * Math.PI * 2) * 0.0035;
    const drift = ((points - i) / points) * 0.002;
    const open = px;
    const close = +(px * (1 + wave + drift)).toFixed(2);
    const high = +Math.max(open, close, px * 1.001).toFixed(2);
    const low = +Math.min(open, close, px * 0.999).toFixed(2);
    out.push({
      timestamp: new Date(now - i * 60_000).toISOString(),
      open: +open.toFixed(2),
      high,
      low,
      close,
      volume: Math.floor(8000 + ((i * 7919) % 24000)),
    });
    px = close;
  }
  return out;
}

const RANGE_DAYS: Record<"1D" | "5D" | "1M" | "3M" | "6M" | "1Y" | "5Y", number> = {
  "1D": 1,
  "5D": 5,
  "1M": 30,
  "3M": 90,
  "6M": 180,
  "1Y": 252,
  "5Y": 1260,
};

function syntheticHistory(symbol: string, range: "1D" | "5D" | "1M" | "3M" | "6M" | "1Y" | "5Y"): Bar[] {
  const days = RANGE_DAYS[range] ?? 252;
  const last = seedLastFor(symbol) || 100;
  const out: Bar[] = [];
  let px = last * 0.92;
  const now = Date.now();
  for (let i = days - 1; i >= 0; i--) {
    const wave = Math.sin((i / 30) * Math.PI) * 0.012;
    const drift = ((days - i) / days) * 0.08;
    const open = px;
    const close = +(px * (1 + wave + drift / days)).toFixed(2);
    const high = +Math.max(open, close, px * 1.008).toFixed(2);
    const low = +Math.min(open, close, px * 0.992).toFixed(2);
    out.push({
      timestamp: new Date(now - i * 86_400_000).toISOString(),
      open: +open.toFixed(2),
      high,
      low,
      close,
      volume: Math.floor(50_000 + ((i * 6151) % 250_000)),
    });
    px = close;
  }
  return out;
}

export class MockProvider implements MarketDataProvider {
  readonly name = "mock" as const;

  async fetchQuotes(symbols: string[]): Promise<ProviderQuote[]> {
    const all = initialQuotes();
    const ts = new Date().toISOString();
    return symbols.map((raw) => {
      const sym = raw.replace(/\.(JO|JSE)$/i, "").toUpperCase();
      const q = all[sym];
      if (q && q.last > 0) {
        return {
          symbol: sym,
          last: q.last,
          prevClose: q.prevClose || null,
          bid: q.bid ?? null,
          ask: q.ask ?? null,
          volume: q.volume ?? null,
          timestamp: new Date(typeof q.ts === "number" ? q.ts : Date.now()).toISOString(),
          source: "mock" as const,
        };
      }
      // Synthesize something for unknown codes so callers always get a row.
      const seed = seedLastFor(sym);
      return {
        symbol: sym,
        last: seed,
        prevClose: +(seed * 0.999).toFixed(2),
        bid: +(seed * 0.9995).toFixed(2),
        ask: +(seed * 1.0005).toFixed(2),
        volume: 0,
        timestamp: ts,
        source: "mock" as const,
      };
    });
  }

  async fetchIntraday(symbol: string): Promise<Bar[]> {
    return syntheticIntraday(symbol);
  }

  async fetchHistory(symbol: string, range: "1D" | "5D" | "1M" | "3M" | "6M" | "1Y" | "5Y"): Promise<Bar[]> {
    return syntheticHistory(symbol, range);
  }

  async fetchSnapshot(symbol: string): Promise<ProviderQuote | null> {
    const [q] = await this.fetchQuotes([symbol]);
    return q ?? null;
  }

  async health(): Promise<ProviderHealth> {
    return { status: "ok", lastChecked: new Date().toISOString() };
  }
}
