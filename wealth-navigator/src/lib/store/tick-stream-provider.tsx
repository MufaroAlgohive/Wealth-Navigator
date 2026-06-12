"use client";

// Tick store — single source of truth for live quote updates.
// Subscribers (PriceCell, TickerBar, chart panels) read with `useTick(sym)`.
// The store is fed by the TickStreamProvider, which opens an SSE connection
// to /api/ticks in dev. In production the same provider would open a
// WebSocket to the IRESS edge proxy.

import { create } from "zustand";
import { useEffect, useRef } from "react";
import { initialQuotes } from "@/lib/iress/seed";
import { useSyncExternalStore } from "react";

/** Per-sample push cadence. The SSE stream ticks at ~3 Hz; sparklines can
 *  downsample to 1 Hz since humans can't read a 36-point chart updating
 *  three times a second anyway. KPI / NumberCell readers stay on the
 *  full stream via `useTick`. */
const SPARKLINE_DEFAULT_INTERVAL_MS = 1000;

interface Quote {
  last: number;
  prev: number;
  change: number;
  changePct: number;
  ts: number;
  vwap: number;
  volume: number;
}

const EMPTY_QUOTE: Quote = {
  last: 0,
  prev: 0,
  change: 0,
  changePct: 0,
  ts: 0,
  vwap: 0,
  volume: 0,
};

const tickMap = new Map<string, Quote>(Object.entries(initialQuotes()).map(([k, v]) => [k, {
  last: v.last, prev: v.last, change: v.change, changePct: v.changePct, ts: v.ts, vwap: v.vwap, volume: v.volume,
}]));

// Cache the keys snapshot so `useTickKeys` returns a stable reference
// between ticks — `useSyncExternalStore` requires the snapshot to be
// referentially stable when the underlying data hasn't changed.
let cachedKeys: string[] = [];
let cachedKeysVersion = 0;
function getKeysSnapshot(): string[] {
  const v = tickVersion;
  if (v !== cachedKeysVersion) {
    cachedKeys = Array.from(tickMap.keys());
    cachedKeysVersion = v;
  }
  return cachedKeys;
}

const listeners = new Set<() => void>();
let tickVersion = 0;
function emit() {
  tickVersion++;
  for (const l of listeners) l();
}

export type TickFeedKind = "supabase" | "stream" | "mock";

let quoteFeedKind: TickFeedKind = "mock";
const supabaseProtectedSyms = new Set<string>();

export function useQuoteFeedKind(): TickFeedKind {
  return useSyncExternalStore(
    subscribe,
    () => quoteFeedKind,
    () => "mock" as TickFeedKind,
  );
}

function setQuoteFeedKind(kind: TickFeedKind) {
  if (quoteFeedKind === kind) return;
  quoteFeedKind = kind;
  emit();
}

function isSupabaseQuotesMode(): boolean {
  const raw = process.env.NEXT_PUBLIC_USE_SUPABASE_QUOTES;
  return raw === "1" || raw?.toLowerCase() === "true";
}

/** Seed or update ticks from a live-quote API response (client-side). */
export function seedTicksFromQuotes(
  rows: Array<{ sym: string; last: number; prev?: number; bid?: number; ask?: number; change?: number; changePct?: number; volume?: number; vwap?: number }>,
  feed: TickFeedKind = "supabase",
) {
  if (feed === "supabase") {
    setQuoteFeedKind("supabase");
    for (const r of rows) if (r.sym) supabaseProtectedSyms.add(r.sym);
  }
  for (const r of rows) {
    if (!r.sym || r.last <= 0) continue;
    const prev = r.prev ?? r.last;
    const change = r.change ?? (prev > 0 ? r.last - prev : 0);
    const changePct = r.changePct ?? (prev > 0 ? (change / prev) * 100 : 0);
    if (feed === "supabase") {
      tickMap.set(r.sym, {
        last: r.last,
        prev,
        change,
        changePct,
        ts: Date.now(),
        vwap: r.vwap ?? r.last,
        volume: r.volume ?? 0,
      });
      continue;
    }
    const cur = tickMap.get(r.sym);
    const base: Quote = cur ?? {
      last: r.last,
      prev: r.last,
      change: 0,
      changePct: 0,
      ts: Date.now(),
      vwap: r.vwap ?? r.last,
      volume: r.volume ?? 0,
    };
    tickMap.set(r.sym, {
      ...base,
      last: r.last,
      prev: cur?.last ?? r.last,
      change: r.change ?? base.change,
      changePct: r.changePct ?? base.changePct,
      vwap: r.vwap ?? base.vwap,
      volume: r.volume ?? base.volume,
      ts: Date.now(),
    });
  }
  emit();
}

