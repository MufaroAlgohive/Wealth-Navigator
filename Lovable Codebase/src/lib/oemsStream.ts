// Lightweight tick simulator using useSyncExternalStore — no zustand needed.
import { useSyncExternalStore } from "react";

type Tick = { last: number; change: number; changePct: number; ts: number };

const state = new Map<string, Tick>();
const listeners = new Set<() => void>();
const fallbackCache = new Map<string, Tick>();

function emit() { for (const l of listeners) l(); }

let started = false;
let seeds: Record<string, number> = {};

export function seedTicks(initial: Record<string, number>) {
  let changed = false;
  for (const [k, base] of Object.entries(initial)) {
    seeds[k] = base;
    if (!state.has(k)) { state.set(k, { last: base, change: 0, changePct: 0, ts: Date.now() }); changed = true; }
  }
  if (changed) emit();
  if (!started && typeof window !== "undefined") {
    started = true;
    setInterval(() => {
      const keys = Array.from(state.keys());
      if (keys.length === 0) return;
      const n = Math.max(1, Math.floor(keys.length * 0.35));
      for (let i = 0; i < n; i++) {
        const k = keys[Math.floor(Math.random() * keys.length)];
        const prev = state.get(k)!;
        const base = seeds[k] ?? prev.last;
        const vol = base * 0.0006;
        const last = +(prev.last + (Math.random() - 0.5) * vol * 2).toFixed(2);
        const change = +(last - base).toFixed(2);
        const changePct = +((change / base) * 100).toFixed(2);
        state.set(k, { last, change, changePct, ts: Date.now() });
      }
      emit();
    }, 1100);
  }
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

function getFallback(key: string, fallback: number): Tick {
  let f = fallbackCache.get(key);
  if (!f || f.last !== fallback) {
    f = { last: fallback, change: 0, changePct: 0, ts: 0 };
    fallbackCache.set(key, f);
  }
  return f;
}

export function useTick(key: string, fallback: number): Tick {
  return useSyncExternalStore(
    subscribe,
    () => state.get(key) ?? getFallback(key, fallback),
    () => state.get(key) ?? getFallback(key, fallback),
  );
}

let lastTsSnap = 0;
function getMaxTs() {
  let max = 0;
  for (const v of state.values()) if (v.ts > max) max = v.ts;
  if (max !== lastTsSnap) lastTsSnap = max;
  return lastTsSnap;
}

export function useConnectionTs(): number {
  return useSyncExternalStore(subscribe, getMaxTs, () => 0);
}
