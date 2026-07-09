"use client";

import { Landmark, RefreshCw, Scale } from "lucide-react";
import * as React from "react";

import { GlassKpi, GlassSection, PageCanvas } from "@/components/oems/primitives/glass";
import { Button } from "@/components/ui/button";

/**
 * Banking › Reconciliation — KPI tiles + scope callout.
 *
 * Phase B4 of the OEM finalisation plan. Today's scope only renders the
 * "Matched / Unmatched" tiles from `wallet_transactions` so the team has
 * a live "how many deposits need a human" read. The full bank-statement
 * ingest + automated wallet↔statement matching lands in Phase C — that's
 * why this page carries `data-source="code-gap"`.
 */

interface ReconStats {
  total: number;
  matched: number;
  unmatched: number;
  totalRands: number;
}

export default function ReconciliationPage() {
  const [stats, setStats] = React.useState<ReconStats | null>(null);
  const [loading, setLoading] = React.useState(true);

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/eft?action=today-reconciliation", { cache: "no-store" });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; stats?: ReconStats };
      if (body.ok && body.stats) setStats(body.stats);
      else setStats({ total: 0, matched: 0, unmatched: 0, totalRands: 0 });
    } catch {
      setStats({ total: 0, matched: 0, unmatched: 0, totalRands: 0 });
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
    const id = window.setInterval(load, 60_000);
    return () => window.clearInterval(id);
  }, [load]);

  const fmtRands = (n: number) => `R ${n.toLocaleString("en-ZA", { maximumFractionDigits: 2 })}`;

  return (
    <PageCanvas>
      <GlassSection
        title="Reconciliation"
        subtitle="Today's wallet ↔ bank movement"
        dataSource="code-gap"
        endpoint="/api/admin/eft?action=today-reconciliation"
        right={
          <Button variant="secondary" size="sm" onClick={load} disabled={loading}>
            <RefreshCw className={loading ? "h-3.5 w-3.5 animate-spin" : "h-3.5 w-3.5"} /> Refresh
          </Button>
        }
      >
        <div className="space-y-4 py-2">
          <div className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-[12px] text-foreground/80">
            <Scale className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
            <span>
              Scope is pending Banking team sign-off. Until then this surface shows live
              <code className="mx-1 font-mono text-[11px]">wallet_transactions</code>
              daily rollups (total / approved+non-manual / pending); the full bank-statement ingest +
              automated matching lands in Phase C.
            </span>
          </div>

          <div className="grid gap-3 md:grid-cols-3">
            <GlassKpi
              label="Total transactions today"
              value={stats ? String(stats.total) : "—"}
              sub={stats ? fmtRands(stats.totalRands) : undefined}
              accent="primary"
            />
            <GlassKpi
              label="Matched"
              value={stats ? String(stats.matched) : "—"}
              sub="Approved · non-manual"
              accent="positive"
            />
            <GlassKpi
              label="Unmatched"
              value={stats ? String(stats.unmatched) : "—"}
              sub="Pending manual review"
              accent="negative"
            />
          </div>

          <div className="flex items-center gap-2 pt-2 text-[12px] text-muted-foreground">
            <Landmark className="h-3.5 w-3.5" />
            KPI ticks every 60s. Drill into the queue under Banking → EFT.
          </div>
        </div>
      </GlassSection>
    </PageCanvas>
  );
}
