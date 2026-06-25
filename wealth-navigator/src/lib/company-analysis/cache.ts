/**
 * Company-data cache — reuse fetched market data so the same symbol does not hit
 * the upstream provider (Yahoo) on every view, and so a free, rate-limited API is
 * never exhausted. Two tiers, both graceful:
 *
 *   1) HOT in-process Map (per server instance) — instant, bounded, cleared on
 *      restart. Bridges the gap before / when the durable table is unavailable.
 *   2) DURABLE Supabase table `company_data_cache_c` on the INSTITUTIONAL DB —
 *      shared across users and serverless instances, survives restarts. This is
 *      the tier that actually protects the upstream API across the fleet.
 *
 * Keyed by an opaque `cache_key` (e.g. "analysis:MSFT", "deep:NPN.JO",
 * "chart:AAPL:5Y", "search:tesla"). Each caller passes a per-dataset TTL — slow
 * data (statements) gets hours, fast data (news) gets minutes. Successful
 * payloads only are stored (a transient upstream error is never cached) via an
 * optional `isValid` guard. Every operation degrades to a live fetch if the
 * store throws or the table is missing — it can never break a route.
 *
 * The live price is intentionally NOT cached here; routes overlay a fresh IRESS
 * quote on top of the cached fundamentals (see ./iress) so price stays current
 * while the heavy fundamentals are reused.
 */

import {
  createInstitutionalServiceRoleClient,
  isInstitutionalSupabaseConfigured,
} from "@/lib/supabase/server";

const TABLE = "company_data_cache_c";

interface MemEntry {
  payload: unknown;
  fetchedAt: number;
}
const mem = new Map<string, MemEntry>();
const MEM_MAX = 600;

function memGet(key: string, ttlMs: number): MemEntry | null {
  const e = mem.get(key);
  if (!e) return null;
  if (Date.now() - e.fetchedAt > ttlMs) {
    mem.delete(key);
    return null;
  }
  // refresh LRU position
  mem.delete(key);
  mem.set(key, e);
  return e;
}
function memSet(key: string, payload: unknown, fetchedAt: number): void {
  if (mem.size >= MEM_MAX) {
    const oldest = mem.keys().next().value;
    if (oldest !== undefined) mem.delete(oldest);
  }
  mem.set(key, { payload, fetchedAt });
}

export interface CacheResult<T> {
  value: T;
  /** true when served from a cache tier (not a fresh upstream fetch). */
  hit: boolean;
  /** epoch ms the cached payload was originally fetched. */
  fetchedAt: number;
  /** which tier served / stored it. */
  tier: "memory" | "durable" | "fetch";
}

/** Common TTLs (ms). Slow fundamentals cached longer; volatile data shorter. */
export const TTL = {
  analysis: 60 * 60_000, // 1h — overview + fundamentals (price overlaid live)
  deep: 6 * 60 * 60_000, // 6h — statements / estimates / research / ownership
  chart: 6 * 60 * 60_000, // 6h — daily/weekly closes
  search: 24 * 60 * 60_000, // 24h — symbol lists are stable
  news: 30 * 60_000, // 30m — headlines
} as const;

/**
 * Get `key` from cache or compute it. Memory tier first, then durable tier, then
 * a live fetch (stored to both). `isValid` gates storage so error payloads are
 * not cached. Never throws on the cache path.
 */
export async function cached<T>(
  key: string,
  ttlMs: number,
  fetcher: () => Promise<T>,
  opts?: { isValid?: (v: T) => boolean; bypass?: boolean },
): Promise<CacheResult<T>> {
  const isValid = opts?.isValid ?? (() => true);

  if (!opts?.bypass) {
    // 1) hot memory tier
    const m = memGet(key, ttlMs);
    if (m) return { value: m.payload as T, hit: true, fetchedAt: m.fetchedAt, tier: "memory" };

    // 2) durable tier
    if (isInstitutionalSupabaseConfigured()) {
      try {
        const sb = createInstitutionalServiceRoleClient();
        const { data, error } = await sb
          .from(TABLE)
          .select("payload,fetched_at")
          .eq("cache_key", key)
          .limit(1)
          .maybeSingle();
        if (!error && data && data.fetched_at) {
          const fetchedAt = Date.parse(data.fetched_at as string);
          if (Number.isFinite(fetchedAt) && Date.now() - fetchedAt <= ttlMs) {
            memSet(key, data.payload, fetchedAt); // warm the hot tier
            return { value: data.payload as T, hit: true, fetchedAt, tier: "durable" };
          }
        }
      } catch {
        /* fall through to a live fetch */
      }
    }
  }

  // 3) miss → live fetch
  const value = await fetcher();
  const fetchedAt = Date.now();
  if (isValid(value)) {
    memSet(key, value, fetchedAt);
    if (isInstitutionalSupabaseConfigured()) {
      try {
        const sb = createInstitutionalServiceRoleClient();
        await sb
          .from(TABLE)
          .upsert(
            { cache_key: key, payload: value, fetched_at: new Date(fetchedAt).toISOString(), updated_at: new Date(fetchedAt).toISOString() },
            { onConflict: "cache_key" },
          );
      } catch {
        /* durable write is best-effort */
      }
    }
  }
  return { value, hit: false, fetchedAt, tier: "fetch" };
}

/** Normalise a symbol into a stable cache-key fragment. */
export function symKey(sym: string): string {
  return sym.trim().toUpperCase();
}
