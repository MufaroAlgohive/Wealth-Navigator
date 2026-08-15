import type { SupabaseClient } from "@supabase/supabase-js";

import { createRetailServiceRoleClient, isRetailSupabaseConfigured } from "../supabase/server";

/**
 * Rebalance-aware EOD return publisher.
 *
 * Each trading day this publishes every active strategy through the guarded
 * RPC `publish_guarded_strategy_return`, chaining from that strategy's own
 * prior publication. A strategy's value is its COMPLETE lot: securities from
 * the composition effective on the requested date, priced from that date's
 * stored close (guarded intraday fallback), plus continuity cash from its
 * required ACTIVE `strategy_valuation_rules_c` row. Because complete value is
 * preserved across a rebalance — the
 * value the new basket no longer represents becomes continuity cash, sealed
 * by `finalize_rebalance_return_boundary` at settlement — a composition
 * change is not seen as a return, and YTD chains through instead of stepping.
 *
 * The RPC's own checks (complete-value identity, full price coverage, price
 * freshness, YTD↔chain reconciliation, boundary bridge) reject anything
 * inconsistent, so a bad day simply does not publish rather than publishing a
 * wrong number.
 *
 * This controlled fallback reads and writes the same retail tables and guarded
 * RPC as the primary MINT publisher. MyMintAdmin's old publisher is retired.
 * Only one publisher may be scheduled
 * at a time: both writing the same (strategy, as_of_date) would have them
 * disagree on `composition_effective_from` and manufacture spurious boundary
 * bridges, which is visible in the Aug 2026 history.
 *
 * SAFE BY DEFAULT: writes only when `apply` is true. Otherwise it runs
 * read-only and returns the plan, so it can be deployed and observed first.
 */

const DAY_MS = 86_400_000;

function bare(symbol: string): string {
  return String(symbol ?? "")
    .trim()
    .toUpperCase()
    .replace(/\.(JO|JSE)$/i, "");
}

interface TemplateHolding {
  symbol: string;
  shares: number;
}

export interface PublishResultRow {
  strategy: string;
  action: "published" | "plan" | "skip" | "failed";
  reason?: string;
  mode?: string;
  completeCents?: number;
  ytdPct?: number;
  oneDayPct?: number | null;
  error?: string;
}

export interface PublishEodReturnsResult {
  ok: boolean;
  asOf: string;
  apply: boolean;
  summary: { published: number; skipped: number; failed: number; total: number };
  results: PublishResultRow[];
  note?: string;
}

/** Seed YTD when a strategy has no publication yet: promoted repair shadow first, else legacy nightly, else flat. */
async function seedYtd(db: SupabaseClient, strategyId: string): Promise<{ ytd: number; src: string }> {
  const shadow = await db
    .from("strategy_returns_shadow_c")
    .select("ytd_pct, return_repair_runs_c!inner(status)")
    .eq("strategy_id", strategyId)
    .eq("return_repair_runs_c.status", "PROMOTED")
    .order("as_of_date", { ascending: false })
    .limit(1);
  const shadowYtd = shadow.data?.[0]?.ytd_pct;
  if (shadowYtd != null && Number.isFinite(Number(shadowYtd))) {
    return { ytd: Number(shadowYtd), src: "promoted-shadow" };
  }

  const legacy = await db
    .from("strategies_returns_c")
    .select("ytd_pct")
    .eq("strategy_id", strategyId)
    .order("as_of_date", { ascending: false })
    .limit(1);
  const legacyYtd = legacy.data?.[0]?.ytd_pct;
  if (legacyYtd != null && Number.isFinite(Number(legacyYtd))) {
    return { ytd: Number(legacyYtd), src: "legacy" };
  }
  return { ytd: 0, src: "zero" };
}

