"use client";

/**
 * Yahoo -> IRESS(PROD) cutover console. Reads the per-symbol accuracy scoreboard
 * and lets the desk approve a symbol once the backend has validated it. Approval
 * is the human gate; `validated` is the backend (Railway) gate — a symbol only
 * cuts over when BOTH are true, and the worker/Yahoo-cron enforce that at write
 * time. This page never writes prices; it only reads the board and toggles the
 * approval flag.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, FlaskConical, RefreshCw, ShieldCheck, X } from "lucide-react";
import * as React from "react";

import { GlassKpi, GlassSection, ResearchLabCanvas } from "@/components/oems/primitives/glass";
import { cn } from "@/lib/cn";

type Bucket = "approved" | "validated" | "watch" | "breach" | "no-data";

interface Row {
  symbol: string;
  last_iress_cents: number | null;
  last_yahoo_cents: number | null;
  last_divergence_pct: number | null;
  last_severity: string | null;
  samples_total: number;
  samples_ok: number;
  consecutive_ok: number;
  max_consecutive_ok: number;
  covered: boolean;
  validated: boolean;
  approved: boolean;
  approved_by: string | null;
  last_checked: string;
  bucket: Bucket;
}

interface Resp {
  ok?: boolean;
  minStreak?: number;
  counts?: Record<string, number>;
  rows?: Row[];
  notice?: string;
}

const R = (cents: number | null | undefined) =>
  cents == null ? "—" : `R${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const BUCKET_STYLE: Record<Bucket, string> = {
  approved: "border-[hsl(var(--up)/0.5)] bg-[hsl(var(--up)/0.14)] text-[hsl(var(--up))]",
  validated: "border-primary/50 bg-primary/12 text-primary",
  watch: "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400",
  breach: "border-[hsl(var(--down)/0.5)] bg-[hsl(var(--down)/0.14)] text-[hsl(var(--down))]",
  "no-data": "border-[hsl(var(--glass-border))] text-muted-foreground",
};

export function IressMigrationClient() {
  const qc = useQueryClient();
  const q = useQuery<Resp>({
    queryKey: ["iress-validation"],
    refetchInterval: 60_000,
    queryFn: async () => (await fetch("/api/iress/validation", { cache: "no-store" })).json(),
  });

  const sample = useMutation({
    mutationFn: async () => (await fetch("/api/iress/validation", { method: "POST" })).json(),
    onSettled: () => qc.invalidateQueries({ queryKey: ["iress-validation"] }),
  });
  const approve = useMutation({
    mutationFn: async (v: { symbol: string; approved: boolean }) =>
      (
        await fetch("/api/iress/validation/approve", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(v),
        })
      ).json(),
    onSettled: () => qc.invalidateQueries({ queryKey: ["iress-validation"] }),
  });

  const rows = q.data?.rows ?? [];
  const counts = q.data?.counts ?? {};
  const minStreak = q.data?.minStreak ?? 12;

  return (
    <ResearchLabCanvas>
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-xl font-semibold tracking-tight">Yahoo → IRESS migration</h1>
          <p className="text-caption">
            Per-symbol cutover. A symbol only leaves Yahoo once the backend has <b>validated</b> it
            (stable in-tolerance streak) and you <b>approve</b> it. Nothing overwrites Yahoo before that.
          </p>
        </div>
        <button
          type="button"
          onClick={() => sample.mutate()}
          disabled={sample.isPending}
          className="inline-flex items-center gap-1.5 rounded-lg border border-[hsl(var(--glass-border))] px-3 py-1.5 text-xs hover:bg-[hsl(var(--foreground)/0.05)] disabled:opacity-50"
        >
          <RefreshCw className={cn("h-3.5 w-3.5", sample.isPending && "animate-spin")} />
          {sample.isPending ? "Sampling…" : "Run sample now"}
        </button>
      </header>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <GlassKpi label="Approved (live IRESS)" value={String(counts.approved ?? 0)} accent="positive" />
        <GlassKpi label="Validated (ready)" value={String(counts.validated ?? 0)} accent="primary" />
        <GlassKpi label="Watching" value={String(counts.watch ?? 0)} />
        <GlassKpi label="Breach" value={String(counts.breach ?? 0)} accent="negative" />
        <GlassKpi label="No IRESS data" value={String(counts["no-data"] ?? 0)} />
      </div>

      <GlassSection
        title="Per-symbol accuracy"
        subtitle={`Auto-validates after a ${minStreak}-sample in-tolerance streak · approve to cut over`}
        db="institutional"
        dataSource="hybrid"
        right={
          <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
            <ShieldCheck className="h-3.5 w-3.5" /> write-gated backend-side
          </span>
        }
        noPadding
      >
        {q.data?.notice ? (
          <p className="px-5 py-4 text-caption">{q.data.notice}</p>
        ) : rows.length === 0 ? (
          <p className="px-5 py-4 text-caption">
            No samples yet. The validation cron runs on a schedule, or hit “Run sample now”. During UAT
            (2nd seat off) IRESS returns test prices, so expect large divergence until the PROD seat is live.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[hsl(var(--glass-border))] text-left text-[10px] uppercase tracking-wide text-muted-foreground">
                  <th className="px-5 py-2 font-medium">Symbol</th>
                  <th className="px-3 py-2 text-right font-medium">IRESS</th>
                  <th className="px-3 py-2 text-right font-medium">Yahoo</th>
                  <th className="px-3 py-2 text-right font-medium">Δ%</th>
                  <th className="px-3 py-2 text-right font-medium">Streak</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-5 py-2 text-right font-medium">Cutover</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.symbol} className="border-b border-[hsl(var(--glass-border))] last:border-0">
                    <td className="px-5 py-2 font-semibold text-primary">{r.symbol}</td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">{R(r.last_iress_cents)}</td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums text-muted-foreground">{R(r.last_yahoo_cents)}</td>
                    <td
                      className={cn(
                        "px-3 py-2 text-right font-mono tabular-nums",
                        r.last_severity === "breach" ? "text-down" : r.last_severity === "watch" ? "text-amber-600 dark:text-amber-400" : "text-up",
                      )}
                    >
                      {r.last_divergence_pct == null ? "—" : `${r.last_divergence_pct.toFixed(2)}%`}
                    </td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums text-muted-foreground">
                      {r.consecutive_ok}/{minStreak}
                    </td>
                    <td className="px-3 py-2">
                      <span className={cn("inline-flex rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase", BUCKET_STYLE[r.bucket])}>
                        {r.bucket === "approved" ? (
                          <span className="inline-flex items-center gap-1"><FlaskConical className="h-3 w-3" /> live iress</span>
                        ) : (
                          r.bucket
                        )}
                      </span>
                    </td>
                    <td className="px-5 py-2 text-right">
                      {r.approved ? (
                        <button
                          type="button"
                          disabled={approve.isPending}
                          onClick={() => approve.mutate({ symbol: r.symbol, approved: false })}
                          className="inline-flex items-center gap-1 rounded-lg border border-[hsl(var(--glass-border))] px-2.5 py-1 text-xs text-muted-foreground hover:bg-[hsl(var(--foreground)/0.05)] disabled:opacity-50"
                        >
                          <X className="h-3.5 w-3.5" /> Revert to Yahoo
                        </button>
                      ) : (
                        <button
                          type="button"
                          disabled={approve.isPending || !r.validated}
                          title={r.validated ? "Approve this symbol for IRESS" : "Not validated yet — needs a stable in-tolerance streak"}
                          onClick={() => approve.mutate({ symbol: r.symbol, approved: true })}
                          className="inline-flex items-center gap-1 rounded-lg bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground disabled:opacity-40"
                        >
                          <Check className="h-3.5 w-3.5" /> Approve
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </GlassSection>
    </ResearchLabCanvas>
  );
}
