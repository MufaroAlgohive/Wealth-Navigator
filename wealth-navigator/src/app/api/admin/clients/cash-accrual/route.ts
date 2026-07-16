import { NextResponse } from "next/server";

import { getAdminContext } from "@/lib/admin/rbac";
import { createRetailServiceRoleClient } from "@/lib/supabase/server";

/**
 * GET /api/admin/clients/cash-accrual?user_id=...
 *
 * Phase B5 - renders the AUM-fee accrual curve per investor so the Client
 * Studio pop-up can show "cash reacting/deducting as AUM accrues". Reads
 * `client_strategy_returns_c` (RETAIL) snapshots; computes the per-month
 * fee deduction and a cumulative accrued total in cents.
 *
 * Formula (monthly):
 *   fee_cents = applicable_month_end_basket_cents * annual_fee_pct / 12
 *
 * Apportion from the client's first in-basket snapshot (the `invest_date`).
 * The first and current months are day-prorated; sparse months carry forward
 * the latest snapshot known by that month end and never produce negatives.
 *   invest = 2026-03-21, AUM = R6,300, fee = 0.99% annual
 *   monthly = R6,300 * 0.0099 / 12, approximately R5.20
 *   March is day-prorated; subsequent months use their applicable basket value.
 *
 * Per strategy so a client with 3 strategies sees 3 series; for the Studio
 * pop-up we sum the latest snapshot totals.
 */

export const dynamic = "force-dynamic";

interface Snapshot {
  user_id: string;
  strategy_id: string;
  as_of_date: string;
  basket_value: number | string | null;
}

interface StrategyCfg {
  strategy_id: string;
  annual_fee_pct: number;
}

interface AccrualMonth {
  month: string; // YYYY-MM
  monthly_fee_cents: number;
  cumulative_cents: number;
}

interface StrategyAccrual {
  strategy_id: string;
  annual_fee_pct: number;
  invest_date: string | null;
  latest_basket_value_cents: number;
  months: AccrualMonth[];
  total_accrued_cents: number;
}

function monthKey(iso: string): string {
  return iso.slice(0, 7);
}

export function computeStrategyAccrual(cfg: StrategyCfg, snapshots: Snapshot[], asAt = new Date()): StrategyAccrual {
  const sorted = snapshots
    .filter((s) => s.basket_value != null)
    .sort((a, b) => a.as_of_date.localeCompare(b.as_of_date));
  const latest = sorted[sorted.length - 1];
  // basket_value is already integer cents. Multiplying it by 100 here was the
  // source of the exact 100x cash-accrual inflation.
  const latestCents = Math.round(Number(latest?.basket_value || 0) || 0);
  // A client's fee clock starts at their first strategy snapshot, not at the
  // strategy's global inception date.
  const investDate = sorted[0]?.as_of_date || null;
  const annualFeePct = cfg.annual_fee_pct;

  if (latestCents === 0 || annualFeePct === 0 || !investDate) {
    return {
      strategy_id: cfg.strategy_id,
      annual_fee_pct: annualFeePct,
      invest_date: investDate,
      latest_basket_value_cents: latestCents,
      months: [],
      total_accrued_cents: 0,
    };
  }

  // Month-end AUM varies through the history; the first and current months are
  // prorated to the exact number of active calendar days.

  const invest = new Date(`${investDate}T00:00:00Z`);
  const now = new Date(asAt);
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

  const months: AccrualMonth[] = [];
  let cumulative = 0;
  for (
    let monthStart = new Date(Date.UTC(invest.getUTCFullYear(), invest.getUTCMonth(), 1));
    monthStart <= end;
    monthStart = new Date(Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth() + 1, 1))
  ) {
    const monthEnd = new Date(Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth() + 1, 0));
    // Last month may be partial, so prorate to the day-of-month ratio.
    const activeStart = invest > monthStart ? invest : monthStart;
    const activeEnd = end < monthEnd ? end : monthEnd;
    if (activeStart > activeEnd) continue;
    const effectiveIso = activeEnd.toISOString().slice(0, 10);
    const applicable = sorted.filter((snapshot) => snapshot.as_of_date <= effectiveIso).at(-1);
    const basketCents = Math.round(Number(applicable?.basket_value || 0) || 0);
    const daysInMonth = monthEnd.getUTCDate();
    const activeDays = Math.floor((activeEnd.getTime() - activeStart.getTime()) / 86_400_000) + 1;
    const activeFraction = Math.max(0, Math.min(1, activeDays / daysInMonth));
    const monthAmount = Math.round((basketCents * annualFeePct * activeFraction) / 12);
    cumulative += monthAmount;
    months.push({ month: monthKey(monthStart.toISOString()), monthly_fee_cents: monthAmount, cumulative_cents: cumulative });
  }

  return {
    strategy_id: cfg.strategy_id,
    annual_fee_pct: annualFeePct,
    invest_date: investDate,
    latest_basket_value_cents: latestCents,
    months,
    total_accrued_cents: cumulative,
  };
}

