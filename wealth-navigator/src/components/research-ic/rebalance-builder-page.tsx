"use client";

/**
 * Rebalance Builder — build a proposal instrument-by-instrument. Left: the
 * working basket (trim / grow / drop, live prices → live weights). Right: the
 * resulting proposed basket + changes pending. Submit to IC writes a
 * rebalance_request_c (status=pending); the IC gate promotes it to ic_approved,
 * after which "Send to Order Book" pushes it into oems_order_audit.
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Plus, Rocket, Send, X } from "lucide-react";
import Link from "next/link";
import * as React from "react";

import { GlassSection, ResearchLabCanvas } from "@/components/oems/primitives/glass";
import { cn } from "@/lib/cn";
import type { CompAction, ProposedHolding, RebalanceRequest, ResearchPerms } from "./types";
import { moneyR, rebalanceCodeMap, useQuotes, weightPct } from "./ui";

type Holding = { ticker: string; name: string; shares: number };
type StrategyOpt = { id: string; name: string };

function keyOf(h: Holding) {
  return h.ticker.toUpperCase();
}

export function RebalanceBuilderPage({
  perms,
  viewerEmail,
  initialStrategyId,
  initialStrategyName,
}: {
  perms: ResearchPerms;
  viewerEmail: string | null;
  initialStrategyId?: string;
  initialStrategyName?: string;
}) {
  void viewerEmail;
  const qc = useQueryClient();

  // Real strategy catalogue (for the dropdown).
  const strategiesQ = useQuery<{ strategies?: Array<{ id: string; name: string }> }>({
    queryKey: ["ric-strategies"],
    queryFn: async () => (await fetch("/api/strategies", { cache: "no-store" })).json(),
  });
  const strategies: StrategyOpt[] = (strategiesQ.data?.strategies ?? []).map((s) => ({
    id: s.id,
    name: s.name,
  }));

  const [strategyId, setStrategyId] = React.useState<string>(initialStrategyId ?? "");
  React.useEffect(() => {
    if (strategyId) return;
    if (initialStrategyId && strategies.some((s) => s.id === initialStrategyId)) {
      setStrategyId(initialStrategyId);
    } else if (strategies.length && strategies[0]) {
      setStrategyId(strategies[0].id);
    }
  }, [strategies, strategyId, initialStrategyId]);
  const strategyName =
    strategies.find((s) => s.id === strategyId)?.name ?? initialStrategyName ?? strategyId;

  // Real current basket for the selected strategy (strategies_c.holdings).
  const compQ = useQuery<{ holdings?: Array<{ ticker: string; name: string; shares: number }> }>({
    queryKey: ["ric-composition", strategyId],
    enabled: !!strategyId,
    queryFn: async () =>
      (await fetch(`/api/strategies/${strategyId}/composition`, { cache: "no-store" })).json(),
  });
  const baseline: Holding[] = (compQ.data?.holdings ?? []).map((h) => ({
    ticker: h.ticker,
    name: h.name,
    shares: h.shares,
  }));

  const [working, setWorking] = React.useState<Holding[]>([]);
  const [addOpen, setAddOpen] = React.useState(false);
  const [addTicker, setAddTicker] = React.useState("");
  const [addShares, setAddShares] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const [pushingId, setPushingId] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    setWorking(baseline.map((h) => ({ ...h })));
    setAddOpen(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [strategyId, compQ.data]);

  const tickers = Array.from(new Set([...working.map(keyOf), ...baseline.map(keyOf)]));
  const quotes = useQuotes(tickers);
  const priceOf = (t: string) => quotes.data?.[t.toUpperCase()]?.last ?? null;
  const holdingValue = (h: Holding) => (priceOf(h.ticker) ?? 0) * h.shares;
  const basketValue = working.reduce((s, h) => s + holdingValue(h), 0);
  const weightOf = (h: Holding) => (basketValue > 0 ? (holdingValue(h) / basketValue) * 100 : 0);

  const baseByKey = new Map(baseline.map((b) => [keyOf(b), b]));
  const workByKey = new Map(working.map((w) => [keyOf(w), w]));
  let changes = 0;
  for (const w of working) {
    const b = baseByKey.get(keyOf(w));
    if (!b || b.shares !== w.shares) changes += 1;
  }
  for (const b of baseline) if (!workByKey.has(keyOf(b))) changes += 1;

  const setShares = (t: string, delta: number) =>
    setWorking((prev) =>
      prev.map((h) => (keyOf(h) === t ? { ...h, shares: Math.max(0, h.shares + delta) } : h)),
    );
  const removeHolding = (t: string) => setWorking((prev) => prev.filter((h) => keyOf(h) !== t));
  const addHolding = () => {
    const t = addTicker.trim().toUpperCase();
    const sh = Number(addShares);
    if (!t || !Number.isFinite(sh) || sh <= 0) return;
    setWorking((prev) =>
      prev.some((h) => keyOf(h) === t) ? prev : [...prev, { ticker: t, name: t, shares: sh }],
    );
    setAddTicker("");
    setAddShares("");
    setAddOpen(false);
  };

  function actionFor(h: Holding): CompAction {
    const b = baseByKey.get(keyOf(h));
    if (!b) return "add";
    if (h.shares > b.shares) return "increase";
    if (h.shares < b.shares) return "decrease";
    return "hold";
  }

  async function submitToIc() {
    setError(null);
    setSubmitting(true);
    try {
      const current_composition: ProposedHolding[] = baseline.map((b) => ({
        ticker: b.ticker,
        name: b.name,
        shares: b.shares,
        price: priceOf(b.ticker) ?? undefined,
      }));
      const proposed_composition: ProposedHolding[] = [
        ...working.map((h) => ({
          ticker: h.ticker,
          name: h.name,
          shares: h.shares,
          price: priceOf(h.ticker) ?? undefined,
          weight: Number(weightOf(h).toFixed(2)),
          action: actionFor(h),
        })),
        ...baseline
          .filter((b) => !workByKey.has(keyOf(b)))
          .map((b) => ({
            ticker: b.ticker,
            name: b.name,
            shares: 0,
            weight: 0,
            action: "remove" as CompAction,
          })),
      ];
      const res = await fetch("/api/rebalance/requests", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ strategy_id: strategyName, current_composition, proposed_composition }),
      });
      const json = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !json.ok) {
        setError(json.error ?? `Submit failed (${res.status}).`);
        return;
      }
      await qc.invalidateQueries({ queryKey: ["ric-rebalance-requests"] });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <ResearchLabCanvas>
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-xl font-semibold tracking-tight">Rebalance Builder</h1>
          <p className="text-caption">
            Build a proposal instrument-by-instrument · every change needs research · IC gates execution.
          </p>
        </div>
        <select
          value={strategyId}
          onChange={(e) => setStrategyId(e.target.value)}
          className="rounded-lg border border-[hsl(var(--glass-border))] bg-[hsl(var(--foreground)/0.03)] px-3 py-2 text-sm outline-none focus:border-primary/50"
        >
          {strategies.length === 0 && <option value="">Loading strategies…</option>}
          {strategies.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </header>

      {error && (
        <p className="rounded-lg border border-[hsl(var(--down)/0.35)] bg-[hsl(var(--down)/0.1)] px-3 py-2 text-xs text-down">
          {error}
        </p>
      )}

      <div className="grid gap-5 lg:grid-cols-2">
        {/* working / current basket */}
        <GlassSection
          title="Current basket — click to trim / grow"
          right={
            <button
              type="button"
              onClick={() => setAddOpen((v) => !v)}
              className="inline-flex items-center gap-1 rounded-md border border-[hsl(var(--glass-border))] px-2 py-1 text-[11px] hover:bg-[hsl(var(--foreground)/0.05)]"
            >
              <Plus className="h-3 w-3" /> Add stock
            </button>
          }
          noPadding
        >
          {addOpen && (
            <div className="flex items-center gap-2 border-b border-[hsl(var(--glass-border))] px-5 py-3">
              <input
                value={addTicker}
                onChange={(e) => setAddTicker(e.target.value)}
                placeholder="Ticker"
                className="w-24 rounded-md border border-[hsl(var(--glass-border))] bg-[hsl(var(--foreground)/0.03)] px-2 py-1 text-sm outline-none"
              />
              <input
                value={addShares}
                onChange={(e) => setAddShares(e.target.value)}
                placeholder="Units"
                inputMode="numeric"
                className="w-24 rounded-md border border-[hsl(var(--glass-border))] bg-[hsl(var(--foreground)/0.03)] px-2 py-1 text-sm outline-none"
              />
              <button
                type="button"
                onClick={addHolding}
                className="rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground"
              >
                Add
              </button>
            </div>
          )}
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[hsl(var(--glass-border))] text-left text-[10px] uppercase tracking-wide text-muted-foreground">
                  <th className="px-5 py-2 font-medium">Ticker</th>
                  <th className="px-3 py-2 font-medium">Name</th>
                  <th className="px-3 py-2 text-right font-medium">Units</th>
                  <th className="px-3 py-2 text-right font-medium">Price</th>
                  <th className="px-3 py-2 text-right font-medium">Weight</th>
                  <th className="px-5 py-2 text-right font-medium">Action</th>
                </tr>
              </thead>
              <tbody>
                {working.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-5 py-6 text-center text-caption">
                      {compQ.isLoading
                        ? "Loading current basket…"
                        : "No holdings for this strategy yet. Add stocks to build a proposal."}
                    </td>
                  </tr>
                )}
                {working.map((h) => (
                  <tr key={keyOf(h)} className="border-b border-[hsl(var(--glass-border))] last:border-0">
                    <td className="px-5 py-2 font-semibold text-primary">{h.ticker}</td>
                    <td className="px-3 py-2 text-foreground/85">{h.name}</td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">{h.shares}</td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums text-muted-foreground">
                      {moneyR(priceOf(h.ticker))}
                    </td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">{weightPct(weightOf(h))}</td>
                    <td className="px-5 py-2">
                      <div className="flex items-center justify-end gap-1">
                        <button
                          type="button"
                          onClick={() => setShares(keyOf(h), +1)}
                          className="rounded p-1 text-muted-foreground hover:text-up"
                        >
                          <ArrowUp className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => setShares(keyOf(h), -1)}
                          className="rounded p-1 text-muted-foreground hover:text-down"
                        >
                          <ArrowDown className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => removeHolding(keyOf(h))}
                          className="rounded p-1 text-muted-foreground hover:text-down"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-between border-t border-[hsl(var(--glass-border))] px-5 py-2.5 text-xs">
            <span className="uppercase tracking-wide text-muted-foreground">Basket value</span>
            <span className="font-mono font-semibold tabular-nums">{moneyR(basketValue)}</span>
          </div>
        </GlassSection>

        {/* proposed basket */}
        <GlassSection
          title="Proposed basket"
          subtitle={`${changes} change${changes === 1 ? "" : "s"} pending`}
          right={
            <button
              type="button"
              onClick={submitToIc}
              disabled={submitting || changes === 0 || !perms.raiseRebalance}
              className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
            >
              <Send className="h-3.5 w-3.5" /> {submitting ? "Submitting…" : "Submit to IC"}
            </button>
          }
          noPadding
        >
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[hsl(var(--glass-border))] text-left text-[10px] uppercase tracking-wide text-muted-foreground">
                  <th className="px-5 py-2 font-medium">Ticker</th>
                  <th className="px-3 py-2 font-medium">Name</th>
                  <th className="px-3 py-2 text-right font-medium">Units</th>
                  <th className="px-3 py-2 text-right font-medium">Price</th>
                  <th className="px-5 py-2 text-right font-medium">Weight</th>
                </tr>
              </thead>
              <tbody>
                {working.map((h) => {
                  const b = baseByKey.get(keyOf(h));
                  const changed = !b || b.shares !== h.shares;
                  return (
                    <tr
                      key={keyOf(h)}
                      className={cn(
                        "border-b border-[hsl(var(--glass-border))] last:border-0",
                        changed && "bg-primary/5",
                      )}
                    >
                      <td className="px-5 py-2 font-semibold text-primary">{h.ticker}</td>
                      <td className="px-3 py-2 text-foreground/85">{h.name}</td>
                      <td className="px-3 py-2 text-right font-mono tabular-nums">{h.shares}</td>
                      <td className="px-3 py-2 text-right font-mono tabular-nums text-muted-foreground">
                        {moneyR(priceOf(h.ticker))}
                      </td>
                      <td className="px-5 py-2 text-right font-mono tabular-nums">
                        {weightPct(weightOf(h))}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-between border-t border-[hsl(var(--glass-border))] px-5 py-2.5 text-xs">
            <span className="uppercase tracking-wide text-muted-foreground">Basket value</span>
            <span className="font-mono font-semibold tabular-nums">{moneyR(basketValue)}</span>
          </div>
        </GlassSection>
      </div>

      <ProposalsList pushingId={pushingId} setPushingId={setPushingId} canPush={perms.pushRebalance} />
    </ResearchLabCanvas>
  );
}

function ProposalsList({
  pushingId,
  setPushingId,
  canPush,
}: {
  pushingId: string | null;
  setPushingId: (id: string | null) => void;
  canPush: boolean;
}) {
  const qc = useQueryClient();
  const q = useQuery<{ requests: RebalanceRequest[]; notice?: string }>({
    queryKey: ["ric-rebalance-requests"],
    refetchInterval: 30_000,
    queryFn: async () => {
      const res = await fetch("/api/rebalance/requests", { cache: "no-store" });
      return (await res.json().catch(() => ({ requests: [] }))) as {
        requests: RebalanceRequest[];
        notice?: string;
      };
    },
  });
  const requests = q.data?.requests ?? []; // show all; the status chip differentiates
  const codes = rebalanceCodeMap(requests);

  async function push(id: string) {
    setPushingId(id);
    try {
      await fetch(`/api/rebalance/requests/${id}/push`, { method: "POST" });
      await qc.invalidateQueries({ queryKey: ["ric-rebalance-requests"] });
    } finally {
      setPushingId(null);
    }
  }

  const STATUS_TONE: Record<string, string> = {
    pending: "border-primary/35 bg-primary/12 text-primary",
    ic_approved: "border-[hsl(var(--up)/0.35)] bg-[hsl(var(--up)/0.12)] text-up",
    executed: "border-[hsl(var(--glass-border))] bg-[hsl(var(--foreground)/0.05)] text-muted-foreground",
    rejected: "border-[hsl(var(--down)/0.35)] bg-[hsl(var(--down)/0.12)] text-down",
    cancelled: "border-[hsl(var(--glass-border))] bg-[hsl(var(--foreground)/0.05)] text-muted-foreground",
  };

  return (
    <GlassSection title="Proposals — at IC or executed" endpoint="GET /api/rebalance/requests">
      {q.data?.notice && <p className="mb-3 text-xs text-amber-500">{q.data.notice}</p>}
      {requests.length === 0 && !q.isLoading ? (
        <p className="text-caption">No proposals yet. Build one above and submit it to the IC.</p>
      ) : (
        <div className="space-y-2">
          {requests.map((r) => {
            const changes = Array.isArray(r.proposed_composition)
              ? r.proposed_composition.filter((h) => h.action && h.action !== "hold").length
              : 0;
            return (
              <div
                key={r.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[hsl(var(--glass-border))] px-4 py-3"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <span
                    className={cn(
                      "rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
                      STATUS_TONE[r.status] ?? STATUS_TONE.pending,
                    )}
                  >
                    {r.status.replace("_", " ")}
                  </span>
                  <span className="font-mono text-xs text-muted-foreground">{codes.get(r.id) ?? "REB"}</span>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{r.strategy_id}</p>
                    <p className="text-caption">
                      {changes} change{changes === 1 ? "" : "s"} · raised by {r.requested_by}
                    </p>
                  </div>
                </div>
                <div className="shrink-0">
                  {r.status === "pending" && (
                    <Link
                      href="/oems/committee"
                      className="inline-flex items-center gap-1 rounded-lg border border-[hsl(var(--glass-border))] px-3 py-1.5 text-xs hover:bg-[hsl(var(--foreground)/0.05)]"
                    >
                      At IC
                    </Link>
                  )}
                  {r.status === "ic_approved" && (
                    <button
                      type="button"
                      onClick={() => push(r.id)}
                      disabled={!canPush || pushingId === r.id}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
                    >
                      <Rocket className="h-3.5 w-3.5" />{" "}
                      {pushingId === r.id ? "Sending…" : "Send to Order Book"}
                    </button>
                  )}
                  {r.status === "executed" && <span className="text-xs text-muted-foreground">Executed</span>}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </GlassSection>
  );
}
