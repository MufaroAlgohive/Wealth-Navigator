"use client";

import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { seedTicksFromQuotes } from "@/lib/store/tick-stream-provider";
import { iressConfig } from "@/lib/iress";

interface LiveQuoteRow {
  symbol: string;
  source: "live" | "seed-fallback" | "mock";
  quote: { last: number; bid: number; ask: number; change: number; changePct: number; volume: number; vwap: number };
}

interface QuotesResponse {
  mode: string;
  quotes: LiveQuoteRow[];
  liveCount: number;
  fallbackCount: number;
}

/** Fetch live quotes from the server API and seed the tick store. */
export function useLiveQuotes(symbols: string[], enabled = true) {
  const symKey = symbols.join(",");
  const isLive = iressConfig.mode === "live" || iressConfig.mode === "wsdl-stub";

  const q = useQuery({
    queryKey: ["live-quotes", symKey],
    queryFn: async (): Promise<QuotesResponse> => {
      const res = await fetch(`/api/iress/quotes?symbols=${encodeURIComponent(symKey)}`);
      if (!res.ok) throw new Error(`quotes ${res.status}`);
      return res.json();
    },
    enabled: enabled && isLive && symbols.length > 0,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });

  useEffect(() => {
    if (!q.data?.quotes) return;
    seedTicksFromQuotes(
      q.data.quotes.map((r) => ({
        sym: r.symbol,
        last: r.quote.last,
        bid: r.quote.bid,
        ask: r.quote.ask,
        change: r.quote.change,
        changePct: r.quote.changePct,
        volume: r.quote.volume,
        vwap: r.quote.vwap,
      })),
    );
  }, [q.data]);

  const hasLive = (q.data?.liveCount ?? 0) > 0;
  const hasFallback = (q.data?.fallbackCount ?? 0) > 0;
  const dataSource = !isLive ? "mock" as const : hasLive && !hasFallback ? "live" as const : hasLive && hasFallback ? "hybrid" as const : hasFallback ? "seed" as const : "mock" as const;

  return { ...q, dataSource, isLive };
}
