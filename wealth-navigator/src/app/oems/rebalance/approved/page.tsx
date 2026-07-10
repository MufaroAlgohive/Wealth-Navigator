"use client";

import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, ExternalLink, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import * as React from "react";

import { EmptyDataState } from "@/components/oems/primitives/empty-data-state";
import { GlassBadge, GlassKpi, GlassSection, ResearchLabCanvas } from "@/components/oems/primitives/glass";
import { PanelSkeleton } from "@/components/oems/primitives/panel-skeleton";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { queryOpts } from "@/lib/store/query-provider";

/**
 * `/oems/rebalance/approved` — Phase B1 landing surface for a freshly
 * raised rebalance request. Reads `request_id` from the query string and
 * renders the request + the linked research note + any execution rows the
 * push endpoint emitted. Read-only.
 */

interface RebalanceRequestRow {
  id: string;
  strategy_id: string;
  status: string;
  requested_by: string;
  proposed_composition: unknown;
  affected_investors: unknown | null;
  research_note_id: string | null;
  executed_at: string | null;
  created_at: string;
  updated_at: string;
}

interface RequestResponse {
  ok: boolean;
  requests: RebalanceRequestRow[];
  notice?: string;
}

function ApprovedRebalanceView() {
  const sp = useSearchParams();
  const requestId = sp.get("request_id");

  const q = useQuery<RequestResponse>({
    queryKey: ["bff-rebalance-request-detail", requestId],
    queryFn: async () => {
      const url = requestId ? "/api/rebalance/requests?status=ic_approved" : "/api/rebalance/requests";
      const r = await fetch(url, { cache: "no-store" });
      return r.json();
    },
    refetchInterval: 30_000,
    ...queryOpts("reference"),
  });

  const all = q.data?.requests ?? [];
  const req = requestId ? (all.find((r) => r.id === requestId) ?? all[0]) : all[0];

  return (
    <ResearchLabCanvas>
      <header className="glass-panel relative overflow-hidden p-6 md:p-8">
        <div className="pointer-events-none absolute -right-20 -top-20 h-56 w-56 rounded-full bg-primary/15 blur-3xl" />
        <div className="relative space-y-3">
          <GlassBadge tone="primary">
            <ShieldCheck className="h-3.5 w-3.5" />
            Rebalance queue
          </GlassBadge>
          <h1 className="text-display">IC-approved rebalances</h1>
          <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
            The Rebalance Builder raises these requests. Execution writes are emitted to{" "}
            <code className="font-mono">oems_order_audit</code> when
            <code className="font-mono"> push_rebalance</code> is invoked.
          </p>
        </div>
      </header>

      {q.isLoading ? (
        <PanelSkeleton rows={4} />
      ) : !req ? (
        <GlassSection title="No rebalance request" db="institutional" dataSource="unavailable">
          <EmptyDataState
            title="No request found"
            message={
              q.data?.notice ??
              "Apply 20260710000004_rebalance_request_c.sql to start tracking rebalance requests."
            }
          />
        </GlassSection>
      ) : (
        <>
          <GlassSection
            title={`Request ${req.id.slice(0, 8)} · ${req.strategy_id}`}
            subtitle={`Raised by ${req.requested_by} · ${new Date(req.created_at).toLocaleString("en-ZA", { dateStyle: "medium", timeStyle: "short" })}`}
            endpoint="GET /api/rebalance/requests"
            db="institutional"
            dataSource={q.data?.notice ? "unavailable" : "supabase"}
            right={
              <GlassBadge
                tone={
                  req.status === "executed" ? "success" : req.status === "ic_approved" ? "primary" : "neutral"
                }
              >
                <CheckCircle2 className="h-3 w-3" />
                {req.status}
              </GlassBadge>
            }
          >
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <GlassKpi label="Status" value={req.status} />
              <GlassKpi
                label="Executed at"
                value={req.executed_at ? new Date(req.executed_at).toLocaleString("en-ZA") : "—"}
              />
              <GlassKpi
                label="Proposed moves"
                value={String(
                  Array.isArray(req.proposed_composition)
                    ? (req.proposed_composition as unknown[]).length
                    : 0,
                )}
              />
              <GlassKpi
                label="Affected investors"
                value={String(
                  Array.isArray(req.affected_investors) ? (req.affected_investors as unknown[]).length : 0,
                )}
              />
            </div>
            {req.research_note_id ? (
              <p className="mt-3 text-xs text-muted-foreground">
                Linked research note:{" "}
                <Link
                  className="font-mono text-primary hover:underline"
                  href={`/oems/research-lab?tab=ic&focus=${encodeURIComponent(req.research_note_id)}`}
                >
                  {req.research_note_id.slice(0, 8)}…
                </Link>
              </p>
            ) : null}
          </GlassSection>

          <GlassSection
            title="Proposed composition"
            subtitle="From the originating research note"
            endpoint="GET /api/rebalance/requests"
            db="institutional"
            dataSource={q.data?.notice ? "unavailable" : "supabase"}
          >
            {Array.isArray(req.proposed_composition) && req.proposed_composition.length > 0 ? (
              <div className="overflow-x-auto rounded-xl border border-[hsl(var(--glass-border))]">
                <table className="w-full min-w-[640px]">
                  <thead>
                    <tr className="border-b border-[hsl(var(--glass-border))] bg-[hsl(var(--foreground)/0.02)]">
                      {["Symbol", "Action", "Shares", "Weight"].map((c) => (
                        <th
                          key={c}
                          className="px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-wider text-muted-foreground"
                        >
                          {c}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {(req.proposed_composition as Array<Record<string, unknown>>).map((p, idx) => (
                      <tr
                        key={`${String(p.symbol ?? p.ticker ?? "row")}-${idx}`}
                        className="border-b border-[hsl(var(--glass-border))]/40 last:border-b-0"
                      >
                        <td className="px-3 py-2 font-mono text-xs">{String(p.symbol ?? p.ticker ?? "—")}</td>
                        <td className="px-3 py-2">
                          <Badge
                            variant={
                              p.action === "add" || p.action === "increase"
                                ? "default"
                                : p.action === "remove" || p.action === "decrease"
                                  ? "destructive"
                                  : "outline"
                            }
                          >
                            {String(p.action ?? "hold")}
                          </Badge>
                        </td>
                        <td className="px-3 py-2 text-right font-mono text-xs">
                          {typeof p.shares === "number" ? p.shares : "—"}
                        </td>
                        <td className="px-3 py-2 text-right font-mono text-xs">
                          {typeof p.weight === "number" ? `${(p.weight * 100).toFixed(1)}%` : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <EmptyDataState
                title="No composition attached"
                message="The originating research note did not include proposed_composition rows."
              />
            )}
          </GlassSection>

          <div className="flex flex-wrap items-center gap-2">
            <Button asChild variant="outline" className="gap-1.5">
              <Link href="/oems/research-lab?tab=rebalance">
                <ExternalLink className="h-3.5 w-3.5" /> Open Rebalance Builder
              </Link>
            </Button>
            {req.research_note_id ? (
              <Button asChild variant="outline" className="gap-1.5">
                <Link href={`/oems/research-lab?tab=ic&focus=${encodeURIComponent(req.research_note_id)}`}>
                  <ExternalLink className="h-3.5 w-3.5" /> Open IC view
                </Link>
              </Button>
            ) : null}
          </div>
        </>
      )}
    </ResearchLabCanvas>
  );
}

export default function Page() {
  // useSearchParams() must sit under a Suspense boundary or the static export
  // bails out ("missing-suspense-with-csr-bailout"), which fails the build.
  return (
    <React.Suspense fallback={<ResearchLabCanvas><PanelSkeleton rows={4} /></ResearchLabCanvas>}>
      <ApprovedRebalanceView />
    </React.Suspense>
  );
}
