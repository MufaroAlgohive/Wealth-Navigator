/**
 * GET /api/strategies/returns
 *
 * Per-strategy daily NAV series from the canonical
 * `strategy_returns_effective_c` view (guarded publication > promoted repair
 * shadow > legacy nightly, per date — the same single read contract the CRM
 * and retail app use), plus a JSE All Share (J203) daily benchmark aligned to
 * the same date range, for the cockpit "Strategies" performance view. The
 * client rebases every series to 100 on a common start date, so the raw
 * basket_value unit is moot. Previously read the legacy `strategies_returns_c`
 * table directly, which does not include repaired history or the guarded
 * daily publications that keep YTD chain-preserved across rebalances.
 *
 * The J203 daily series comes from Yahoo `^J203.JO` (the IRESS index feed is
 * entitlement-blocked); it is fetched for the exact window the strategy data
 * covers via period1/period2.
 *
 * Strategy performance is sensitive business data: middleware blocks this path
 * for restricted external accounts (see src/lib/platform/access.ts), and the
 * cockpit hides the toggle for them too.
 */
import { createRetailServiceRoleClient, isRetailSupabaseConfigured } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Pt {
  t: number;
  v: number;
}
interface SeriesOut {
  id: string;
  name: string;
  points: Pt[];
}

const DAY_MS = 86_400_000;

