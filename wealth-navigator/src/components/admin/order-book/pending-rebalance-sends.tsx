"use client";

import { ChevronRight, Loader2, Rocket } from "lucide-react";
import * as React from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useAdmin } from "@/lib/admin/context";
import { cn } from "@/lib/cn";
import { usePolling } from "@/lib/hooks/use-polling";
import { MasterSendConfirmDialog } from "./master-send-confirm-dialog";

/**
 * A rebalance's IC approval (`ic_approved`) is a pure decision — nothing has
 * been written anywhere yet, so an admin can see exactly what's about to
 * change before it does. This panel is the review surface, entirely native
 * to this app's own `rebalance_request_c` queue — deliberately separate
 * from `RebalanceBooks` below it, which reads CRM's own read-only
 * `rebalance_batch`/`rebalance_event` tables.
 *
 * Three stages, each an explicit action — nothing ever "hits the order
 * book" as a side effect of an earlier one:
 *   1. ic_approved  — pure decision, nothing written yet.
 *   2. "Release to Rebalance Tab" (-> executed) — reconcileParkedHoldings /
 *      bookSettledRebalanceOrders run, parking real orders in
 *      oems_order_audit tagged source="PAPER_MODEL_REBALANCE". These orders
 *      exist for real now, but deliberately stay OFF the Active Orderbook —
 *      they only show up right here, expanded under the executed row.
 *   3. "Send to Order Book" (release-to-orderbook route) — flips those
 *      orders' source to MINT_CLIENT_ORDER, the same bucket a normal app
 *      order lives in. Only from this point on do they appear on Active
 *      Orderbook and become sendable to market.
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
interface BookedOrder {
  id: string;
  symbol: string;
  side: string;
  quantity: number;
  price_cents: number | null;
  status: string;
  source: string;
  client_account: string | null;
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
  // Same tier the server checks in lib/admin/step-up.ts ("dev" does not satisfy
  // it there, so it must not here either).
  const { ctx } = useAdmin();
  const isMaster = ctx.approverTier === "master";
  const [bookingId, setBookingId] = React.useState<string | null>(null);
  const [cancellingId, setCancellingId] = React.useState<string | null>(null);
  const [releasingId, setReleasingId] = React.useState<string | null>(null);
  const [completingId, setCompletingId] = React.useState<string | null>(null);
  const [expanded, setExpanded] = React.useState<Set<string>>(new Set());
  const [expandedHistory, setExpandedHistory] = React.useState<Set<string>>(new Set());
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
    `/api/rebalance/requests?status=ic_approved&scope=${scope}`,
    { interval: 15_000 },
  );
  const executedQuery = usePolling<{ requests?: RebalanceRequestRow[] }>(
    `/api/rebalance/requests?status=executed&scope=${scope}`,
    { interval: 15_000 },
  );
  const completingQuery = usePolling<{ requests?: RebalanceRequestRow[] }>(
    `/api/rebalance/requests?status=completing&scope=${scope}`,
    { interval: 15_000 },
  );
  const completedQuery = usePolling<{ requests?: RebalanceRequestRow[] }>(
    `/api/rebalance/requests?status=completed&scope=${scope}`,
    { interval: 15_000 },
  );

  const inScope = (r: RebalanceRequestRow) =>
    scope === "uat" ? testStrategyNames.has(r.strategy_id) : !testStrategyNames.has(r.strategy_id);

  const pending = (approvedQuery.data?.requests ?? []).filter(inScope);
  const history = [
    ...(executedQuery.data?.requests ?? []),
    ...(completingQuery.data?.requests ?? []),
    ...(completedQuery.data?.requests ?? []),
  ]
    .filter(inScope)
    .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at))
    .slice(0, 10);

  const refreshHistory = () =>
    Promise.all([executedQuery.refresh(), completingQuery.refresh(), completedQuery.refresh()]);

  async function transition(id: string, toStatus: "executed" | "cancelled") {
    const res = await fetch(`/api/rebalance/requests/${id}/transition`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to_status: toStatus }),
    });
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (!res.ok || !body.ok) {
      window.alert(
        body.error ?? `Failed to ${toStatus === "executed" ? "release to the Rebalance tab" : "cancel"}.`,
      );
    }
    await Promise.all([approvedQuery.refresh(), refreshHistory()]);
  }

  async function releaseToRebalanceTab(id: string) {
    setBookingId(id);
    try {
      await transition(id, "executed");
    } finally {
      setBookingId(null);
    }
  }

  async function cancelProposal(id: string) {
    if (!window.confirm("Cancel this IC-approved rebalance? It will not be released to the Rebalance tab."))
      return;
    setCancellingId(id);
    try {
      await transition(id, "cancelled");
    } finally {
      setCancellingId(null);
    }
  }

  async function releaseToOrderBook(id: string) {
    // Password re-entry was removed 2026-08-17 at the user's request. The
    // server (lib/admin/step-up.ts) still requires a Master ★ account for a
    // live-scope release.
    setReleasingId(id);
    try {
      const res = await fetch(`/api/rebalance/requests/${id}/release-to-orderbook`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !body.ok) {
        window.alert(body.error ?? "Failed to send to order book.");
      }
      await refreshHistory();
    } finally {
      setReleasingId(null);
    }
  }

  async function retryUatSettlement(id: string) {
    setCompletingId(id);
    try {
      const res = await fetch(`/api/rebalance/requests/${id}/retry-settlement`, { method: "POST" });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !body.ok) {
        window.alert(body.error ?? "UAT settlement could not be completed.");
      } else {
        window.alert("UAT rebalance settlement completed. Refresh the strategy to see the updated model basket.");
      }
      await refreshHistory();
    } finally {
      setCompletingId(null);
    }
  }

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card/40">
      <div className="border-b border-border px-4 py-3">
        <h2 className="text-xs font-semibold uppercase text-muted-foreground">
          Ready to Release to Rebalance Tab
        </h2>
      </div>
      {approvedQuery.loading ? (
        <div className="px-4 py-8 text-center text-xs text-muted-foreground">Loading approvals...</div>
      ) : pending.length === 0 ? (
        <div className="px-4 py-6 text-center text-xs text-muted-foreground">
          No IC-approved rebalances awaiting release.
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
                      disabled={cancellingId === r.id || bookingId === r.id}
                    >
                      {cancellingId === r.id ? (
                        <>
                          <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> Cancelling...
                        </>
                      ) : (
                        "Cancel"
                      )}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      onClick={() => releaseToRebalanceTab(r.id)}
                      disabled={bookingId === r.id || cancellingId === r.id}
                    >
                      {bookingId === r.id ? (
                        <>
                          <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> Releasing...
                        </>
                      ) : (
                        "Release to Rebalance Tab"
                      )}
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
        On Rebalance Tab ({history.length})
      </button>
      {showHistory ? (
        <div className="divide-y divide-border/50 border-t border-border/40">
          {history.length === 0 ? (
            <div className="px-4 py-4 text-center text-xs text-muted-foreground">Nothing released yet.</div>
          ) : (
            history.map((r) => (
              <BookedRebalanceRow
                key={r.id}
                r={r}
                open={expandedHistory.has(r.id)}
                onToggle={() =>
                  setExpandedHistory((current) => {
                    const next = new Set(current);
                    if (next.has(r.id)) next.delete(r.id);
                    else next.add(r.id);
                    return next;
                  })
                }
                releasing={releasingId === r.id}
                onRelease={r.status === "executed" ? () => releaseToOrderBook(r.id) : undefined}
                completing={completingId === r.id}
                onRetrySettlement={scope === "uat" && r.status !== "completed" ? () => retryUatSettlement(r.id) : undefined}
                // Mirrors release-to-orderbook/route.ts, which only applies the
                // master step-up when the request is NOT uat-scoped. Demanding
                // master on a UAT release here would block something the server
                // would have happily allowed.
                requiresMaster={scope !== "uat"}
                isMaster={isMaster}
              />
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}

function BookedRebalanceRow({
  r,
  open,
  onToggle,
  releasing,
  onRelease,
  completing,
  onRetrySettlement,
  requiresMaster,
  isMaster,
}: {
  r: RebalanceRequestRow;
  open: boolean;
  onToggle: () => void;
  releasing: boolean;
  onRelease?: () => Promise<void>;
  completing: boolean;
  onRetrySettlement?: () => Promise<void>;
  /** false for UAT-scoped requests, which the server releases without step-up. */
  requiresMaster: boolean;
  isMaster: boolean;
}) {
  const ordersQuery = usePolling<{ orders?: BookedOrder[] }>(`/api/rebalance/requests/${r.id}/orders`, {
    interval: open ? 10_000 : 60_000,
    query: { enabled: open },
  });
  const orders = ordersQuery.data?.orders ?? [];
  const stillParked = orders.filter((o) => o.source === "PAPER_MODEL_REBALANCE" && o.status === "parked");
  const released = orders.length > 0 && stillParked.length === 0;
  const allFilled = orders.length > 0 && orders.every((o) => o.status === "filled");

  const [confirmOpen, setConfirmOpen] = React.useState(false);

  // onRelease only refreshes the parent's request list — this row's own
  // order table polls separately (up to 10s while expanded) and wouldn't
  // otherwise reflect the release for a few seconds, making a successful
  // click look like it did nothing and inviting a second one.
  async function handleRelease() {
    if (!onRelease) return;
    try {
      await onRelease();
      await ordersQuery.refresh();
    } finally {
      setConfirmOpen(false);
    }
  }

  return (
    <div>
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-2">
          <button
            type="button"
            className="flex min-w-0 items-center gap-2 text-left text-xs font-medium"
            onClick={onToggle}
          >
          <ChevronRight className={cn("h-3.5 w-3.5 shrink-0 transition-transform", open && "rotate-90")} />
          <span className="truncate">Rebalance · {r.strategy_id}</span>
        </button>
        <div className="flex items-center gap-2">
          <Badge variant={r.status === "completed" ? "success" : "outline"}>
            {r.status === "completed" ? "Completed" : r.status === "completing" ? "Completing" : released ? "In Order Book" : "On Rebalance Tab"}
          </Badge>
          <span className="text-[11px] text-muted-foreground">
            {r.executed_at ? new Date(r.executed_at).toLocaleString("en-ZA") : "—"}
          </span>
          {onRelease && !released && stillParked.length > 0 ? (
            <Button
              type="button"
              size="sm"
              onClick={() => setConfirmOpen(true)}
              disabled={releasing}
              title={
                requiresMaster && !isMaster
                  ? "Only a Master ★ account can send orders to the order book."
                  : "Release this rebalance's parked orders into the order book."
              }
            >
              {releasing ? (
                <>
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> Sending...
                </>
              ) : (
                <>
                  <Rocket className="mr-1.5 h-3.5 w-3.5" /> Send to Order Book
                </>
              )}
            </Button>
          ) : null}
          {allFilled && onRetrySettlement ? (
            <Button type="button" size="sm" variant="outline" onClick={onRetrySettlement} disabled={completing}>
              {completing ? <><Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> Settling...</> : "Retry settlement"}
            </Button>
          ) : null}
        </div>
      </div>
      {open ? (
        <div className="overflow-x-auto border-t border-border/40 px-4 py-2">
          {ordersQuery.loading ? (
            <p className="text-[11px] text-muted-foreground">Loading orders...</p>
          ) : orders.length === 0 ? (
            <p className="text-[11px] text-muted-foreground">No orders booked for this rebalance.</p>
          ) : (
            <table className="w-full text-[11px]">
              <thead>
                <tr className="text-left text-[10px] uppercase text-muted-foreground">
                  <th className="py-1 pr-3">Client</th>
                  <th className="py-1 pr-3">Symbol</th>
                  <th className="py-1 pr-3">Side</th>
                  <th className="py-1 pr-3 text-right">Qty</th>
                  <th className="py-1 pr-3">Status</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((o) => (
                  <tr key={o.id} className="border-t border-border/30">
                    <td className="py-1.5 pr-3 font-medium">{o.client_account ?? "—"}</td>
                    <td className="py-1.5 pr-3">{o.symbol}</td>
                    <td className="py-1.5 pr-3 uppercase">{o.side}</td>
                    <td className="py-1.5 pr-3 text-right">{o.quantity}</td>
                    <td className="py-1.5 pr-3">{o.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ) : null}

      <MasterSendConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        // A UAT release needs no master tier server-side, so never show the
        // "master required" refusal for one — pass true to go straight to the
        // ordinary are-you-sure.
        isMaster={!requiresMaster || isMaster}
        title={`${stillParked.length} parked order${stillParked.length === 1 ? "" : "s"} from this rebalance will be released into the order book.`}
        summary={
          <>
            Rebalance · <span className="font-mono font-semibold">{r.strategy_id}</span> ·{" "}
            <span className="font-semibold">{stillParked.length}</span> order
            {stillParked.length === 1 ? "" : "s"} → order book
          </>
        }
        confirmLabel="Yes, execute order"
        pending={releasing}
        onConfirm={() => void handleRelease()}
      />
    </div>
  );
}
