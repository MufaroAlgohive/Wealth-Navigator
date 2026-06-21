/**
 * Research cache — reuse prior AI answers to avoid wasting model tokens.
 *
 * The user's explicit requirement: "when people search for the same asset and
 * there was NO significant information/impact/change/new data, use the previous
 * answer." So the cache is GLOBAL PER SYMBOL (not per user) — research about an
 * asset is the same for everyone, so different users searching the same ticker
 * reuse one entry. Maximum token savings.
 *
 * Backed by the Supabase table `ai_research_cache_c` on the INSTITUTIONAL
 * project (`nnwz`) — research/desk tooling is kept on the institutional DB,
 * separate from the retail customer DB the route gathers `securities_c` /
 * `News_articles` from. If the client throws or the table is missing, every
 * operation DEGRADES GRACEFULLY → treated as no cache (cacheStatus "uncached");
 * the route never crashes.
 *
 * MATERIALITY: each entry persists a `signal` (latest news ts, news count, last
 * price, fundamentals hash) + `generated_at`. On a request we recompute the
 * signal from fresh real evidence and only REUSE the stored answer when nothing
 * material changed (no new news, no big price move, fundamentals unchanged, not
 * stale) and no force-refresh. Otherwise we regenerate and overwrite.
 *
 * BASELINE (frozen at generation): materiality is measured against the
 * GENERATION that produced the cached answer — the stored `signal` stays frozen
 * at generation and is NOT advanced on a hit. This is deliberate: the cached
 * answer reflects the evidence at generation time, so we regenerate once the
 * world has drifted materially FROM that point, which also catches slow
 * cumulative drift — an answer generated at price 100 is reused at 103
 * (+3% < gate) but regenerated at 106 (+6% vs the 100 it was based on).
 * Re-anchoring to the last-seen value on each hit would instead see 3% steps
 * forever and never refresh (boiling-frog), so we never touch the baseline on a hit.
 */

import { createHash } from "node:crypto";

import {
  createInstitutionalServiceRoleClient,
  isInstitutionalSupabaseConfigured,
} from "@/lib/supabase/server";
import type {
  GatheredEvidence,
  ResearchAiProvider,
  ResearchOutlook,
  ResearchSignal,
  ResearchSource,
} from "@/lib/research-ai/types";

const TABLE = "ai_research_cache_c";

/** Env-tunable materiality thresholds (guarded parse, sane defaults). */
function priceDeltaPct(): number {
  const raw = Number(process.env.RESEARCH_AI_PRICE_DELTA_PCT);
  return Number.isFinite(raw) && raw > 0 ? raw : 5;
}
function ttlHours(): number {
  const raw = Number(process.env.RESEARCH_AI_TTL_HOURS);
  return Number.isFinite(raw) && raw > 0 ? raw : 168; // 7 days
}

/** A stored cache entry (post-validation, app-shaped). */
export interface CachedResearch {
  symbol: string;
  name: string | null;
  provider: ResearchAiProvider | null;
  model: string | null;
  generatedAt: string;
  outlook: ResearchOutlook;
  sources: ResearchSource[];
  gathered: GatheredEvidence;
  signal: ResearchSignal;
}

/** Payload the route persists when it generates a fresh answer. */
export interface PutResearchPayload {
  name: string | null;
  provider: ResearchAiProvider | null;
  model: string | null;
  generatedAt: string;
  outlook: ResearchOutlook;
  sources: ResearchSource[];
  gathered: GatheredEvidence;
  signal: ResearchSignal;
}

/** True when the INSTITUTIONAL service-role target (where the cache table lives) is set. */
export function isResearchStoreConfigured(): boolean {
  return isInstitutionalSupabaseConfigured();
}

/**
 * Stable hash of the KEY fundamentals fields. Order-independent (sorted keys),
 * so cosmetic reordering does not invalidate the cache; any real value change
 * does. Empty/absent fundamentals hash to a constant sentinel.
 */
export function hashFundamentals(fundamentals: Record<string, unknown> | null): string {
  if (!fundamentals) return "none";
  const keys = Object.keys(fundamentals).sort();
  const normalized: Record<string, unknown> = {};
  for (const k of keys) {
    const v = fundamentals[k];
    normalized[k] = v === undefined ? null : v;
  }
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex").slice(0, 32);
}

/**
 * Compute the materiality signal from REAL gathered evidence + the news items
 * actually used (their publish timestamps drive `latestNewsTs`). Never throws.
 */
export function computeSignal(
  gathered: GatheredEvidence,
  newsTimestamps: ReadonlyArray<string | null> = [],
): ResearchSignal {
  let latestNewsTs: string | null = null;
  for (const ts of newsTimestamps) {
    if (!ts) continue;
    const t = Date.parse(ts);
    if (!Number.isFinite(t)) continue;
    if (latestNewsTs === null || t > Date.parse(latestNewsTs)) latestNewsTs = ts;
  }
  return {
    latestNewsTs,
    newsCount: gathered.newsCount,
    lastPrice: gathered.priceSummary?.last ?? null,
    fundamentalsHash: hashFundamentals(gathered.fundamentals),
  };
}

/** Percent change magnitude between two prices; null when not computable. */
function pctChange(fresh: number | null, prev: number | null): number | null {
  if (fresh === null || prev === null || !(prev > 0)) return null;
  return Math.abs(((fresh - prev) / prev) * 100);
}

function hoursSince(iso: string): number {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return Number.POSITIVE_INFINITY;
  return (Date.now() - t) / 3_600_000;
}