export async function publishEodReturns(
  options: { asOfDate?: string; apply?: boolean } = {},
): Promise<PublishEodReturnsResult> {
  const asOf = options.asOfDate || new Date().toISOString().slice(0, 10);
  const apply = options.apply === true;
  const empty = { published: 0, skipped: 0, failed: 0, total: 0 };

  if (!isRetailSupabaseConfigured()) {
    return { ok: false, asOf, apply, summary: empty, results: [], note: "retail supabase not configured" };
  }
  const db = createRetailServiceRoleClient();

  const stratRes = await db.from("strategies_c").select("id, name, holdings").eq("status", "active");
  if (stratRes.error) {
    return { ok: false, asOf, apply, summary: empty, results: [], note: stratRes.error.message };
  }
  const strategies = (stratRes.data ?? []) as Array<{ id: string; name: string; holdings: unknown }>;
  if (strategies.length === 0) {
    return { ok: true, asOf, apply, summary: empty, results: [], note: "no active strategies" };
  }

  // Resolve the composition effective on the requested close. A valuation
  // rule date is a capital/cash anchor, not a composition boundary.
  const strategyIds = strategies.map((strategy) => strategy.id);
  const compositionRes = await db
    .from("strategy_composition_log_c")
    .select("strategy_id, effective_from, effective_to, holdings, created_at")
    .in("strategy_id", strategyIds)
    .lte("effective_from", asOf)
    .order("effective_from", { ascending: false })
    .order("created_at", { ascending: false });
  if (compositionRes.error) {
    return { ok: false, asOf, apply, summary: empty, results: [], note: compositionRes.error.message };
  }
  const compositionBy = new Map<
    string,
    { effective_from: string; effective_to: string | null; holdings: unknown }
  >();
  for (const row of (compositionRes.data ?? []) as Array<{
    strategy_id: string;
    effective_from: string;
    effective_to: string | null;
    holdings: unknown;
  }>) {
    if (!compositionBy.has(row.strategy_id) && (!row.effective_to || row.effective_to >= asOf)) {
      compositionBy.set(row.strategy_id, row);
    }
  }

  // Effective model holdings per strategy + the full symbol universe to price.
  const template = new Map<string, TemplateHolding[]>();
  const bases = new Set<string>();
  for (const s of strategies) {
    const sourceHoldings = compositionBy.get(s.id)?.holdings;
    const rows = (Array.isArray(sourceHoldings) ? sourceHoldings : []) as Array<Record<string, unknown>>;
    const parsed = rows
      .map((h) => ({
        symbol: bare(String(h.symbol ?? h.ticker ?? "")),
        shares: Number(h.shares ?? h.quantity ?? 1),
      }))
      .filter((h) => h.symbol && Number.isFinite(h.shares) && h.shares > 0);
    template.set(s.id, parsed);
    for (const h of parsed) bases.add(h.symbol);
  }

  const universe = [...bases, ...[...bases].map((b) => `${b}.JO`)];
  const since = new Date(Date.now() - 4 * DAY_MS).toISOString();
  const [pxRes, eodRes] = await Promise.all([
    db
      .from("stock_intraday_c")
      .select("symbol, current_price, timestamp")
      .in("symbol", universe)
      .gte("timestamp", since)
      .order("timestamp", { ascending: false }),
    db
      .from("stock_returns_c")
      .select("symbol, current_price, as_of_date, fetched_at")
      .in("symbol", universe)
      .eq("as_of_date", asOf),
  ]);
  if (pxRes.error || eodRes.error) {
    return {
      ok: false,
      asOf,
      apply,
      summary: empty,
      results: [],
      note: pxRes.error?.message || eodRes.error?.message,
    };
  }
  const priceCents = new Map<string, number>();
  const priceAt = new Map<string, string>();
  const priceSource = new Map<string, "STORED_EOD_CLOSE" | "GUARDED_INTRADAY">();
  for (const r of (eodRes.data ?? []) as Array<{
    symbol: string;
    current_price: number | string | null;
    fetched_at: string | null;
  }>) {
    const b = bare(r.symbol);
    const p = Number(r.current_price);
    if (priceCents.has(b) || !(p > 0) || !r.fetched_at) continue;
    priceCents.set(b, p);
    priceAt.set(b, r.fetched_at);
    priceSource.set(b, "STORED_EOD_CLOSE");
  }
  for (const r of (pxRes.data ?? []) as Array<{
    symbol: string;
    current_price: number | string | null;
    timestamp: string;
  }>) {
    const b = bare(r.symbol);
    const p = Number(r.current_price);
    if (priceCents.has(b) || !(p > 0)) continue;
    priceCents.set(b, p);
    priceAt.set(b, r.timestamp);
    priceSource.set(b, "GUARDED_INTRADAY");
  }

  // ACTIVE valuation rules carry continuity cash + the composition's effective date.
  const rulesRes = await db
    .from("strategy_valuation_rules_c")
    .select("strategy_id, effective_from, continuity_cash_per_lot_cents")
    .eq("status", "ACTIVE");
  const ruleBy = new Map<string, { effective_from: string; continuity_cash_per_lot_cents: number }>();
  for (const r of (rulesRes.data ?? []) as Array<{
    strategy_id: string;
    effective_from: string;
    continuity_cash_per_lot_cents: number;
  }>) {
    ruleBy.set(r.strategy_id, r);
  }

  const results: PublishResultRow[] = [];
  let published = 0;
  let skipped = 0;
  let failed = 0;

  for (const s of strategies) {
    const holds = template.get(s.id) ?? [];
    try {
      const composition = compositionBy.get(s.id);
      if (!composition) {
        results.push({ strategy: s.name, action: "skip", reason: "no effective composition" });
        skipped += 1;
        continue;
      }
      if (holds.length === 0) {
        results.push({ strategy: s.name, action: "skip", reason: "no template holdings" });
        skipped += 1;
        continue;
      }

      let securitiesCents = 0;
      let oldestUsedPriceAt: string | null = null;
      const missing: string[] = [];
      const sources = new Set<string>();
      for (const h of holds) {
        const p = priceCents.get(h.symbol);
        if (p == null) {
          missing.push(h.symbol);
          continue;
        }
        securitiesCents += h.shares * p;
        const at = priceAt.get(h.symbol);
        if (at && (!oldestUsedPriceAt || at < oldestUsedPriceAt)) oldestUsedPriceAt = at;
        const source = priceSource.get(h.symbol);
        if (source) sources.add(source);
      }
      if (missing.length > 0) {
        results.push({ strategy: s.name, action: "skip", reason: `missing price: ${missing.join(",")}` });
        skipped += 1;
        continue;
      }
      // The RPC rejects prices older than a day; skip early rather than log a failure.
      if (!oldestUsedPriceAt || new Date(oldestUsedPriceAt).getTime() < new Date(asOf).getTime() - DAY_MS) {
        results.push({ strategy: s.name, action: "skip", reason: "stale prices (non-trading day?)" });
        skipped += 1;
        continue;
      }

      const rule = ruleBy.get(s.id);
      if (!rule) {
        results.push({ strategy: s.name, action: "skip", reason: "no active valuation rule" });
        skipped += 1;
        continue;
      }
      const continuityCents = Math.round(Number(rule?.continuity_cash_per_lot_cents ?? 0));
      const completeCents = Math.round(securitiesCents) + continuityCents;

      const prevRes = await db
        .from("strategy_return_publication_audit_c")
        .select("as_of_date, complete_value_cents, composition_effective_from, chain_factor, ytd_pct")
        .eq("strategy_id", s.id)
        .order("as_of_date", { ascending: false })
        .limit(1);
      const prev = prevRes.data?.[0] as
        | {
            as_of_date: string;
            complete_value_cents: number;
            composition_effective_from: string;
            chain_factor: number;
            ytd_pct: number;
          }
        | undefined;

      if (prev && String(prev.as_of_date) === String(asOf)) {
        results.push({ strategy: s.name, action: "skip", reason: "already published today" });
        skipped += 1;
        continue;
      }

      const compEffFrom = composition.effective_from;

      if (prev && String(prev.composition_effective_from) !== String(compEffFrom)) {
        results.push({
          strategy: s.name,
          action: "skip",
          reason: `unsealed composition boundary: ${prev.composition_effective_from} -> ${compEffFrom}`,
        });
        skipped += 1;
        continue;
      }

      let chainFactor: number;
      let ytd: number;
      let oneDayPct: number | null = null;
      let mode: string;

      if (prev) {
        const prevComplete = Number(prev.complete_value_cents);
        oneDayPct = ((completeCents - prevComplete) / prevComplete) * 100;
        chainFactor = Number(prev.chain_factor) * (1 + oneDayPct / 100);
        ytd = (chainFactor - 1) * 100;
        mode = "chain";
      } else {
        const seed = await seedYtd(db, s.id);
        ytd = seed.ytd;
        chainFactor = 1 + ytd / 100;
        mode = `seed:${seed.src}`;
      }

      if (apply) {
        const rpc = await db.rpc("publish_guarded_strategy_return", {
          p_strategy_id: s.id,
          p_as_of_date: asOf,
          p_source_run_id: null,
          p_securities_value_cents: Math.round(securitiesCents),
          p_continuity_cash_cents: continuityCents,
          p_complete_value_cents: completeCents,
          p_covered_holdings: holds.length,
          p_expected_holdings: holds.length,
          p_freshest_price_at: oldestUsedPriceAt,
          p_composition_effective_from: compEffFrom,
          p_holdings_snapshot: holds,
          p_boundary_bridge_pct: null,
          p_chain_factor: chainFactor,
          p_ytd_pct: ytd,
          p_checks: {
            source: "oem_eod_cron",
            mode,
            price_sources: [...sources].sort(),
            price_timestamp_is_oldest_used: true,
            composition_source: "strategy_composition_log_c",
          },
        });
        if (rpc.error) throw new Error(rpc.error.message);
      }

      results.push({
        strategy: s.name,
        action: apply ? "published" : "plan",
        mode,
        completeCents,
        ytdPct: Number(ytd.toFixed(6)),
        oneDayPct: oneDayPct == null ? null : Number(oneDayPct.toFixed(6)),
      });
      published += 1;
    } catch (err) {
      results.push({
        strategy: s.name,
        action: "failed",
        error: err instanceof Error ? err.message : String(err),
      });
      failed += 1;
    }
  }

  return {
    ok: true,
    asOf,
    apply,
    summary: { published, skipped, failed, total: strategies.length },
    results,
  };
}
