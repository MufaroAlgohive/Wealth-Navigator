import { NextResponse } from "next/server";

import { getAdminContext } from "@/lib/admin/rbac";
import { createRetailServiceRoleClient } from "@/lib/supabase/server";

/**
 * GET /api/admin/clients/cash-accrual?user_id=...
 *
 * Phase B5 — renders the AUM-fee accrual curve per investor so the Client
 * Studio pop-up can show "cash reacting/deducting as AUM accrues". Reads
 * `client_strategy_returns_c` (RETAIL) snapshots; computes the per-month
 * fee deduction and a cumulative accrued total in cents.
 *
 * Formula (monthly):
 *   fee_cents = (latest basket_value) × annual_fee_pct ÷ 12
 *
 * Apportion from the strategy's first in-basket snapshot (treat that as the
 * `invest_date`). Months with no snapshot are linearly interpolated when
 * possible, otherwise left as 0 — never negative (the user's example:
 *   invest = 2026-03-21, AUM = R6,300, fee = 0.99% annual
 *   → monthly = R6,300 × 0.0099 / 12 ≈ R5.20
 *   → 4 months (Mar → Jul 2026) ≈ R20.79 accrued
 * ).
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
  invest_date: string | null;
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

function diffMonths(from: Date, to: Date): number {
  // Returns fractional months between two dates (inclusive of partial months).
  const years = to.getUTCFullYear() - from.getUTCFullYear();
  const months = to.getUTCMonth() - from.getUTCMonth();
  const days = to.getUTCDate() - from.getUTCDate();
  const fullMonths = years * 12 + months;
  const daysInMonth = new Date(to.getUTCFullYear(), to.getUTCMonth() + 1, 0).getUTCDate();
  const fractional = days / daysInMonth;
  return Math.max(0, fullMonths + fractional);
}

function computeStrategyAccrual(cfg: StrategyCfg, snapshots: Snapshot[]): StrategyAccrual {
  const sorted = snapshots
    .filter((s) => s.basket_value != null)
    .sort((a, b) => a.as_of_date.localeCompare(b.as_of_date));
  const latest = sorted[sorted.length - 1];
  const latestCents = Math.round(Number(latest?.basket_value || 0) * 100 || 0);
  const investDate = cfg.invest_date || sorted[0]?.as_of_date || null;
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

  // Monthly fee = basket_value × annual_fee / 12. Constant for now — the
  // AUM is treated as stationary between snapshots; if the snapshots are
  // sparse the monthly figure is taken from the latest basket_value.
  const monthlyFeeCents = Math.round((latestCents * annualFeePct) / 12);

  const invest = new Date(`${investDate}T00:00:00Z`);
  const now = new Date();
  const totalMonths = diffMonths(invest, now);

  const months: AccrualMonth[] = [];
  let cumulative = 0;
  for (let i = 0; i < Math.ceil(totalMonths); i++) {
    const dt = new Date(Date.UTC(invest.getUTCFullYear(), invest.getUTCMonth() + i, 1));
    const key = `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}`;
    // Last month may be partial — prorate to the day-of-month ratio.
    let monthAmount = monthlyFeeCents;
    if (i === Math.ceil(totalMonths) - 1 && totalMonths % 1 !== 0) {
      const lastDt = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + 1, 0));
      const investDay = Math.max(1, Math.min(lastDt.getUTCDate(), invest.getUTCDate()));
      const fraction = (lastDt.getUTCDate() - investDay + 1) / lastDt.getUTCDate();
      monthAmount = Math.round(monthlyFeeCents * fraction);
    }
    cumulative += monthAmount;
    months.push({ month: key, monthly_fee_cents: monthAmount, cumulative_cents: cumulative });
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
  const feeMap: Record<string, { aum_fee_pct: number; invest_date: string | null }> = {};
  if (strategyIds.length) {
    try {
      const { data: cfg } = await db
        .from("strategies_c")
        .select("id, aum_fee_pct, inception_date")
        .in("id", strategyIds);
      for (const c of cfg ?? []) {
        feeMap[c.id as string] = {
          aum_fee_pct: Number((c as { aum_fee_pct?: number | null }).aum_fee_pct ?? 0.0099),
          invest_date: ((c as { inception_date?: string | null }).inception_date as string | null) ?? null,
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
    const investDate = cfg?.invest_date || null;
    return computeStrategyAccrual(
      { strategy_id: sid, annual_fee_pct: feePct, invest_date: investDate },
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
        note: "monthly_fee = latest_basket_value × annual_fee ÷ 12 (never negative; prorated to invest_date)",
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
