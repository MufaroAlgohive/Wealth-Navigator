import { NextResponse } from "next/server";

import { getAdminContext } from "@/lib/admin/rbac";
import { callWorker } from "@/lib/iress/worker-api";
import { createInstitutionalServiceRoleClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/models/[id]/benchmark
 *
 * Builds a normalised paper-vs-benchmark bundle for the model detail live demo:
 *   - the model's `paper` equity curve from `model_equity_point_c` (richest label)
 *   - aligned daily benchmark closes from STX40.JO (JSE Top 40 ETF proxy),
 *     preferring the worker's IRESS `TimeSeriesGet2` passthrough and falling back
 *     to a direct Yahoo fetch (matches the /api/history provider-switch rule)
 *   - derived alpha, beta, info ratio, tracking error, up/down capture, max DD
 *
 * Response is honest: when IRESS returns empty / entitlement-faults and Yahoo
 * also fails, we surface `benchmark: { points: [], source: "unavailable" }` so
 * the UI shows the "ask Charles" empty state instead of a fabricated line.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id: slug } = await ctx.params;
  const auth = await getAdminContext();
  if (auth.status === "no-session") {
    return NextResponse.json({ ok: false, error: "no-session" }, { status: 401 });
  }
  if (auth.status !== "ok") {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  const db = createInstitutionalServiceRoleClient();
  const { data: model, error: modelErr } = await db
    .from("model_registry_c")
    .select("slug, currency, benchmark")
    .eq("slug", slug)
    .maybeSingle();
  if (modelErr || !model) {
    return NextResponse.json({ ok: false, error: "model not found" }, { status: 404 });
  }

  // ── paper equity curve (richest label within kind='paper' or 'live') ────────
  const { data: points } = await db
    .from("model_equity_point_c")
    .select("ts, equity, day_pnl, day_pnl_pct, cash, label, kind")
    .eq("model_slug", slug)
    .in("kind", ["paper", "live"])
    .order("ts", { ascending: true })
    .limit(4000);

  const paperRows = (points ?? []).filter(
    (p) => typeof p.equity === "number" && Number.isFinite(p.equity),
  );
  const paper = paperRows.map((p) => ({
    ts: String(p.ts),
    date: String(p.ts).slice(0, 10),
    equity: Number(p.equity),
    day_pnl: typeof p.day_pnl === "number" ? Number(p.day_pnl) : null,
    day_pnl_pct: typeof p.day_pnl_pct === "number" ? Number(p.day_pnl_pct) : null,
    cash: typeof p.cash === "number" ? Number(p.cash) : null,
  }));

  // ── benchmark symbol — STX40.JO is the strategy's stated benchmark; fall
  //    through to ^J203.JO (JSE All Share) if STX40 isn't reachable on IRESS.
  const benchmarkSymbol = "STX40";
  let benchmark:
    | {
        code: string;
        name: string;
        currency: string;
        source: "iress" | "yahoo";
        points: Array<{ ts: string; date: string; v: number }>;
      }
    | { code: string; name: string; source: "unavailable"; reason: string; points: [] }
    | null = null;

  if (paper.length < 2) {
    benchmark = {
      code: benchmarkSymbol,
      name: "Satrix 40 (JSE Top 40 ETF)",
      source: "unavailable",
      reason: "Paper curve has fewer than 2 daily points — nothing to benchmark against yet.",
      points: [],
    };
  } else {
    const fromMs = new Date(paper[0]!.ts).getTime();
    const toMs = new Date(paper[paper.length - 1]!.ts).getTime();
    const days = Math.max(60, Math.ceil((toMs - fromMs) / 86_400_000) + 8);
    const frequency = days > 400 ? "Monthly" : "Daily";

    let iressPoints: Array<{ t: number; v: number }> = [];
    let iressErr: string | null = null;
    const workerRes = await callWorker<{
      ok: boolean;
      sym: string;
      points?: Array<{ t: number; v: number }>;
      error?: string;
    }>({
      path: `/history?sym=${encodeURIComponent(benchmarkSymbol)}&days=${days}&exchange=JSE&frequency=${frequency}`,
      timeoutMs: 20_000,
    });
    if (workerRes.ok && workerRes.body?.ok) {
      iressPoints = (workerRes.body.points ?? [])
        .filter((p) => p && Number.isFinite(p.t) && Number.isFinite(p.v) && p.v > 0)
        .map((p) => ({ t: p.t, v: p.v }));
    } else {
      iressErr = workerRes.ok ? workerRes.body?.error ?? "no series" : workerRes.error ?? "unreachable";
    }

    let chosen: { source: "iress" | "yahoo"; points: Array<{ ts: string; date: string; v: number }> } | null = null;
    if (iressPoints.length >= 2) {
      chosen = {
        source: "iress",
        points: iressPoints.map((p) => ({
          ts: new Date(p.t).toISOString(),
          date: new Date(p.t).toISOString().slice(0, 10),
          v: p.v,
        })),
      };
    } else {
      // Yahoo fallback — direct chart fetch (mirrors /api/indices/[code] pattern).
      const yPoints = await fetchYahooDaily(benchmarkSymbol, days);
      if (yPoints.length >= 2) {
        chosen = { source: "yahoo", points: yPoints };
      }
    }

    if (chosen && chosen.points.length >= 2) {
      benchmark = {
        code: benchmarkSymbol,
        name: "Satrix 40 (JSE Top 40 ETF)",
        currency: "ZAR",
        source: chosen.source,
        points: chosen.points,
      };
    } else {
      benchmark = {
        code: benchmarkSymbol,
        name: "Satrix 40 (JSE Top 40 ETF)",
        source: "unavailable",
        reason:
          "STX40.JO history unreachable via IRESS TimeSeriesGet2 and Yahoo direct. " +
          (iressErr ? `IRESS: ${iressErr}.` : ""),
        points: [],
      };
    }
  }

  // ── align + derive summary stats ────────────────────────────────────────────
  const summary = computeSummary(paper, benchmark && "points" in benchmark ? benchmark.points : []);

  return NextResponse.json({
    ok: true,
    model: { slug: model.slug, currency: model.currency ?? "ZAR" },
    paper,
    benchmark,
    summary,
    asOf: new Date().toISOString(),
  });
}

