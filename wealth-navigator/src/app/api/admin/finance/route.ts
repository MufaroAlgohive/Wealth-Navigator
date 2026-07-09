import { NextResponse } from "next/server";

import { isAdminRole } from "@/lib/admin/pages";
import { getAdminContext } from "@/lib/admin/rbac";
import { createRetailServiceRoleClient } from "@/lib/supabase/server";
import { createInstitutionalServiceRoleClient } from "@/lib/supabase/server";

/**
 * GET /api/admin/finance
 *
 * Mint OEM Finalisation Phase C7 — placeholder Finance aggregation for
 * the `/admin/finance` tab. Reads:
 *
 *   - RETAIL `client_strategy_returns_c` → basket_value × strategy fee_pct
 *     to surface AUM fees (the same math `investors/data` uses internally).
 *   - INSTITUTIONAL `oems_order_audit.result_payload->dayOnePnlCents` →
 *     Day-1 P&L / slip totals across all filled orders.
 *
 * Returns money in **Rands** (cents ÷ 100) so the page renders
 * `R 1 234 567` straight, no client-side maths. The full Finance tab
 * spec from Juan is pending — this is intentionally a minimal
 * read-only aggregator that the cockpit "Day P&L" tile + the Phase
 * C4 broker fills (stamping `result_payload.dayOnePnlCents`) can
 * plug into.
 */

export const dynamic = "force-dynamic";

interface Strategy {
  id: string;
  name?: string | null;
  short_name?: string | null;
  payload?: Record<string, unknown> | null;
}

interface StrategyReturnsRow {
  user_id: string;
  strategy_id: string;
  basket_value: number | string | null;
  as_of_date: string;
  inception_pnl?: number | string | null;
}

interface AuditRow {
  id: string;
  status: string | null;
  result_payload: Record<string, unknown> | null;
  updated_at: string;
  symbol: string;
}

interface MonthlyBucket {
  month: string; // YYYY-MM
  aum_fees_rands: number;
  slip_rands: number;
  filled_count: number;
}