/** Yahoo `^J203.JO` daily closes for [fromMs, toMs] → `{ t, v }` points. */
async function fetchJ203Daily(fromMs: number, toMs: number): Promise<Pt[]> {
  const p1 = Math.floor(fromMs / 1000) - 4 * 86_400; // pad so the first strategy date has a benchmark
  const p2 = Math.floor(toMs / 1000) + 4 * 86_400;
  try {
    const r = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/%5EJ203.JO?period1=${p1}&period2=${p2}&interval=1d`,
      { headers: { "User-Agent": "Mozilla/5.0" }, cache: "no-store" },
    );
    if (!r.ok) return [];
    const j = (await r.json()) as {
      chart?: {
        result?: Array<{
          timestamp?: number[];
          indicators?: { quote?: Array<{ close?: Array<number | null> }> };
        }>;
      };
    };
    const res = j.chart?.result?.[0];
    const ts = res?.timestamp ?? [];
    const cl = res?.indicators?.quote?.[0]?.close ?? [];
    const out: Pt[] = [];
    for (let i = 0; i < ts.length; i += 1) {
      const t = ts[i];
      const c = cl[i];
      if (t != null && c != null && Number.isFinite(c)) out.push({ t: t * 1000, v: c });
    }
    return out;
  } catch {
    return [];
  }
}

export async function GET() {
  if (!isRetailSupabaseConfigured()) {
    return Response.json({ source: "unavailable", range: null, benchmark: null, strategies: [] });
  }
  const db = createRetailServiceRoleClient();
  const [returnsRes, stratRes, certifiedRes] = await Promise.all([
    db
      .from("strategy_returns_effective_c")
      .select("strategy_id, as_of_date, basket_value_cents")
      .order("as_of_date", { ascending: true })
      .limit(6000),
    db.from("strategies_c").select("id, name, investor_environment"),
    // CERTIFIED canonical ledger. Plotting raw basket_value_cents directly
    // (as the fallback above does) reproduces the exact "rebalance cliff"
    // this whole certification programme exists to remove -- a rebalance can
    // legitimately drop raw basket value while true performance is
    // continuous. Per strategy with certified history, this endpoint now
    // replaces the WHOLE series with an index built from the certified SI
    // (since-inception) return_pct at each date -- 100 * (1 + SI/100) --
    // which is leg-P&L continuity-preserving by construction (same
    // methodology independently hand-verified against Yahoo and by manual
    // reconstruction of Yield Basket's YTD figure). Verified: every
    // certified strategy's canonical history already spans its full
    // existing basket_value_cents range from actual inception, so no
    // splicing between a pre-certification and certified segment is needed.
    db
      .from("strategy_canonical_daily_ledger_c")
      .select("strategy_id, as_of_date, period_metrics")
      .eq("certification_status", "CERTIFIED")
      .order("as_of_date", { ascending: true })
      .limit(6000),
  ]);
  if (returnsRes.error) {
    return Response.json(
      {
        source: "unavailable",
        error: returnsRes.error.message,
        range: null,
        benchmark: null,
        strategies: [],
      },
      { status: 200 },
    );
  }

  // UAT/test strategies never appear on this chart. `/api/strategies` already
  // hides them from the catalogue for non-dev viewers, but this performance
  // series is a separate read and was plotting every strategy — so a test
  // basket (and its deliberately unrealistic return line) showed up on the
  // cockpit's Strategies view. A strategy left out of `nameById` is skipped
  // below, so omitting it here is enough.
  const nameById = new Map<string, string>();
  for (const s of (stratRes.data ?? []) as Array<{
    id: string;
    name: string | null;
    investor_environment: string | null;
  }>) {
    if (String(s.investor_environment ?? "LIVE").toUpperCase() === "UAT") continue;
    if (s.name) nameById.set(s.id, s.name);
  }

  const bySid = new Map<string, Pt[]>();
  let minT = Number.POSITIVE_INFINITY;
  let maxT = Number.NEGATIVE_INFINITY;
  for (const r of (returnsRes.data ?? []) as Array<{
    strategy_id: string;
    as_of_date: string | null;
    basket_value_cents: number | string | null;
  }>) {
    if (!r.strategy_id || !r.as_of_date || r.basket_value_cents == null) continue;
    const v = Number(r.basket_value_cents);
    const t = new Date(r.as_of_date).getTime();
    if (!Number.isFinite(v) || v <= 0 || !Number.isFinite(t)) continue;
    let arr = bySid.get(r.strategy_id);
    if (!arr) {
      arr = [];
      bySid.set(r.strategy_id, arr);
    }
    arr.push({ t, v });
    if (t < minT) minT = t;
    if (t > maxT) maxT = t;
  }

  // Certified index per strategy: 100 * (1 + SI_return_pct / 100) at each
  // certified date. Only strategies with at least 2 certified points get the
  // index treatment below; anything else keeps the raw basket_value fallback.
  const certifiedPtsBySid = new Map<string, Pt[]>();
  for (const r of (certifiedRes.data ?? []) as Array<{
    strategy_id: string;
    as_of_date: string | null;
    period_metrics: Record<string, { return_pct?: number | null }> | null;
  }>) {
    if (!r.strategy_id || !r.as_of_date) continue;
    const siPct = r.period_metrics?.SI?.return_pct;
    if (siPct == null || !Number.isFinite(Number(siPct))) continue;
    const t = new Date(r.as_of_date).getTime();
    if (!Number.isFinite(t)) continue;
    let arr = certifiedPtsBySid.get(r.strategy_id);
    if (!arr) {
      arr = [];
      certifiedPtsBySid.set(r.strategy_id, arr);
    }
    arr.push({ t, v: 100 * (1 + Number(siPct) / 100) });
  }

  const strategies: SeriesOut[] = [];
  for (const [sid, pts] of bySid) {
    const name = nameById.get(sid);
    if (!name || pts.length < 2) continue;
    const certifiedPts = certifiedPtsBySid.get(sid);
    strategies.push({ id: sid, name, points: certifiedPts && certifiedPts.length >= 2 ? certifiedPts : pts });
  }
  strategies.sort((a, b) => a.name.localeCompare(b.name));

  let benchmark: { code: string; name: string; points: Pt[] } | null = null;
  let range: { from: string; to: string } | null = null;
  if (strategies.length > 0 && Number.isFinite(minT) && Number.isFinite(maxT)) {
    benchmark = { code: "J203", name: "JSE All Share", points: await fetchJ203Daily(minT, maxT) };
    range = {
      from: new Date(minT).toISOString().slice(0, 10),
      to: new Date(maxT + DAY_MS).toISOString().slice(0, 10),
    };
  }

  return Response.json({ source: "retail-supabase", range, benchmark, strategies });
}
