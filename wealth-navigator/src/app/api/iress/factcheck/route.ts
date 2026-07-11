import { NextResponse } from "next/server";

import { getAdminContext } from "@/lib/admin/rbac";
import { callWorker } from "@/lib/iress/worker-api";
import { computeDivergence, iressFactcheckTolerance, iressDivergenceReject } from "@/lib/iress/overlay-policy";
import { createRetailServiceRoleClient } from "@/lib/supabase/server";

/**
 * GET /api/iress/factcheck
 *
 * Verifies the (paid) IRESS feed against the free Yahoo reference. For a set of
 * JSE symbols it takes the live IRESS quote from the worker's read-only
 * `/debug/coverage` probe (the worker holds the seat) and compares it to
 * `securities_c.last_price` (Yahoo, written by the yahoo-fundamentals cron).
 *
 * IMPORTANT unit handling: coverage returns the MAPPED `last` in rands (the
 * mapQuote scale heuristic already normalised the raw IRESS scale, which is
 * inconsistent per symbol), so it is multiplied by 100 to compare against the
 * Yahoo cents in `securities_c.last_price`. Using the raw IRESS LastPrice here
 * would mis-scale (e.g. SOL raw 176 is not cents).
 *
 * Read-only: touches NO customer/order data and writes nothing. Diagnostic.
 * The divergence is SYMMETRIC (Yahoo is ~15min delayed and has currency
 * collisions), so it is labelled "IRESS vs Yahoo mismatch", not "IRESS wrong".
 * During UAT the IRESS CT feed is TEST data, so large divergence is expected;
 * the value collapses toward ~0 once real production market data is enabled.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_SYMBOLS = [
  "AGL", "SOL", "NPN", "MTN", "FSR", "SBK", "BTI", "CFR", "PRX", "GLN",
  "SHP", "CPI", "ANG", "IMP", "GFI", "VOD", "REM", "CLS", "BVT", "WHL",
];

interface CoverageRow {
  symbol: string;
  iressCode: string;
  last: number | null;
  outcome: string;
}

export async function GET(req: Request) {
  const auth = await getAdminContext();
  if (auth.status === "no-session") {
    return NextResponse.json({ ok: false, error: "no-session" }, { status: 401 });
  }
  if (auth.status !== "ok") {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  const url = new URL(req.url);
  const symParam = url.searchParams.get("symbols");
  const bare = (symParam ? symParam.split(",") : DEFAULT_SYMBOLS)
    .map((s) => s.trim().toUpperCase().replace(/\.(JO|JSE)$/i, ""))
    .filter(Boolean)
    .slice(0, 80);
  if (bare.length === 0) {
    return NextResponse.json({ ok: false, error: "no symbols" }, { status: 400 });
  }
  const jo = bare.map((s) => `${s}.JO`);

  // Yahoo reference (cents) from securities_c.
  let yahooBy = new Map<string, number>();
  try {
    const retail = createRetailServiceRoleClient();
    const { data, error } = await retail
      .from("securities_c")
      .select("symbol,last_price")
      .in("symbol", jo);
    if (error) {
      return NextResponse.json({ ok: false, error: `securities_c: ${error.message}` }, { status: 500 });
    }
    yahooBy = new Map(
      (data ?? []).map((s) => [String(s.symbol).replace(/\.(JO|JSE)$/i, ""), Number(s.last_price) || 0]),
    );
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: `RETAIL DB not configured: ${err instanceof Error ? err.message : String(err)}` },
      { status: 503 },
    );
  }

  // Live IRESS via the worker's read-only coverage probe (returns mapped `last` in rands).
  const cov = await callWorker<{ ok: boolean; rows: CoverageRow[] }>({
    method: "POST",
    path: "/debug/coverage",
    body: { symbols: jo, exchange: "JSE" },
    timeoutMs: 60_000,
  });
  if (!cov.ok) {
    return NextResponse.json(
      { ok: false, error: "worker coverage probe failed", detail: cov.error },
      { status: cov.status },
    );
  }
  const iressBy = new Map<string, number | null>(
    (cov.body.rows ?? []).map((r) => [r.iressCode.replace(/\.(JO|JSE)$/i, ""), r.last]),
  );

  const rows = bare.map((code) => {
    const iressLast = iressBy.get(code); // mapped, rands
    const yahooCents = yahooBy.get(code) ?? 0;
    const iressCents = iressLast != null && iressLast > 0 ? Math.round(iressLast * 100) : null;
    const d = iressCents != null ? computeDivergence(iressCents, yahooCents) : null;
    return {
      symbol: code,
      iressRands: iressCents != null ? iressCents / 100 : null,
      yahooRands: yahooCents > 0 ? yahooCents / 100 : null,
      divergencePct: d ? Number(d.pct.toFixed(2)) : null,
      severity: d ? d.severity : ("no-data" as const),
    };
  });

  const counts = { ok: 0, watch: 0, breach: 0, noData: 0 };
  for (const r of rows) {
    if (r.severity === "ok") counts.ok++;
    else if (r.severity === "watch") counts.watch++;
    else if (r.severity === "breach") counts.breach++;
    else counts.noData++;
  }
  const worstOffenders = rows
    .filter((r) => r.divergencePct != null)
    .sort((a, b) => (b.divergencePct ?? 0) - (a.divergencePct ?? 0))
    .slice(0, 10);

  return NextResponse.json({
    ok: true,
    generatedAt: new Date().toISOString(),
    note:
      "IRESS vs Yahoo mismatch (symmetric; Yahoo is ~15min delayed). During UAT the IRESS CT feed is TEST data, so large divergence is expected and collapses toward ~0 once real production market data is enabled.",
    tolerancePct: iressFactcheckTolerance() * 100,
    rejectPct: iressDivergenceReject() * 100,
    counts,
    worstOffenders,
    rows,
  });
}
