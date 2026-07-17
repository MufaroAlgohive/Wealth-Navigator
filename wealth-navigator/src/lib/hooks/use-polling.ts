"use client";

/**
 * `usePolling` — A8.3 wrapper around `@tanstack/react-query`'s `useQuery`
 * that adds a `onlyWhenVisible` pause behavior using
 * `document.visibilityState`. The point is to fix the
 * "aggressive-auto-refresh-closes-dropdown" pattern across the OEMS:
 *   - Default interval is 60s (was 15s in some places).
 *   - `onlyWhenVisible: true` pauses polling when the tab is hidden,
 *     so a desk operator with the tab backgrounded for a coffee doesn't
 *     keep hammering the BFF.
 *   - `onData` fires on every successful response; the caller can use
 *     this to detect row-state changes and trigger a UI-only re-render
 *     without re-running the entire query function.
 *   - `deps` lets the consumer trigger an immediate revalidate when a
 *     piece of state changes (e.g. switching the active tab). This
 *     replaces the legacy `useEffect(() => load(), [tab])` pattern.
 *
 * Migration plan (A8.3):
 *   - cockpit-client.tsx — `cockpitNewsQ` (60s, onlyWhenVisible: true).
 *   - money-market page — refetchInterval 60s → 300s, onlyWhenVisible: true.
 *   - macro page — `macroQ` 60s → 300s, onlyWhenVisible: true.
 *
 * Pages that already use `refetchInterval: false` (e.g. `dividendsQ`,
 * `filingsQ`) don't need migration.
 */

import { type QueryKey, type UseQueryOptions, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { queryOpts } from "@/lib/store/query-provider";

export interface UsePollingOptions<T> {
  /** Polling interval in ms. Defaults to 60_000 (60s). */
  interval?: number;
  /** Pause polling while the tab is hidden. Defaults to true. */
  onlyWhenVisible?: boolean;
  /** Fires on every successful response. Useful for "rows changed?" diffs. */
  onData?: (data: T) => void;
  /**
   * Extra deps that should trigger an immediate revalidate. Pass the
   * same values you'd put in a `useEffect` dependency array.
   */
  deps?: ReadonlyArray<unknown>;
  /** Pass-through to `useQuery`. Use sparingly. */
  query?: Omit<UseQueryOptions<T, Error, T, QueryKey>, "queryKey" | "queryFn">;
}

export interface UsePollingResult<T> {
  data: T | null;
  loading: boolean;
  error: Error | null;
  refresh: () => Promise<unknown>;
  isVisible: boolean;
}

function isDocumentVisible(): boolean {
  if (typeof document === "undefined") return true;
  return document.visibilityState === "visible";
}

export function usePolling<T>(url: string, options: UsePollingOptions<T> = {}): UsePollingResult<T> {
  const { interval = 60_000, onlyWhenVisible = true, onData, deps = [], query } = options;
  const [isVisible, setIsVisible] = useState<boolean>(() => isDocumentVisible());

  useEffect(() => {
    if (typeof document === "undefined") return;
    const onVis = () => setIsVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  const enabled = (query?.enabled ?? true) && (onlyWhenVisible ? isVisible : true);

  const q = useQuery<T, Error>({
    queryKey: ["usePolling", url, ...deps] as QueryKey,
    queryFn: async () => {
      const r = await fetch(url, { cache: "no-store" });
      if (!r.ok) throw new Error(`${url} ${r.status}`);
      return (await r.json()) as T;
    },
    // Spread queryOpts("live") FIRST so the caller's `interval` actually wins.
    // Previously it was spread AFTER, silently clobbering `refetchInterval` with
    // the 5s "live" default — every caller's documented interval was ignored.
    ...queryOpts("live"),
    refetchInterval: enabled ? interval : false,
    ...query,
    enabled,
  });

  // Fire onData when fresh data arrives. The dep array is intentionally
  // tight (just `q.data` + `onData`) so the parent doesn't re-render on
  // unrelated state changes.
  useEffect(() => {
    if (q.data != null && onData) onData(q.data);
    // We intentionally exclude `onData` from the dep array — callers
    // typically pass a fresh closure each render, and a re-fire on
    // every render would defeat the point. If the consumer wants
    // different onData behavior, they should memoize the callback.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q.data]);

  return {
    data: q.data ?? null,
    loading: q.isLoading,
    error: q.error ?? null,
    refresh: q.refetch,
    isVisible,
  };
}

export default usePolling;
