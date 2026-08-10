"use client";

import { ChevronRight, Send } from "lucide-react";
import * as React from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { usePolling } from "@/lib/hooks/use-polling";

/**
 * A rebalance's IC approval (`ic_approved`) is a pure decision — nothing has
 * been written anywhere yet, so an admin can see exactly what's about to
 * change before it does. This panel is that review surface: it lists
 * `rebalance_request_c` rows waiting to be sent, and a short recent history
 * of ones already sent. Clicking "Send to Order Book" fires the transition
 * that actually reprices parked clients and books settled clients' delta
 * orders (see requests/[id]/transition/route.ts, toStatus="executed").
 *
 * Deliberately separate from `RebalanceBooks` below it on this tab — that
 * component reads CRM's own `rebalance_batch`/`rebalance_event` tables and
 * this app has no write access to them; this one is native to this app's own
 * `rebalance_request_c` queue and never touches CRM's tables.
 */

interface ProposedLine {
  ticker: string;
  action?: string;
  shares?: number | null;
}
interface RebalanceRequestRow {
  id: string;
  strategy_id: string;
  status: string;
  proposed_composition: ProposedLine[];
  executed_at: string | null;
  created_at: string;
  updated_at: string;
}
interface Strategy {
  id: string;
  name: string;
  investorEnvironment?: "LIVE" | "UAT";
}

function summarizeChanges(lines: ProposedLine[]): string {
  const changed = lines.filter((l) => l.action && l.action !== "hold");
  if (changed.length === 0) return "No changes";
  return changed
    .map((l) => {
      const sign = l.action === "sell" || l.action === "decrease" ? "-" : "+";
      return `${l.ticker} ${sign}${Math.abs(Number(l.shares) || 0)}`;
    })
    .join(", ");
}

export function PendingRebalanceSends({ scope = "live" }: { scope?: "live" | "uat" }) {
  const [sendingId, setSendingId] = React.useState<string | null>(null);
  const [cancellingId, setCancellingId] = React.useState<string | null>(null);
  const [expanded, setExpanded] = React.useState<Set<string>>(new Set());
  const [showHistory, setShowHistory] = React.useState(false);

  const strategiesQuery = usePolling<{ strategies?: Strategy[] }>("/api/strategies", {
    interval: 60_000,
  });
  const testStrategyNames = new Set(
    (strategiesQuery.data?.strategies ?? [])
      .filter((s) => s.investorEnvironment === "UAT")
      .map((s) => s.name),
  );

  const approvedQuery = usePolling<{ requests?: RebalanceRequestRow[] }>(
    "/api/rebalance/requests?status=ic_approved",
    { interval: 15_000 },
  );
  const executedQuery = usePolling<{ requests?: RebalanceRequestRow[] }>(
    "/api/rebalance/requests?status=executed",
    { interval: 30_000 },
  );

  const inScope = (r: RebalanceRequestRow) =>
    scope === "uat" ? testStrategyNames.has(r.strategy_id) : !testStrategyNames.has(r.strategy_id);

  const pending = (approvedQuery.data?.requests ?? []).filter(inScope);
  const history = (executedQuery.data?.requests ?? []).filter(inScope).slice(0, 10);

  async function transition(id: string, toStatus: "executed" | "cancelled") {
    const res = await fetch(`/api/rebalance/requests/${id}/transition`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to_status: toStatus }),
    });
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (!res.ok || !body.ok) {
      window.alert(body.error ?? `Failed to ${toStatus === "executed" ? "send to order book" : "cancel"}.`);
    }
    await Promise.all([approvedQuery.refresh(), executedQuery.refresh()]);
  }

  async function sendToOrderBook(id: string) {
    setSendingId(id);
    try {
      await transition(id, "executed");
    } finally {
      setSendingId(null);
    }
  }

  async function cancelProposal(id: string) {
    if (!window.confirm("Cancel this IC-approved rebalance? It will not be sent to the order book.")) return;
    setCancellingId(id);
    try {
      await transition(id, "cancelled");
    } finally {
      setCancellingId(null);
    }
  }

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card/40">
      <div className="border-b border-border px-4 py-3">
        <h2 className="text-xs font-semibold uppercase text-muted-foreground">Ready to Send to Order Book</h2>
      </div>
      {approvedQuery.loading ? (
        <div className="px-4 py-8 text-center text-xs text-muted-foreground">Loading approvals...</div>
      ) : pending.length === 0 ? (
        <div className="px-4 py-6 text-center text-xs text-muted-foreground">
          No IC-approved rebalances awaiting Send to Order Book.
        </div>
      ) : (
        <div className="divide-y divide-border/50">
          {pending.map((r) => {
            const open = expanded.has(r.id);
            return (
              <div key={r.id}>
                <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                  <button
                    type="button"
                    className="flex min-w-0 items-center gap-2 text-left text-xs font-semibold"
                    onClick={() =>
                      setExpanded((current) => {
                        const next = new Set(current);
                        if (next.has(r.id)) next.delete(r.id);
                        else next.add(r.id);
                        return next;
                      })
                    }
                  >
                    <ChevronRight
                      className={cn("h-4 w-4 shrink-0 transition-transform", open && "rotate-90")}
                    />
                    <span className="truncate">Rebalance · {r.strategy_id}</span>
                  </button>
                  <div className="flex items-center gap-2">
                    <Badge variant="warning">IC Approved</Badge>
                    <span className="text-[11px] text-muted-foreground">
                      {new Date(r.updated_at).toLocaleString("en-ZA")}
                    </span>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => cancelProposal(r.id)}
                      disabled={cancellingId === r.id || sendingId === r.id}
                    >
                      {cancellingId === r.id ? "Cancelling..." : "Cancel"}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      onClick={() => sendToOrderBook(r.id)}
                      disabled={sendingId === r.id || cancellingId === r.id}
                    >
                      <Send className="mr-1.5 h-3.5 w-3.5" />
                      {sendingId === r.id ? "Sending..." : "Send to Order Book"}
                    </Button>
                  </div>
                </div>
                {open ? (
                  <div className="border-t border-border/40 px-4 py-2 text-[11px] text-muted-foreground">
                    {summarizeChanges(r.proposed_composition)}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
      <button
        type="button"
        className="flex w-full items-center gap-2 border-t border-border px-4 py-2 text-left text-[11px] text-muted-foreground hover:bg-accent/30"
        onClick={() => setShowHistory((v) => !v)}
      >
        <ChevronRight className={cn("h-3.5 w-3.5 transition-transform", showHistory && "rotate-90")} />
        Recently sent ({history.length})
      </button>
      {showHistory ? (
        <div className="divide-y divide-border/50 border-t border-border/40">
          {history.length === 0 ? (
            <div className="px-4 py-4 text-center text-xs text-muted-foreground">Nothing sent yet.</div>
          ) : (
            history.map((r) => (
              <div key={r.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-2">
                <span className="text-xs font-medium">Rebalance · {r.strategy_id}</span>
                <div className="flex items-center gap-2">
                  <Badge variant="success">Sent</Badge>
                  <span className="text-[11px] text-muted-foreground">
                    {r.executed_at ? new Date(r.executed_at).toLocaleString("en-ZA") : "—"}
                  </span>
                </div>
              </div>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}