function fmtDate(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "previously";
  return new Date(t).toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

export interface MaterialityDecision {
  /** true → reuse stored answer (no model call). */
  reuse: boolean;
  /** Human sentence describing why reused or the FIRST failing reason. */
  reason: string;
}

/**
 * Compare a fresh signal against a cached entry and decide reuse vs regenerate.
 * Reuse only when ALL hold (and not force-refresh):
 *   • no new news        fresh.latestNewsTs <= cached AND fresh.newsCount <= cached
 *   • no material move   |pct(fresh.lastPrice, cached.lastPrice)| < threshold
 *   • fundamentals same  hashes equal
 *   • not stale          age < TTL hours
 * The FIRST failing check sets the refresh reason.
 */
export function assessMateriality(
  fresh: ResearchSignal,
  cached: CachedResearch,
  forceRefresh: boolean,
): MaterialityDecision {
  if (forceRefresh) return { reuse: false, reason: "Manual refresh" };

  const prev = cached.signal;

  // New news?
  const freshTs = fresh.latestNewsTs ? Date.parse(fresh.latestNewsTs) : null;
  const prevTs = prev.latestNewsTs ? Date.parse(prev.latestNewsTs) : null;
  const hasNewerNews = freshTs !== null && (prevTs === null || freshTs > prevTs);
  if (hasNewerNews || fresh.newsCount > prev.newsCount) {
    return { reuse: false, reason: "New SENS/news detected" };
  }

  // Material price move?
  const move = pctChange(fresh.lastPrice, prev.lastPrice);
  if (move !== null && move >= priceDeltaPct()) {
    return {
      reuse: false,
      reason: `Price moved ${move.toFixed(1)}% since last research`,
    };
  }

  // Fundamentals changed?
  if (fresh.fundamentalsHash !== prev.fundamentalsHash) {
    return { reuse: false, reason: "Fundamentals updated" };
  }

  // Stale?
  const ttl = ttlHours();
  if (hoursSince(cached.generatedAt) >= ttl) {
    return { reuse: false, reason: `Stale (>${Math.round(ttl / 24)}d)` };
  }

  return {
    reuse: true,
    reason: `No material change since ${fmtDate(cached.generatedAt)} — reused prior research (no tokens used)`,
  };
}

/** Raw DB row shape (jsonb columns arrive as already-parsed objects). */
interface CacheRow {
  symbol: string;
  name: string | null;
  provider: string | null;
  model: string | null;
  generated_at: string | null;
  outlook: unknown;
  sources: unknown;
  gathered: unknown;
  signal: unknown;
}

function asProvider(v: unknown): ResearchAiProvider | null {
  return v === "minimax" || v === "claude" ? v : null;
}

/** Validate a DB row into a CachedResearch, or null if it cannot be trusted. */
function rowToCached(row: CacheRow): CachedResearch | null {
  if (!row || typeof row.symbol !== "string" || !row.generated_at) return null;
  const outlook = row.outlook as ResearchOutlook | null;
  const signal = row.signal as ResearchSignal | null;
  const gathered = row.gathered as GatheredEvidence | null;
  // Minimal structural guards — a malformed entry is treated as a miss.
  if (!outlook || typeof outlook !== "object" || typeof outlook.summary !== "string") return null;
  if (!signal || typeof signal !== "object" || typeof signal.fundamentalsHash !== "string") return null;
  if (!gathered || typeof gathered !== "object") return null;
  const sources = Array.isArray(row.sources) ? (row.sources as ResearchSource[]) : [];
  return {
    symbol: row.symbol,
    name: row.name ?? null,
    provider: asProvider(row.provider),
    model: typeof row.model === "string" ? row.model : null,
    generatedAt: row.generated_at,
    outlook,
    sources,
    gathered,
    signal,
  };
}

/**
 * Fetch the cached entry for a symbol. Returns null when not found OR when the
 * store is unavailable / table missing / row malformed (graceful "uncached").
 */
export async function getCachedResearch(symbol: string): Promise<CachedResearch | null> {
  if (!isResearchStoreConfigured()) return null;
  try {
    const supabase = createInstitutionalServiceRoleClient();
    const { data, error } = await supabase
      .from(TABLE)
      .select("symbol,name,provider,model,generated_at,outlook,sources,gathered,signal")
      .eq("symbol", symbol)
      .limit(1)
      .maybeSingle();
    if (error || !data) return null;
    return rowToCached(data as CacheRow);
  } catch {
    return null;
  }
}

/**
 * Upsert a fresh answer for a symbol. Returns true ONLY when the row actually
 * persisted. Best-effort and never throws: if the store is down OR the
 * `ai_research_cache_c` table is not provisioned yet, the Supabase upsert
 * returns an error object (it does not throw) — we surface that as `false` so
 * the route reports cacheStatus "uncached" honestly instead of implying the
 * answer was stored for reuse.
 */
export async function putCachedResearch(
  symbol: string,
  payload: PutResearchPayload,
): Promise<boolean> {
  if (!isResearchStoreConfigured()) return false;
  try {
    const supabase = createInstitutionalServiceRoleClient();
    const { error } = await supabase.from(TABLE).upsert(
      {
        symbol,
        name: payload.name,
        provider: payload.provider,
        model: payload.model,
        generated_at: payload.generatedAt,
        outlook: payload.outlook,
        sources: payload.sources,
        gathered: payload.gathered,
        signal: payload.signal,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "symbol" },
    );
    return !error;
  } catch {
    return false;
  }
}