export async function GET(req: Request) {
  const auth = await getAdminContext();
  if (auth.status === "no-session")
    return NextResponse.json({ ok: false, error: "no-session" }, { status: 401 });
  if (auth.status !== "ok") return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });

  const userId = new URL(req.url).searchParams.get("user_id") || "";
  if (!userId) return NextResponse.json({ ok: false, error: "user_id required" }, { status: 400 });

  let db: ReturnType<typeof createRetailServiceRoleClient> | null = null;
  try {
    db = createRetailServiceRoleClient();
  } catch {
    return NextResponse.json({ ok: false, error: "RETAIL database not configured" }, { status: 503 });
  }

  const { data: snapshots } = await db
    .from("client_strategy_returns_c")
    .select("user_id, strategy_id, as_of_date, basket_value")
    .eq("user_id", userId)
    .order("as_of_date", { ascending: true });

  // Fee configuration lives on strategies_c.aum_fee_pct (annual). Falls back
  // to the canonical 0.99% per the user's spec example.
  const strategyIds = [...new Set(((snapshots ?? []) as Snapshot[]).map((s) => s.strategy_id))];
  const feeMap: Record<string, { aum_fee_pct: number }> = {};
  if (strategyIds.length) {
    try {
      const { data: cfg } = await db
        .from("strategies_c")
        .select("id, aum_fee_pct")
        .in("id", strategyIds);
      for (const c of cfg ?? []) {
        feeMap[c.id as string] = {
          aum_fee_pct: Number((c as { aum_fee_pct?: number | null }).aum_fee_pct ?? 0.0099),
        };
      }
    } catch {
      /* strategies_c columns may not exist; the per-strategy entry falls back to defaults */
    }
  }
  // Bucket snapshots by strategy.
  const byStrategy: Record<string, Snapshot[]> = {};
  for (const s of (snapshots ?? []) as Snapshot[]) {
    if (!byStrategy[s.strategy_id]) byStrategy[s.strategy_id] = [];
    byStrategy[s.strategy_id]?.push(s);
  }

  const accruals: StrategyAccrual[] = strategyIds.map((sid) => {
    const cfg = feeMap[sid];
    const feePct = cfg?.aum_fee_pct ?? 0.0099;
    return computeStrategyAccrual(
      { strategy_id: sid, annual_fee_pct: feePct },
      byStrategy[sid] || [],
    );
  });

  const combined = {
    total_accrued_cents: accruals.reduce((acc, s) => acc + s.total_accrued_cents, 0),
    latest_basket_value_cents: accruals.reduce((acc, s) => acc + s.latest_basket_value_cents, 0),
    months: aggregateMonths(accruals),
  };

  return NextResponse.json({
    ok: true,
    user_id: userId,
    strategies: accruals,
    combined,
    // Echo the formula inputs so the client can sanity-check the pop-up.
    formula: (() => {
      const first = accruals[0];
      return {
        monthly_fee_cents:
          accruals.length === 1 && first
            ? Math.round((first.latest_basket_value_cents * first.annual_fee_pct) / 12)
            : null,
        annual_fee_default: 0.0099,
        note: "monthly_fee = applicable monthly basket cents * annual fee / 12; first and current months are day-prorated",
      };
    })(),
  });
}

function aggregateMonths(accruals: StrategyAccrual[]): AccrualMonth[] {
  if (accruals.length === 0) return [];
  const monthMap = new Map<string, { fee: number; cum: number; prev: number | null }>();
  let cumulativeTotal = 0;
  // Sort months across all strategies, then re-cumulate across the union.
  const allMonths = [...new Set(accruals.flatMap((a) => a.months.map((m) => m.month)))].sort();
  for (const m of allMonths) {
    const monthFee = accruals.reduce(
      (acc, a) => acc + (a.months.find((mm) => mm.month === m)?.monthly_fee_cents || 0),
      0,
    );
    cumulativeTotal += monthFee;
    monthMap.set(m, { fee: monthFee, cum: cumulativeTotal, prev: null });
  }
  return [...monthMap.entries()].map(([month, v]) => ({
    month,
    monthly_fee_cents: v.fee,
    cumulative_cents: v.cum,
  }));
}