function setTick(sym: string, next: Partial<Quote>, feed: TickFeedKind = "stream") {
  const cur = tickMap.get(sym);
  if (!cur) return;
  if (supabaseProtectedSyms.has(sym) && feed !== "supabase") return;
  const merged: Quote = { ...cur, ...next, ts: Date.now() };
  // round
  merged.last = +merged.last.toFixed(4);
  merged.prev = cur.last;
  merged.change = +(merged.last - (cur.prev ?? merged.last)).toFixed(4);
  merged.changePct = cur.last ? +((merged.change / cur.last) * 100).toFixed(2) : 0;
  tickMap.set(sym, merged);
  emit();
}

function getTick(sym: string): Quote {
  return tickMap.get(sym) ?? EMPTY_QUOTE;
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

export function useTick(sym: string): Quote {
  return useSyncExternalStore(subscribe, () => getTick(sym), () => EMPTY_QUOTE);
}

/** All tick keys currently being tracked (for the ticker). */
export function useTickKeys(): string[] {
  return useSyncExternalStore(subscribe, getKeysSnapshot, () => []);
}

/** Server-side snapshot of the last update timestamp. */
export function useLastTickTs(): number {
  return useSyncExternalStore(
    subscribe,
    () => {
      let max = 0;
      for (const v of tickMap.values()) if (v.ts > max) max = v.ts;
      return max;
    },
    () => 0,
  );
}

// Cached server-snapshot buffers, keyed by `${n}:${fallback}`. React's
// `useSyncExternalStore` requires `getServerSnapshot` to return a stable
// reference across calls — caching the seed array avoids creating a fresh
// one each render, which would otherwise trigger a "getServerSnapshot should
// be cached" warning (and potentially an infinite re-render).
const seriesServerCache = new Map<string, number[]>();
function getSeriesServerSnapshot(n: number, fallback: number): number[] {
  const key = `${n}:${fallback}`;
  let s = seriesServerCache.get(key);
  if (!s) {
    s = Array.from({ length: n }, () => fallback);
    seriesServerCache.set(key, s);
  }
  return s;
}

/**
 * Returns a rolling window of the last `n` tick values for `sym`, sampled at
 * the full ~3 Hz stream rate. The buffer lives in a `useRef` (per-hook
 * instance, not in the module store) and the snapshot function only allocates
 * a new array reference when a fresh sample is appended — so React only
 * re-renders this consumer when its own buffer advances, not on every tick
 * for every sym in the stream.
 *
 * - Seeds with `fallback` so brand-new symbols (no entry in the store yet)
 *   don't render as a flat-zero line.
 * - Resets the buffer when `sym` changes so a switched watchlist doesn't
 *   smear the previous ticker's history across the new one.
 */
export function useTickSeries(sym: string, fallback: number, n: number = 36): number[] {
  const bufferRef = useRef<number[]>([]);
  const lastTsRef = useRef(0);
  const lastSymRef = useRef(sym);

  // Reset the buffer on a sym change (render-time reset is the standard
  // "derived state" pattern — cheaper than a useEffect flicker).
  if (lastSymRef.current !== sym) {
    lastSymRef.current = sym;
    lastTsRef.current = 0;
    bufferRef.current = [];
  }

  return useSyncExternalStore(
    subscribe,
    () => {
      if (bufferRef.current.length === 0) {
        bufferRef.current = Array.from({ length: n }, () => fallback);
      }
      const t = getTick(sym);
      if (t.ts === 0 || t.ts === lastTsRef.current) {
        return bufferRef.current;
      }
      lastTsRef.current = t.ts;
      const next = [...bufferRef.current.slice(-(n - 1)), t.last];
      bufferRef.current = next;
      return next;
    },
    () => getSeriesServerSnapshot(n, fallback),
  );
}

/**
 * Throttled variant of `useTickSeries`. Listens to the tick stream at the
 * full rate but only pushes a new sample into the buffer every
 * `intervalMs` (default 1 s). The selector returns the same array reference
 * for the in-between ticks, so React skips the re-render entirely.
 *
 * Use this for sparklines and other chart primitives that don't need
 * 3 Hz updates.
 */
export function useThrottledTickSeries(
  sym: string,
  fallback: number,
  n: number = 36,
  intervalMs: number = SPARKLINE_DEFAULT_INTERVAL_MS,
): number[] {
  const bufferRef = useRef<number[]>([]);
  const lastTsRef = useRef(0);
  const lastSampleAtRef = useRef(0);
  const lastSymRef = useRef(sym);

  if (lastSymRef.current !== sym) {
    lastSymRef.current = sym;
    lastTsRef.current = 0;
    lastSampleAtRef.current = 0;
    bufferRef.current = [];
  }

  return useSyncExternalStore(
    subscribe,
    () => {
      if (bufferRef.current.length === 0) {
        bufferRef.current = Array.from({ length: n }, () => fallback);
      }
      const t = getTick(sym);
      if (t.ts === 0 || t.ts === lastTsRef.current) {
        return bufferRef.current;
      }
      const now = Date.now();
      if (now - lastSampleAtRef.current < intervalMs) {
        return bufferRef.current;
      }
      lastTsRef.current = t.ts;
      lastSampleAtRef.current = now;
      const next = [...bufferRef.current.slice(-(n - 1)), t.last];
      bufferRef.current = next;
      return next;
    },
    () => getSeriesServerSnapshot(n, fallback),
  );
}

// Local-tick simulator used when there's no SSE source (e.g. SSR, offline).
// Mirrors the Lovable prototype's tick generator.
let started = false;
function startLocalSim() {
  if (started || typeof window === "undefined" || isSupabaseQuotesMode()) return;
  started = true;
  const interval = Number(process.env.NEXT_PUBLIC_TICK_INTERVAL_MS ?? 1100);
  setInterval(() => {
    const keys = Array.from(tickMap.keys()).filter((k) => !supabaseProtectedSyms.has(k));
    if (keys.length === 0) return;
    const n = Math.max(1, Math.floor(keys.length * 0.25));
    for (let i = 0; i < n; i++) {
      const idx = Math.floor(Math.random() * keys.length);
      const k = keys[idx];
      if (k === undefined) continue;
      const cur = tickMap.get(k);
      if (!cur) continue;
      const vol = (cur.last > 1000 ? cur.last * 0.0004 : cur.last * 0.0008) || 0.02;
      const last = cur.last + (Math.random() - 0.5) * vol;
      setTick(k, { last });
    }
  }, interval);
}

export function TickStreamProvider({ children }: { children: React.ReactNode }) {
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    // Supabase quotes: BFF poll + Realtime only — skip seed SSE/random walk.
    if (isSupabaseQuotesMode()) return;

    let cancelled = false;
    try {
      const es = new EventSource("/api/ticks");
      esRef.current = es;
      es.onmessage = (e) => {
        try {
          const ticks: Array<{ sym: string; last: number }> = JSON.parse(e.data);
          setQuoteFeedKind("stream");
          for (const t of ticks) setTick(t.sym, { last: t.last }, "stream");
        } catch { /* ignore */ }
      };
      es.onerror = () => {
        es.close();
        esRef.current = null;
        if (!cancelled) startLocalSim();
      };
    } catch {
      startLocalSim();
    }
    startLocalSim();
    return () => {
      cancelled = true;
      esRef.current?.close();
    };
  }, []);

  return <>{children}</>;
}

// Internal store hook for the Zustand-style API. Not used directly by
// components but available for advanced use cases (e.g. writing ticks
// from a custom WebSocket).
export const useTickStore = create<{ symbols: string[] }>(() => ({
  symbols: Array.from(tickMap.keys()),
}));
