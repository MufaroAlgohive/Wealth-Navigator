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
      chart?: { result?: Array<{ timestamp?: number[]; indicators?: { quote?: Array<{ close?: Array<number | null> }> } }> };
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
  const [returnsRes, stratRes] = await Promise.all([
    db
      .from("strategy_returns_effective_c")
      .select("strategy_id, as_of_date, basket_value_cents")
      .order("as_of_date", { ascending: true })
      .limit(6000),
    db.from("strategies_c").select("id, name"),
  ]);
  if (returnsRes.error) {
    return Response.json(
      { source: "unavailable", error: returnsRes.error.message, range: null, benchmark: null, strategies: [] },
      { status: 200 },
    );
  }

  const nameById = new Map<string, string>();
  for (const s of (stratRes.data ?? []) as Array<{ id: string; name: string | null }>) {
    if (s.name) nameById.set(s.id, s.name);
  }

  const bySid = new Map<string, Pt[]>();
  let minT = Infinity;
  let maxT = -Infinity;
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

  const strategies: SeriesOut[] = [];
  for (const [sid, pts] of bySid) {
    const name = nameById.get(sid);
    if (!name || pts.length < 2) continue;
    strategies.push({ id: sid, name, points: pts });
  }
  strategies.sort((a, b) => a.name.localeCompare(b.name));

  let benchmark: { code: string; name: string; points: Pt[] } | null = null;
  let range: { from: string; to: string } | null = null;
  if (strategies.length > 0 && Number.isFinite(minT) && Number.isFinite(maxT)) {
    benchmark = { code: "J203", name: "JSE All Share", points: await fetchJ203Daily(minT, maxT) };
    range = { from: new Date(minT).toISOString().slice(0, 10), to: new Date(maxT + DAY_MS).toISOString().slice(0, 10) };
  }

  return Response.json({ source: "retail-supabase", range, benchmark, strategies });
}
