"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";

export function QueryProvider({ children }: { children: React.ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // Default mirrors `queryOpts("reference")` so any un-tagged
            // call site keeps the old 60s cached behaviour.
            staleTime: 60_000,
            refetchOnWindowFocus: false,
            retry: 1,
          },
        },
      }),
  );
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

/**
 * Two stale-time regimes the rest of the app picks between:
 *
 * - `"live"` — short-stale queries that should refresh on a tick to keep
 *   the desk in sync (orders, strategy P&L, …). Re-fetches every 5s
 *   while the tab is visible, and only when the tab is visible, so we
 *   don't hammer the adapter when the user is on a different tab.
 * - `"reference"` — slowly-moving reference data (curves, indices,
 *   macro, news, …). Cached for a minute; no focus refetch, no polling.
 *
 * Spread into a `useQuery({ queryKey, queryFn, ...queryOpts("live") })`
 * call. Per-call overrides still win.
 */
export function queryOpts(kind: "live" | "reference") {
  if (kind === "live") {
    return {
      staleTime: 0,
      refetchInterval: 5_000,
      refetchOnWindowFocus: true,
      refetchIntervalInBackground: false,
      retry: 1,
    } as const;
  }
  return {
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    retry: 1,
  } as const;
}
