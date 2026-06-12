"use client";

import { useEffect } from "react";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { isSupabaseAuthConfigured } from "@/lib/supabase/config";
import { seedTicksFromQuotes } from "@/lib/store/tick-stream-provider";

interface SecurityRow {
  id: string;
  symbol: string;
}

/**
 * Push worker INSERTs on `stock_intraday_c` into the tick store (~1 s latency).
 * Complements the 15 s BFF poll in `useLiveQuotes`.
 */
export function useSupabaseQuoteRealtime(symbols: string[], enabled = true) {
  const symKey = symbols.join(",");

  useEffect(() => {
    if (!enabled || symbols.length === 0 || !isSupabaseAuthConfigured()) return;

    let cancelled = false;
    const supabase = createSupabaseBrowserClient();
    const idToSymbol = new Map<string, string>();

    async function loadSecurityMap() {
      const normalised = Array.from(new Set(symbols.map((s) => s.trim().toUpperCase())));
      const { data, error } = await supabase
        .from("securities_c")
        .select("id, symbol")
        .in("symbol", normalised);
      if (error || cancelled) return;
      for (const row of (data ?? []) as SecurityRow[]) {
        idToSymbol.set(row.id, row.symbol);
      }
    }

    const channel = supabase.channel(`intraday-${symKey}-${Date.now()}`);

    void loadSecurityMap().then(() => {
      if (cancelled) return;
      channel.on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "stock_intraday_c" },
        (payload) => {
          const row = payload.new as { security_id: string; current_price: number };
          const sym = idToSymbol.get(row.security_id);
          if (!sym) return;
          const last = Number(row.current_price) / 100;
          if (last <= 0) return;
          seedTicksFromQuotes([{ sym, last }], "supabase");
        },
      );
      channel.subscribe();
    });

    return () => {
      cancelled = true;
      void supabase.removeChannel(channel);
    };
  }, [enabled, symKey, symbols]);
}