// ─── helpers ────────────────────────────────────────────────────────────────

const UA = "Mozilla/5.0";

async function fetchYahooDaily(symbol: string, days: number): Promise<Array<{ ts: string; date: string; v: number }>> {
  const yahooSym = symbol.includes(".JO") ? symbol : `${symbol}.JO`;
  // Yahoo daily range cap is ~730d; for longer windows switch to monthly.
  const range = days > 730 ? "5y" : days > 90 ? "6mo" : "1mo";
  const interval = days > 730 ? "1mo" : "1d";
  try {
    const r = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSym)}?range=${range}&interval=${interval}`,
      { headers: { "User-Agent": UA }, cache: "no-store" },
    );
    if (!r.ok) return [];
    const j = (await r.json()) as {
      chart?: { result?: Array<{ timestamp?: number[]; indicators?: { quote?: Array<{ close?: Array<number | null> }> } }> };
    };
    const res = j.chart?.result?.[0];
    const ts = res?.timestamp ?? [];
    const closes = res?.indicators?.quote?.[0]?.close ?? [];
    const out: Array<{ ts: string; date: string; v: number }> = [];
    for (let i = 0; i < ts.length; i += 1) {
      const t = ts[i];
      const c = closes[i];
      if (t != null && typeof c === "number" && Number.isFinite(c) && c > 0) {
        const iso = new Date(t * 1000).toISOString();
        out.push({ ts: iso, date: iso.slice(0, 10), v: c });
      }
    }
    return out;
  } catch {
    return [];
  }
}

interface PaperPoint {
  ts: string;
  date: string;
  equity: number;
  day_pnl: number | null;
  day_pnl_pct: number | null;
  cash: number | null;
}
interface BenchPoint {
  ts: string;
  date: string;
  v: number;
}

interface Summary {
  days: number;
  from: string | null;
  to: string | null;
  paperReturn: number | null; // total return over window
  benchReturn: number | null;
  alpha: number | null; // paperReturn - benchReturn
  beta: number | null; // covariance / variance of daily returns
  trackingError: number | null; // stdev of (paper_daily - bench_daily), annualised
  infoRatio: number | null; // alpha / trackingError (annualised)
  upCapture: number | null; // paper return on up-bench days / bench return
  downCapture: number | null; // paper return on down-bench days / bench return
  maxDrawdown: number | null; // peak-to-trough on paper
  maxDrawdownBench: number | null; // same on benchmark
  alignedDays: number;
  startEquity: number | null;
  endEquity: number | null;
}

function computeSummary(paper: PaperPoint[], bench: BenchPoint[]): Summary {
  const empty: Summary = {
    days: 0,
    from: null,
    to: null,
    paperReturn: null,
    benchReturn: null,
    alpha: null,
    beta: null,
    trackingError: null,
    infoRatio: null,
    upCapture: null,
    downCapture: null,
    maxDrawdown: null,
    maxDrawdownBench: null,
    alignedDays: 0,
    startEquity: null,
    endEquity: null,
  };
  if (paper.length < 2) return empty;

  const startEquity = paper[0]!.equity;
  const endEquity = paper[paper.length - 1]!.equity;
  const paperReturn = startEquity > 0 ? endEquity / startEquity - 1 : null;

  const maxDD = maxDrawdown(paper.map((p) => p.equity));

  let benchReturn: number | null = null;
  let maxDDBench: number | null = null;
  let alpha: number | null = null;
  let beta: number | null = null;
  let te: number | null = null;
  let ir: number | null = null;
  let upCap: number | null = null;
  let downCap: number | null = null;
  let aligned = 0;

  if (bench.length >= 2) {
    const benchByDate = new Map(bench.map((b) => [b.date, b.v]));
    const benchAligned: number[] = [];
    const paperAligned: number[] = [];
    for (let i = 1; i < paper.length; i += 1) {
      const a = paper[i - 1]!;
      const b = paper[i]!;
      const bv = benchByDate.get(b.date) ?? benchByDate.get(a.date);
      if (bv == null) continue;
      const bvPrev = benchByDate.get(a.date);
      if (bvPrev == null || bvPrev <= 0) continue;
      benchAligned.push(bv / bvPrev - 1);
      paperAligned.push(b.equity / a.equity - 1);
      aligned += 1;
    }

    if (aligned >= 2) {
      const benchFirst = bench.find((b) => b.date >= paper[0]!.date)?.v ?? bench[0]!.v;
      const benchLast = bench[bench.length - 1]!.v;
      benchReturn = benchFirst > 0 ? benchLast / benchFirst - 1 : null;
      maxDDBench = maxDrawdown(bench.map((b) => b.v));

      if (paperReturn != null && benchReturn != null) alpha = paperReturn - benchReturn;

      const mean = (xs: number[]) => xs.reduce((s, v) => s + v, 0) / xs.length;
      const cov = mean(paperAligned.map((p, i) => (p - mean(paperAligned)) * (benchAligned[i]! - mean(benchAligned))));
      const varB = mean(benchAligned.map((b) => (b - mean(benchAligned)) ** 2));
      beta = varB > 0 ? cov / varB : null;

      const diffs = paperAligned.map((p, i) => p - benchAligned[i]!);
      const diffStd = stddev(diffs);
      te = diffStd * Math.sqrt(252);
      ir = te != null && te > 0 && alpha != null ? (alpha * Math.sqrt(252)) / te : null;

      let upPaper = 0;
      let upBench = 0;
      let downPaper = 0;
      let downBench = 0;
      for (let i = 0; i < aligned; i += 1) {
        const r = benchAligned[i]!;
        if (r >= 0) {
          upPaper += paperAligned[i]!;
          upBench += r;
        } else {
          downPaper += paperAligned[i]!;
          downBench += r;
        }
      }
      upCap = upBench !== 0 ? upPaper / upBench : null;
      downCap = downBench !== 0 ? downPaper / downBench : null;
    }
  }

  return {
    days: paper.length,
    from: paper[0]!.date,
    to: paper[paper.length - 1]!.date,
    paperReturn,
    benchReturn,
    alpha,
    beta,
    trackingError: te,
    infoRatio: ir,
    upCapture: upCap,
    downCapture: downCap,
    maxDrawdown: maxDD,
    maxDrawdownBench: maxDDBench,
    alignedDays: aligned,
    startEquity,
    endEquity,
  };
}

function maxDrawdown(xs: number[]): number | null {
  if (xs.length < 2) return null;
  let peak = xs[0]!;
  let maxDd = 0;
  for (const x of xs) {
    if (x > peak) peak = x;
    const dd = peak > 0 ? x / peak - 1 : 0;
    if (dd < maxDd) maxDd = dd;
  }
  return maxDd;
}

function stddev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = xs.reduce((s, v) => s + v, 0) / xs.length;
  const v = xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(v);
}