import { NextResponse } from "next/server";

import { isAdminRole } from "@/lib/admin/pages";
import { getAdminContext } from "@/lib/admin/rbac";
import { createRetailServiceRoleClient } from "@/lib/supabase/server";
import { createInstitutionalServiceRoleClient } from "@/lib/supabase/server";
import { loadCanonicalRetailAum } from "@/lib/aum/canonical-retail-aum";
import { loadRetailLiveScope } from "@/lib/aum/retail-live-scope";

/**
 * GET /api/admin/finance
 *
 * Mint OEM Finalisation Phase C7 — placeholder Finance aggregation for
 * the `/admin/finance` tab. Reads:
 *
 *   - RETAIL `aum_fee_accrual_segments` + the shared canonical AUM helper
 *     (loadCanonicalRetailAum) to surface AUM fees. This comment previously
 *     said client_strategy_returns_c x fee_pct — that described an earlier
 *     version; the code below has not queried that table directly for some
 *     time, corrected here so the comment stops misleading the next reader.
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
      const [canonicalAum, liveScope, feesRes] = await Promise.all([
        loadCanonicalRetailAum(retail),
        loadRetailLiveScope(retail),
        retail
          .from("aum_fee_accrual_segments")
          .select("user_id,strategy_id,accrued_fee_cents,segment_start_date,segment_end_date")
          // last 18 months keeps the chart readable without burning cycles.
          .gte("segment_start_date", new Date(Date.now() - 540 * 86_400_000).toISOString().slice(0, 10))
          .order("segment_start_date", { ascending: true })
          .limit(50_000),
      ]);

      if (feesRes.error) throw new Error(`AUM fee ledger: ${feesRes.error.message}`);
      platformAumCents = canonicalAum.totalAumCents;
      aumActiveStrategies = canonicalAum.byStrategy.size;

      // Latest NAV per user/strategy — same convention `investors/data` uses.
      // Monthly AUM-fee accrual in cents, per month over the rolling 12 months.
      const monthlyMap = new Map<string, number>();
      const now = new Date();
      const monthsBack = 12;
      for (const fee of feesRes.data ?? []) {
        if (
          liveScope.excludedUserIds.has(String(fee.user_id)) ||
          liveScope.excludedStrategyIds.has(String(fee.strategy_id))
        ) continue;
        const feeCents = Math.max(0, Math.round(readNumber(fee.accrued_fee_cents)));
        const key = monthKey(new Date(String(fee.segment_start_date)));
        monthlyMap.set(key, (monthlyMap.get(key) ?? 0) + feeCents);
        aumTotalCents += feeCents;
        if (key === monthKey(now)) aumMonthlyCents += feeCents;
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
    aum_methodology: "CANONICAL_LIVE_RETAIL_AUM_V1",
    fee_methodology: "STATIC_COST_BASIS_0_99_PERCENT_MONTHLY_V1",
  });
}
