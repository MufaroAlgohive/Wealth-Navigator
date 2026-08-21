"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Panel } from "@/components/oems/primitives/panel";
import { Pill } from "@/components/oems/primitives/pill";
import { EmptyDataState } from "@/components/oems/primitives/empty-data-state";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useIress } from "@/lib/iress/provider";
import { iressConfig } from "@/lib/iress";
import { isRealDataOnlyClient } from "@/lib/data-policy";

type RecomputeStrategyResult = {
  strategy: string;
  draftAction?: string;
  certificationAction?: string;
  ytdReturnPctBefore: number | null;
  ytdReturnPctAfter: number | null;
};

type RecomputeResponse = {
  ok: boolean;
  asOf: string;
  phase?: string;
  error?: string;
  triggeredBy?: string;
  draft?: { results: Array<{ strategy: string; action: string; reason?: string }> };
  certification?: { results: Array<{ strategy: string; action: string; reason?: string }> };
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
      if (!res.ok || body.ok === false) {
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
                      </td>
                      <td className="py-1 pr-2">
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

export default function SettingsPage() {
  const realDataOnly = isRealDataOnlyClient();
  const { data } = useIress();
  // `data.endpoints()` is a SIMULATED latency/health snapshot from the mock
  // adapter — only fetch/show it under an explicit mock opt-in. Real endpoint
  // health is the live worker heartbeat on the Integration page; never render
  // the simulated figures as if they were real.
  const epQ = useQuery({ queryKey: ["endpoints"], queryFn: () => data.endpoints(), enabled: !realDataOnly });
  const endpoints = epQ.data ?? [];

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-8">
      <div>
        <Pill tone="primary" size="sm" className="mb-3">Settings</Pill>
        <h1 className="text-2xl font-semibold tracking-tight">Application · environment</h1>
        <p className="mt-1 text-sm text-muted-foreground">Read-only view of the running configuration. Override via environment variables.</p>
      </div>

      <Tabs defaultValue="general">
        <TabsList>
          <TabsTrigger value="general">General</TabsTrigger>
          <TabsTrigger value="dev-tools">Dev Tools</TabsTrigger>
        </TabsList>

        <TabsContent value="general" className="mt-3 space-y-4">
          <Panel title="IRESS adapter" endpoint="iress.config">
            <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-3">
              {Object.entries(iressConfig).map(([k, v]) => (
                <div key={k} className="rounded-md border border-border/60 bg-surface-2/30 p-2">
                  <p className="text-[9.5px] uppercase tracking-wider text-muted-foreground">{k}</p>
                  <p className="mt-0.5 break-all font-mono text-xs font-semibold">
                    {Array.isArray(v) ? v.join(", ") : String(v)}
                  </p>
                </div>
              ))}
            </div>
          </Panel>

          <Panel
            title="Endpoint health snapshot"
            endpoint="iress.health"
            dataSource={realDataOnly ? undefined : "mock"}
            density="scroll"
          >
            {realDataOnly ? (
              <EmptyDataState
                message="Live endpoint latency & health is the worker heartbeat on the Integration page."
                hint="This panel only shows a simulated snapshot under an explicit mock opt-in (?mock=1)."
              />
            ) : (
              <table className="w-full font-mono text-xs">
                <tbody className="divide-y divide-border/60">
                  {endpoints.map((e) => (
                    <tr key={e.name}>
                      <td className="px-2.5 py-1.5 font-semibold">{e.name}</td>
                      <td className="px-2.5 py-1.5 text-muted-foreground">{e.method}</td>
                      <td className="px-2.5 py-1.5 text-right">p95 {e.p95}ms</td>
                      <td className="px-2.5 py-1.5"><Pill tone={e.status === "ok" ? "success" : "warning"} size="xs" dot>{e.status}</Pill></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>
        </TabsContent>

        <TabsContent value="dev-tools" className="mt-3 space-y-4">
          <RecomputePanel />
        </TabsContent>
      </Tabs>
    </div>
  );
}
