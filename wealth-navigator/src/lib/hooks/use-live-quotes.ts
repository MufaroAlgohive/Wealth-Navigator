"use client";

import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { seedTicksFromQuotes } from "@/lib/store/tick-stream-provider";
import { iressConfig } from "@/lib/iress";
import {
  deriveDataSource,
  isUseSupabaseQuotesClientEnabled,
  normaliseBffQuotes,
  normaliseIressQuotes,
  QUOTE_POLL_INTERVAL_MS,
  resolveQuoteApiMode,
  type BffQuotesResponse,
  type IressQuotesResponse,
} from "@/lib/hooks/quote-routing";
import { useSupabaseQuoteRealtime } from "@/lib/hooks/use-supabase-quote-realtime";
import type { DataSourceKind } from "@/components/oems/primitives/data-source-badge";

interface QuotesFetchResult {
  mode: string;
  useSupabase?: boolean;
  rows: ReturnType<typeof normaliseBffQuotes>;
  liveCount: number;
  fallbackCount: number;
  mockCount: number;
  supabaseCount: number;
}

async function fetchQuotes(symKey: string, apiMode: "supabase" | "iress"): Promise<QuotesFetchResult> {
  const path =
    apiMode === "supabase"
      ? `/api/quotes?symbols=${encodeURIComponent(symKey)}`
      : `/api/iress/quotes?symbols=${encodeURIComponent(symKey)}`;
  const res = await fetch(path);
  if (!res.ok) throw new Error(`quotes ${res.status}`);
  const data = await res.json();

  if (apiMode === "supabase") {
    const bff = data as BffQuotesResponse;
    return {
      mode: bff.mode,
      useSupabase: bff.useSupabase,
      rows: normaliseBffQuotes(bff),
      liveCount: bff.liveCount,
      fallbackCount: bff.fallbackCount,
      mockCount: bff.mockCount ?? 0,
      supabaseCount: bff.supabaseCount ?? 0,
    };
  }

  const iress = data as IressQuotesResponse;
  return {
    mode: iress.mode,
    rows: normaliseIressQuotes(iress),
    liveCount: iress.liveCount,
    fallbackCount: iress.fallbackCount,
    mockCount: 0,
    supabaseCount: 0,
  };
}

/** Fetch quotes from the BFF and seed the tick store for watchlist symbols. */
export function useLiveQuotes(symbols: string[], enabled = true) {
  const symKey = symbols.join(",");
  const useSupabaseFlag = isUseSupabaseQuotesClientEnabled();
  const apiMode = resolveQuoteApiMode({ useSupabaseFlag, iressMode: iressConfig.mode });
  const fetchEnabled = enabled && symbols.length > 0;

  const q = useQuery({
    queryKey: ["live-quotes", apiMode, symKey],
    queryFn: () => fetchQuotes(symKey, apiMode),
    enabled: fetchEnabled,
    staleTime: QUOTE_POLL_INTERVAL_MS,
    refetchInterval: QUOTE_POLL_INTERVAL_MS,
  });

  const supabaseActive = useSupabaseFlag || q.data?.useSupabase === true || q.data?.mode === "supabase";
  useSupabaseQuoteRealtime(symbols, fetchEnabled && supabaseActive);

  useEffect(() => {
    if (!q.data?.rows.length) return;
    seedTicksFromQuotes(
      q.data.rows.map((r) => ({
        sym: r.sym,
        last: r.last,
        prev: r.prev,
        bid: r.bid,
        ask: r.ask,
        change: r.change,
        changePct: r.changePct,
        volume: r.volume,
        vwap: r.vwap,
      })),
      apiMode === "supabase" ? "supabase" : "stream",
    );
  }, [q.data, apiMode]);

  const dataSource: DataSourceKind = q.data
    ? deriveDataSource(q.data.rows, {
        liveCount: q.data.liveCount,
        fallbackCount: q.data.fallbackCount,
        mockCount: q.data.mockCount,
        supabaseCount: q.data.supabaseCount,
      })
    : useSupabaseFlag
      ? "supabase"
      : apiMode === "iress"
        ? "live"
        : "mock";

  return {
    ...q,
    dataSource,
    apiMode,
    isLive: apiMode === "iress" || dataSource === "supabase" || dataSource === "live",
  };
}
