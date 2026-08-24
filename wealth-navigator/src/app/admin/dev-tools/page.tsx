"use client";

import { useState } from "react";
import { toast } from "sonner";

import { useAdmin } from "@/lib/admin/context";
import { isAdminRole } from "@/lib/admin/pages";
import { Panel } from "@/components/oems/primitives/panel";
import { Pill } from "@/components/oems/primitives/pill";
import { Button } from "@/components/ui/button";

type RecomputeStrategyResult = {
  strategy: string;
  draftAction?: string;
  draftReason?: string;
  certificationAction?: string;
  certificationReason?: string;
  ytdReturnPctBefore: number | null;
  ytdReturnPctAfter: number | null;
};

type RecomputeResponse = {
  ok: boolean;
  asOf: string;
  phase?: string;
  error?: string;
  triggeredBy?: string;
  draft?: {
    results: Array<{ strategy: string; action: string; reason?: string }>;
    note?: string;
  };
  certification?: {
    results: Array<{ strategy: string; action: string; reason?: string }>;
    note?: string;
  };
  ytd?: Array<{ strategy: string; ytdReturnPctBefore: number | null; ytdReturnPctAfter: number | null }>;
};

function formatPct(v: number | null) {
  if (v == null) return "—";
  return `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
}

function RecomputePanel() {
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<RecomputeResponse | null>(null);

  const runRecompute = async () => {
    setPending(true);
    setResult(null);
    try {
      const res = await fetch("/api/admin/canonical-ledger/recompute", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      const body = (await res.json().catch(() => ({}))) as RecomputeResponse;
      setResult(body);
      if (!res.ok) {
        toast.error(body.error ?? `Recompute failed (${res.status}).`);
      } else if (body.phase === "partial") {
        toast.warning(
          `Certified for ${body.asOf}, but at least one strategy failed — see the table for which one.`,
        );
      } else if (body.ok === false) {
        toast.error(body.error ?? `Recompute failed (${res.status}).`);
      } else {
        toast.success(`Canonical ledger recomputed and certified for ${body.asOf}.`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setResult({ ok: false, asOf: "", error: msg });
      toast.error(msg);
    } finally {
      setPending(false);
    }
  };

  // Merge draft + certification + YTD rows into one per-strategy view, keyed
  // by strategy name (all three arrays are keyed the same way).
  const rows: RecomputeStrategyResult[] = (() => {
    if (!result) return [];
    const byStrategy = new Map<string, RecomputeStrategyResult>();
    for (const d of result.draft?.results ?? []) {
      byStrategy.set(d.strategy, {
        strategy: d.strategy,
        draftAction: d.action,
        draftReason: d.reason,
        ytdReturnPctBefore: null,
        ytdReturnPctAfter: null,
      });
    }
    for (const c of result.certification?.results ?? []) {
      const existing = byStrategy.get(c.strategy) ?? {
        strategy: c.strategy,
        ytdReturnPctBefore: null,
        ytdReturnPctAfter: null,
      };
      existing.certificationAction = c.action;
      existing.certificationReason = c.reason;
      byStrategy.set(c.strategy, existing);
    }
    for (const y of result.ytd ?? []) {
      const existing = byStrategy.get(y.strategy) ?? {
        strategy: y.strategy,
        ytdReturnPctBefore: null,
        ytdReturnPctAfter: null,
      };
      existing.ytdReturnPctBefore = y.ytdReturnPctBefore;
      existing.ytdReturnPctAfter = y.ytdReturnPctAfter;
      byStrategy.set(y.strategy, existing);
    }
    return [...byStrategy.values()].sort((a, b) => a.strategy.localeCompare(b.strategy));
  })();

  return (
    <Panel
      title="Canonical ledger recompute"
      endpoint="admin.canonical-ledger.recompute"
      right={
        <Button size="sm" onClick={runRecompute} disabled={pending}>
          {pending ? "Recomputing…" : "Recompute Now"}
        </Button>
      }
    >
      <div className="space-y-3 text-xs">
        <p className="text-muted-foreground">
          Re-runs today&apos;s canonical ledger draft + certification for every active strategy — the same
          sequence the 17:30 UTC daily cron runs automatically. Use this to pull corrected YTD figures forward
          immediately (e.g. after a ledger fix) instead of waiting for tonight&apos;s scheduled run. This can
          take a while — draft and certification run sequentially for every active strategy. Requires a
          Dev or Master ★ account.
        </p>
        {result && (
          <div className="rounded-md border border-border/60 bg-surface-2/30 p-2.5">
            {result.error && !result.draft && <p className="text-destructive">{result.error}</p>}
            {result.draft?.note && (
              <p className="mb-2 rounded border border-amber-500/40 bg-amber-500/10 p-2 text-amber-600 dark:text-amber-400">
                Draft: {result.draft.note}
              </p>
            )}
            {result.certification?.note && (
              <p className="mb-2 rounded border border-amber-500/40 bg-amber-500/10 p-2 text-amber-600 dark:text-amber-400">
                Certification: {result.certification.note}
              </p>
            )}
            {result.asOf && (
              <p className="mb-2 text-muted-foreground">
                As of <span className="font-mono text-foreground">{result.asOf}</span>
                {result.triggeredBy && (
                  <>
                    {" "}
                    · triggered by <span className="font-mono text-foreground">{result.triggeredBy}</span>
                  </>
                )}
              </p>
            )}
            {rows.length > 0 ? (
              <table className="w-full font-mono text-[11px]">
                <thead>
                  <tr className="text-left text-muted-foreground">
                    <th className="pb-1 pr-2 font-normal">Strategy</th>
                    <th className="pb-1 pr-2 font-normal">Draft</th>
                    <th className="pb-1 pr-2 font-normal">Certification</th>
                    <th className="pb-1 pr-2 text-right font-normal">YTD before</th>
                    <th className="pb-1 text-right font-normal">YTD after</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/60">
                  {rows.map((r) => (
                    <tr key={r.strategy}>
                      <td className="py-1 pr-2 font-sans font-semibold">{r.strategy}</td>
                      <td className="py-1 pr-2">
                        <span title={r.draftReason} className="inline-flex items-center gap-1">
                          <Pill
                            tone={
                              r.draftAction === "written"
                                ? "success"
                                : r.draftAction === "failed"
                                  ? "destructive"
                                  : "neutral"
                            }
                            size="xs"
                          >
                            {r.draftAction ?? "—"}
                          </Pill>
                          {r.draftReason && (
                            <span className="text-muted-foreground">({r.draftReason})</span>
                          )}
                        </span>
                      </td>
                      <td className="py-1 pr-2">
                        <span title={r.certificationReason} className="inline-flex items-center gap-1">
                          <Pill
                            tone={
                              r.certificationAction === "certified" || r.certificationAction === "already-certified"
                                ? "success"
                                : r.certificationAction === "failed"
                                  ? "destructive"
                                  : "neutral"
                            }
                            size="xs"
                          >
                            {r.certificationAction ?? "—"}
                          </Pill>
                          {r.certificationReason && (
                            <span className="text-muted-foreground">({r.certificationReason})</span>
                          )}
                        </span>
                      </td>
                      <td className="py-1 pr-2 text-right">{formatPct(r.ytdReturnPctBefore)}</td>
                      <td className="py-1 text-right font-semibold">{formatPct(r.ytdReturnPctAfter)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              !result.error && <p className="text-muted-foreground">No strategies returned.</p>
            )}
          </div>
        )}
      </div>
    </Panel>
  );
}

type ClientPublishRow = {
  client: string;
  strategy: string;
  action: "published" | "plan" | "skip" | "failed";
  reason?: string;
  dailyPct?: number | null;
  error?: string;
};

type ClientPublishResponse = {
  ok: boolean;
  asOf: string;
  apply: boolean;
  summary?: { published: number; skipped: number; failed: number; total: number };
  results?: ClientPublishRow[];
  note?: string;
  error?: string;
};

function ClientReturnsPublishPanel() {
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<ClientPublishResponse | null>(null);

  const runPublish = async () => {
    setPending(true);
    setResult(null);
    try {
      const res = await fetch("/api/cron/client-returns-publish?apply=1");
      const body = (await res.json().catch(() => ({}))) as ClientPublishResponse;
      setResult(body);
      if (!res.ok || body.ok === false) {
        toast.error(body.error ?? body.note ?? `Publish failed (${res.status}).`);
      } else {
        const s = body.summary;
        toast.success(
          s
            ? `Published for ${body.asOf}: ${s.published} written, ${s.skipped} skipped, ${s.failed} failed.`
            : `Published for ${body.asOf}.`,
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setResult({ ok: false, asOf: "", apply: true, error: msg });
      toast.error(msg);
    } finally {
      setPending(false);
    }
  };

  return (
    <Panel
      title="Client returns publish"
      endpoint="cron.client-returns-publish"
      right={
        <Button size="sm" onClick={runPublish} disabled={pending}>
          {pending ? "Publishing…" : "Publish Now"}
        </Button>
      }
    >
      <div className="space-y-3 text-xs">
        <p className="text-muted-foreground">
          Manually runs today&apos;s per-client EOD return publish — the same job that normally only fires
          from the scheduled 17:20 UTC cron. This writes one guarded row per (client, family member,
          strategy) into <span className="font-mono">client_strategy_return_publication_audit_c</span>,
          which is what Day P&amp;L / per-client YTD read from.
        </p>
        <p className="text-muted-foreground">
          The CRM (MyMintAdmin) handed this job to the OEM on 2026-08-24 — its own daily cron call was
          removed rather than left behind a flag, so there is only one live writer now and this button is
          safe to use any time. Useful for forcing today&apos;s figures forward immediately instead of
          waiting for the scheduled run, or for spot-checking a specific date via{" "}
          <span className="font-mono">?asOf=</span> in the API directly.
        </p>
        {result && (
          <div className="rounded-md border border-border/60 bg-surface-2/30 p-2.5">
            {result.error && <p className="text-destructive">{result.error}</p>}
            {result.note && (
              <p className="mb-2 rounded border border-amber-500/40 bg-amber-500/10 p-2 text-amber-600 dark:text-amber-400">
                {result.note}
              </p>
            )}
            {result.asOf && (
              <p className="mb-2 text-muted-foreground">
                As of <span className="font-mono text-foreground">{result.asOf}</span>
                {result.summary && (
                  <>
                    {" "}
                    · <span className="font-mono text-foreground">{result.summary.published}</span> published,{" "}
                    <span className="font-mono text-foreground">{result.summary.skipped}</span> skipped,{" "}
                    <span className="font-mono text-foreground">{result.summary.failed}</span> failed
                  </>
                )}
              </p>
            )}
            {result.results && result.results.length > 0 ? (
              <table className="w-full font-mono text-[11px]">
                <thead>
                  <tr className="text-left text-muted-foreground">
                    <th className="pb-1 pr-2 font-normal">Client</th>
                    <th className="pb-1 pr-2 font-normal">Strategy</th>
                    <th className="pb-1 pr-2 font-normal">Action</th>
                    <th className="pb-1 text-right font-normal">1D</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/60">
                  {result.results.map((r, i) => (
                    <tr key={`${r.client}-${r.strategy}-${i}`}>
                      <td className="py-1 pr-2 font-sans">{r.client}</td>
                      <td className="py-1 pr-2 font-sans">{r.strategy}</td>
                      <td className="py-1 pr-2">
                        <span title={r.reason ?? r.error} className="inline-flex items-center gap-1">
                          <Pill
                            tone={
                              r.action === "published"
                                ? "success"
                                : r.action === "failed"
                                  ? "destructive"
                                  : "neutral"
                            }
                            size="xs"
                          >
                            {r.action}
                          </Pill>
                          {(r.reason || r.error) && (
                            <span className="text-muted-foreground">({r.reason ?? r.error})</span>
                          )}
                        </span>
                      </td>
                      <td className="py-1 text-right">
                        {r.dailyPct == null ? "—" : `${r.dailyPct >= 0 ? "+" : ""}${r.dailyPct.toFixed(2)}%`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              !result.error && <p className="text-muted-foreground">No owners returned.</p>
            )}
          </div>
        )}
      </div>
    </Panel>
  );
}

export default function DevToolsPage() {
  const { ctx } = useAdmin();
  const admin = isAdminRole(ctx);

  if (!admin) {
    return <div className="py-16 text-center text-sm text-muted-foreground">Admins only.</div>;
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <p className="text-sm text-muted-foreground">
        Operational tooling for admins and developers. Actions here affect live data — use with care.
      </p>

      <RecomputePanel />
      <ClientReturnsPublishPanel />
    </div>
  );
}
