"use client";

import { useAdmin } from "@/lib/admin/context";
import { isAdminRole } from "@/lib/admin/pages";
import { AlertTriangle, PiggyBank, Scale, Wallet } from "lucide-react";
import * as React from "react";
import { Area, AreaChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { GlassKpi, GlassSection, PageCanvas } from "@/components/oems/primitives/glass";

/**
 * /admin/finance — placeholder Finance tab.
 *
 * Mint OEM Finalisation Phase C7. Reads `/api/admin/finance`:
 *   - LIVE retail AUM from the shared canonical calculator
 *   - AUM fees from the persisted static-cost-basis accrual ledger
 *   - Day-1 P&L / slip (INSTITUTIONAL `oems_order_audit.result_payload`)
 *
 * Glass tokens (`GlassSection` + `GlassKpi` + `PageCanvas`) keep this
 * visually consistent with the OEMS surface. Juan's full Finance tab
 * spec is pending; this view is intentionally read-only and audit
 * shaped (no writes, no discounts, no journal entries).
 */

interface FinanceMonthly {
  month: string;
  label: string;
  aum_fees_rands: number;
  slip_rands: number;
  filled_count: number;
}

interface FinanceResponse {
  ok: boolean;
  notice?: string | null;
  platform_aum_rands: number;
  aum_fees_accrued_rands: number;
  aum_fees_monthly_rands: number;
  aum_active_strategies: number;
  slip_total_rands: number;
  slip_rows_count: number;
  filled_rows: number;
  partial_rows: number;
  monthly: FinanceMonthly[];
  as_of_date: string;
}

const rand = (n: number): string =>
  new Intl.NumberFormat("en-ZA", {
    style: "currency",
    currency: "ZAR",
    maximumFractionDigits: 2,
  }).format(Number.isFinite(n) ? n : 0);

export default function FinancePage() {
  const { ctx } = useAdmin();
  const admin = isAdminRole(ctx);

  const [data, setData] = React.useState<FinanceResponse | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!admin) return;
    let alive = true;
    (async () => {
      try {
        const r = await fetch("/api/admin/finance").then((x) => x.json());
        if (!alive) return;
        if (r?.ok === false) {
          setError(r.error ?? "Finance endpoint refused");
          return;
        }
        setData(r);
      } catch (err) {
        if (alive) setError((err as Error).message);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [admin]);

  if (!admin) {
    return <div className="py-16 text-center text-sm text-muted-foreground">Admins only.</div>;
  }

  return (
    <PageCanvas>
      <GlassSection
        title="Platform Finances"
        subtitle="AUM fees + Day-1 P&L aggregation — placeholder view for the Phase C7 Finance tab"
        dataSource={data?.ok ? "supabase" : "code-gap"}
        db={data?.slip_rows_count ? "institutional" : "retail"}
        endpoint="/api/admin/finance"
      >
        {error && (
          <div
            className="mb-4 flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-[12px]"
            role="alert"
          >
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
            <span>{error}</span>
          </div>
        )}
        {data?.notice && (
          <div
            className="mb-4 flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-[12px] text-foreground/80"
            role="status"
          >
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
            <span>{data.notice}</span>
          </div>
        )}

        <div className="grid gap-3 md:grid-cols-4">
          <GlassKpi
            label="Platform AUM"
            value={rand(data?.platform_aum_rands ?? 0)}
            sub={`As of ${data?.as_of_date?.slice(0, 10) ?? "—"}`}
            accent="primary"
          />
          <GlassKpi
            label="AUM Fees accrued"
            value={rand(data?.aum_fees_accrued_rands ?? 0)}
            sub={`${data?.aum_active_strategies ?? 0} active positions`}
            accent="default"
          />
          <GlassKpi
            label="AUM Fees monthly"
            value={rand(data?.aum_fees_monthly_rands ?? 0)}
            sub="Trailing 12 months"
            accent="default"
          />
          <GlassKpi
            label="Day-1 P&L / slip"
            value={rand(data?.slip_total_rands ?? 0)}
            sub={`${data?.filled_rows ?? 0} filled · ${data?.partial_rows ?? 0} partial`}
            accent={
              (data?.slip_total_rands ?? 0) < 0
                ? "negative"
                : (data?.slip_total_rands ?? 0) > 0
                  ? "positive"
                  : "default"
            }
          />
        </div>
      </GlassSection>

      <GlassSection
        title="Monthly accrual vs slip"
        subtitle="AUM fee accruals (Rands) against Day-1 P&L realised on the desk"
        dataSource={data?.ok ? "supabase" : "code-gap"}
        db={data?.slip_rows_count ? "institutional" : "retail"}
        endpoint="/api/admin/finance"
      >
        <div className="h-[320px] w-full">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data?.monthly ?? []} margin={{ top: 10, right: 16, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="grad-fees" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#a78bfa" stopOpacity={0.65} />
                  <stop offset="95%" stopColor="#a78bfa" stopOpacity={0.05} />
                </linearGradient>
                <linearGradient id="grad-slip" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#22d3ee" stopOpacity={0.6} />
                  <stop offset="95%" stopColor="#22d3ee" stopOpacity={0.05} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="rgba(148,163,184,0.18)" strokeDasharray="3 3" />
              <XAxis dataKey="label" tickLine={false} axisLine={false} stroke="rgba(148,163,184,0.7)" />
              <YAxis
                tickFormatter={(v: number) =>
                  new Intl.NumberFormat("en-ZA", {
                    notation: "compact",
                    maximumFractionDigits: 1,
                  }).format(v)
                }
                tickLine={false}
                axisLine={false}
                stroke="rgba(148,163,184,0.7)"
              />
              <Tooltip
                formatter={(v: number, key: string) =>
                  key === "aum_fees_rands" ? rand(v) : `${rand(v)} (slip)`
                }
                labelStyle={{ color: "rgba(15,23,42,0.8)" }}
                contentStyle={{
                  background: "rgba(15,23,42,0.85)",
                  border: "1px solid rgba(148,163,184,0.3)",
                  borderRadius: 8,
                  color: "white",
                }}
              />
              <Legend
                wrapperStyle={{ paddingTop: 8 }}
                formatter={(k) => (k === "aum_fees_rands" ? "AUM fees (R)" : "Day-1 P&L (R)")}
              />
              <Area type="monotone" dataKey="aum_fees_rands" stroke="#a78bfa" fill="url(#grad-fees)" />
              <Area type="monotone" dataKey="slip_rands" stroke="#22d3ee" fill="url(#grad-slip)" />
            </AreaChart>
          </ResponsiveContainer>
        </div>
        <p className="hidden">
          AUM fees accrue against <code className="font-mono">client_strategy_returns_c.basket_value</code>×
          strategy <code className="font-mono">fee_pct</code>. Slip is the cumulative Day-1 P&L stamped by the
          broker-ingest worker on each filled audit row.
        </p>
        <p className="mt-3 text-[11px] text-muted-foreground">
          Platform AUM uses the canonical LIVE holdings, unused reserve, residual and consumed-fee state.
          Monthly fees are read from the static-cost-basis accrual ledger at 0.99% per annum divided by 12.
          Slip is the cumulative Day-1 P&amp;L recorded by the broker-ingest worker.
        </p>
      </GlassSection>

      <GlassSection
        title="What this view does NOT do"
        subtitle="Placeholder pending Juan's full Finance tab spec"
        dataSource="code-gap"
        endpoint="(spec pending)"
      >
        <ul className="ml-5 list-disc space-y-1 text-[12.5px] text-muted-foreground">
          <li>No journal entries, no general-ledger postings, no invoice generation.</li>
          <li>No discounts, fee waivers, or pro-rated refunds.</li>
          <li>No reconciliation against the bank feed — that lives on the Reconciliation page.</li>
          <li>No per-client rollups — the Investors → Detail page already surfaces AUM per client.</li>
        </ul>
        <div className="mt-4 grid gap-3 md:grid-cols-3">
          <GlassKpi
            label="AUM feeds"
            value={`${data?.aum_active_strategies ?? 0} positions`}
            sub="Latest basket_value snapshots"
            accent="default"
          />
          <GlassKpi
            label="Slip rows"
            value={`${data?.slip_rows_count ?? 0}`}
            sub="oems_order_audit rows with dayOnePnlCents"
            accent="default"
          />
          <GlassKpi
            label="Empty-state shown when"
            value="audit table not migrated"
            sub="Phase C4 broker fills require this view"
            accent="default"
          />
        </div>
        <p className="mt-4 text-[11px] text-muted-foreground">
          Once the broker-ingest worker writes the first fills, the slip series will start populating. Until
          then the chart renders with zero slip across the trailing 12 months.
        </p>
        <div className="sr-only flex gap-2">
          <Wallet aria-hidden className="h-3.5 w-3.5" />
          <Scale aria-hidden className="h-3.5 w-3.5" />
          <PiggyBank aria-hidden className="h-3.5 w-3.5" />
        </div>
      </GlassSection>
    </PageCanvas>
  );
}