const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function monthKey(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function readNumber(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function uniq<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}

export async function GET() {
  const auth = await getAdminContext();
  if (auth.status === "no-session") {
    return NextResponse.json({ ok: false, error: "no-session" }, { status: 401 });
  }
  if (auth.status !== "ok" || !isAdminRole(auth.ctx)) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  // AUM fees from RETAIL
  let retail: ReturnType<typeof createRetailServiceRoleClient> | null = null;
  try {
    retail = createRetailServiceRoleClient();
  } catch {
    retail = null;
  }

  let aumMonthlyCents = 0;
  let aumTotalCents = 0;
  let aumActiveStrategies = 0;
  let platformAumCents = 0;
  let monthlyAccruals: MonthlyBucket[] = [];
  let notice: string | null = null;

  if (retail) {
    try {
      const [stratsRes, returnsRes] = await Promise.all([
        retail.from("strategies_c").select("id, name, short_name, payload"),
        retail
          .from("client_strategy_returns_c")
          .select("user_id, strategy_id, basket_value, as_of_date, inception_pnl")
          // last 18 months keeps the chart readable without burning cycles.
          .gte("as_of_date", new Date(Date.now() - 540 * 86_400_000).toISOString().slice(0, 10))
          .order("as_of_date", { ascending: true })
          .limit(50_000),
      ]);

      const strategies = (stratsRes.data ?? []) as Strategy[];
      const returns = (returnsRes.data ?? []) as StrategyReturnsRow[];

      const feePctById: Record<string, number> = {};
      for (const s of strategies) {
        const payload = s.payload ?? {};
        const raw = payload.fee_pct ?? payload.management_fee_pct ?? payload.feePct;
        const pct = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : 1.0;
        feePctById[s.id] = Number.isFinite(pct) && pct > 0 ? pct : 1.0;
      }

      // Latest NAV per user/strategy — same convention `investors/data` uses.
      const latestByUserStrategy = new Map<string, StrategyReturnsRow>();
      for (const r of returns) {
        const key = `${r.user_id}|${r.strategy_id}`;
        const prev = latestByUserStrategy.get(key);
        if (!prev || new Date(prev.as_of_date) < new Date(r.as_of_date)) {
          latestByUserStrategy.set(key, r);
        }
      }

      // Monthly AUM-fee accrual in cents, per month over the rolling 12 months.
      const monthlyMap = new Map<string, number>();
      const now = new Date();
      const monthsBack = 12;
      const startOfWindow = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (monthsBack - 1), 1));

      for (const [, snap] of latestByUserStrategy) {
        const aumCents = Math.round(readNumber(snap.basket_value));
        if (aumCents <= 0) continue;
        const feePct = feePctById[snap.strategy_id] ?? 1.0;
        const monthlyCents = Math.max(0, Math.round((aumCents * feePct) / 12 / 100));
        // Attribute the accrual to the as_of_date month.
        const asOf = new Date(snap.as_of_date);
        if (asOf >= startOfWindow) {
          const k = monthKey(asOf);
          monthlyMap.set(k, (monthlyMap.get(k) ?? 0) + monthlyCents);
          aumMonthlyCents += monthlyCents;
        }
        aumTotalCents += monthlyCents;
        platformAumCents += aumCents;
        aumActiveStrategies += 1;
      }

      // Build a 12-month series (fill missing months with zero) so the chart
      // doesn't have a "stair-step" gap.
      monthlyAccruals = [];
      for (let i = monthsBack - 1; i >= 0; i--) {
        const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
        const k = monthKey(d);
        monthlyAccruals.push({
          month: k,
          aum_fees_rands: (monthlyMap.get(k) ?? 0) / 100,
          slip_rands: 0,
          filled_count: 0,
        });
      }
    } catch (err) {
      notice = `RETAIL aggregate failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  } else {
    notice = "RETAIL database not configured — AUM fees will read 0.";
  }

  // Day-1 P&L / slip from INSTITUTIONAL
  let institutional: ReturnType<typeof createInstitutionalServiceRoleClient> | null = null;
  try {
    institutional = createInstitutionalServiceRoleClient();
  } catch {
    institutional = null;
  }

  let slipTotalCents = 0;
  let slipRowsCount = 0;
  let filledRows = 0;
  let partialRows = 0;
  if (institutional) {
    try {
      const auditRes = await institutional
        .from("oems_order_audit")
        .select("id, status, result_payload, updated_at, symbol")
        .in("status", ["filled", "partial"])
        .order("updated_at", { ascending: false })
        .limit(5_000);
      const rows = (auditRes.data ?? []) as AuditRow[];
      const slipByMonth = new Map<string, number>();
      for (const r of rows) {
        const pnl = readNumber(r.result_payload?.["dayOnePnlCents"]);
        if (pnl === 0 && !r.result_payload?.["dayOnePnlCents"]) continue;
        slipTotalCents += pnl;
        slipRowsCount += 1;
        if (r.status === "filled") filledRows += 1;
        if (r.status === "partial") partialRows += 1;
        const k = monthKey(new Date(r.updated_at));
        slipByMonth.set(k, (slipByMonth.get(k) ?? 0) + pnl);
      }
      // Merge slip into the same monthlyAccruals bucket.
      monthlyAccruals = monthlyAccruals.map((b) => ({
        ...b,
        slip_rands: (slipByMonth.get(b.month) ?? 0) / 100,
        filled_count: filledRows, // snapshot total for tooltip
      }));
    } catch (err) {
      const msg = `INSTITUTIONAL audit read failed: ${err instanceof Error ? err.message : String(err)}`;
      notice = notice ? `${notice} ${msg}` : msg;
    }
  } else {
    notice = notice
      ? `${notice} INSTITUTIONAL DB not configured — slip reads 0.`
      : "INSTITUTIONAL DB not configured — slip reads 0.";
  }

  return NextResponse.json({
    ok: true,
    notice,
    platform_aum_rands: platformAumCents / 100,
    aum_fees_accrued_rands: aumTotalCents / 100,
    aum_fees_monthly_rands: aumMonthlyCents / 100,
    aum_active_strategies: aumActiveStrategies,
    slip_total_rands: slipTotalCents / 100, // negative = clients paid more than limit
    slip_rows_count: slipRowsCount,
    filled_rows: filledRows,
    partial_rows: partialRows,
    monthly: monthlyAccruals.map((m) => ({
      ...m,
      label: `${MONTH_LABELS[Number(m.month.slice(5, 7)) - 1]} ${m.month.slice(0, 4)}`,
    })),
    as_of_date: new Date().toISOString(),
  });
}
