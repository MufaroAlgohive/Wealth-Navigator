"use client";

/**
 * Rebalance Builder — build a proposal instrument-by-instrument. Left: the
 * working basket (trim / grow / drop, live prices → live weights). Right: the
 * resulting proposed basket + changes pending. Submit to IC writes a
 * rebalance_request_c (status=pending); the IC gate promotes it to ic_approved,
 * after which "Send to Order Book" pushes it into oems_order_audit.
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, FlaskConical, Info, Plus, Rocket, Send, X } from "lucide-react";
import Link from "next/link";
import * as React from "react";

import { GlassSection, ResearchLabCanvas } from "@/components/oems/primitives/glass";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { cn } from "@/lib/cn";
import type { CompAction, ProposedHolding, RebalanceRequest, ResearchPerms } from "./types";
import { moneyR, rebalanceCodeMap, useQuotes, weightPct, ActionBadge } from "./ui";

type Holding = { ticker: string; name: string; shares: number };
type StrategyOpt = { id: string; name: string };

type ImpactLine = {
  symbol: string;
  action: string;
  currentQty: number;
  targetQty: number;
  deltaQty: number;
  side: "buy" | "sell";
  priceCents: number;
  valueCents: number;
};
type ImpactInvestor = {
  user_id: string;
  name: string;
  basketCents: number;
  walletCents: number;
  buyCents: number;
  sellCents: number;
  netCashCents: number;
  walletAfterCents: number;
  shortfall: boolean;
  grossSellCents: number;
  grossBuyCents: number;
  sellBrokerageCents: number;
  sellCustodyCents: number;
  sellFeesCents: number;
  netProceedsCents: number;
  buyBrokerageCents: number;
  buyCustodyCents: number;
  buyFeesCents: number;
  totalFeesCents: number;
  reserveCents: number;
  reserveUsedCents: number;
  reserveAfterCents: number;
  feeShortfallCents: number;
  cashAfterCents: number;
  lines: ImpactLine[];
};
type ImpactTotals = {
  investorCount: number;
  buyCents: number;
  sellCents: number;
  walletCents: number;
  walletAfterCents: number;
  netProceedsCents: number;
  sellFeesCents: number;
  buyFeesCents: number;
  totalFeesCents: number;
  reserveCents: number;
  reserveUsedCents: number;
  feeShortfallCents: number;
  cashOk: boolean;
};
type ImpactResponse = {
  ok?: boolean;
  scope?: string;
  investors?: ImpactInvestor[];
  totals?: ImpactTotals | null;
  feeConfig?: {
    brokerageRate: number;
    custodyFeeCents: number;
    source: string;
    updatedAt?: string | null;
  };
  notice?: string;
  error?: string;
};

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
  // Per-row rationale (freeform one-liner shown in the IC action table) and a
  // buyer-vs-seller choice when reducing a position. Required by Lonwabo's
  // meeting rule (transcript 2026-07-13): "you can't submit without saying
  // what you're buying" — every SELL action must be paired with a BUY action
  // and each row needs its own rationale text before submit.
  const [rationaleBySymbol, setRationaleBySymbol] = React.useState<Record<string, string>>({});
  const [proceedsDestination, setProceedsDestination] = React.useState("");
  const setRationale = (sym: string, v: string) =>
    setRationaleBySymbol((prev) => ({ ...prev, [sym.toUpperCase()]: v }));
  const [submitting, setSubmitting] = React.useState(false);
  const [pushingId, setPushingId] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  // Reset rationale when the basket switches strategies so old text doesn't
  // leak across strategies.
  React.useEffect(() => {
    setRationaleBySymbol({});
    setProceedsDestination("");
  }, [strategyId]);

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

  // Research gate: every changed name needs a research note (meeting rule:
  // "we can't rebalance to anything we don't have research of"). Institutional
  // research_note_c only; no client data.
  const changedTickers: string[] = [];
  for (const w of working) {
    const b = baseByKey.get(keyOf(w));
    if (!b || b.shares !== w.shares) changedTickers.push(keyOf(w));
  }
  for (const b of baseline) if (!workByKey.has(keyOf(b))) changedTickers.push(keyOf(b));
  const notesQ = useQuery<{
    notes?: Array<{ id: string; symbol: string; status: string; updated_at?: string }>;
  }>({
    queryKey: ["ric-notes"],
    queryFn: async () => (await fetch("/api/research/notes", { cache: "no-store" })).json(),
  });
  const notedSymbols = new Set(
    (notesQ.data?.notes ?? []).map((nte) => String(nte.symbol).toUpperCase()),
  );
  const missingResearch = changedTickers.filter((t) => !notedSymbols.has(t));
  // Pick the "best" research note per symbol: prefer approved, fall back to the
  // most-recently-updated. Used to build the R-<SYM>-<NN> researchRef code that
  // shows up in the IC action table and links through to the note.
  const noteBySymbol = React.useMemo(() => {
    const m = new Map<
      string,
      { id: string; symbol: string; status: string; updated_at?: string }
    >();
    for (const n of notesQ.data?.notes ?? []) {
      const k = String(n.symbol).toUpperCase();
      const prev = m.get(k);
      if (!prev) {
        m.set(k, n);
        continue;
      }
      // Approved wins; otherwise most-recently updated.
      if (prev.status !== "approved" && n.status === "approved") m.set(k, n);
      else if (
        prev.status !== "approved" &&
        n.status !== "approved" &&
        new Date(n.updated_at ?? 0).getTime() > new Date(prev.updated_at ?? 0).getTime()
      )
        m.set(k, n);
    }
    return m;
  }, [notesQ.data]);
  // Symbol → R-SYM-NN researchRef code (matches the Lovable spec table). The
  // numeric suffix is the per-symbol approved-note count (1-based).
  const researchRefFor = (sym: string): string | undefined => {
    const k = sym.toUpperCase();
    const note = noteBySymbol.get(k);
    if (!note) return undefined;
    const sameSymbol = (notesQ.data?.notes ?? []).filter(
      (n) => String(n.symbol).toUpperCase() === k,
    );
    // Approved notes count first; otherwise 1 — keeps the code stable across edits.
    const approvedIdx = sameSymbol
      .filter((n) => n.status === "approved")
      .findIndex((n) => n.id === note.id);
    const num = approvedIdx >= 0 ? approvedIdx + 1 : 1;
    return `R-${k}-${String(num).padStart(2, "0")}`;
  };

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

  // Shared proposed composition (target weights per name). Both Submit to IC and
  // the investor-impact panel derive from this so they never diverge. Each row
  // carries the BUY/SELL/HOLD action, an R-SYM-NN researchRef for the IC table,
  // and the analyst's freeform one-liner rationale.
  const proposedComposition: ProposedHolding[] = [
    ...working.map((h) => {
      const b = baseByKey.get(keyOf(h));
      const action = actionFor(h);
      const ref = researchRefFor(h.ticker);
      return {
        ticker: h.ticker,
        name: h.name,
        shares: h.shares,
        price: priceOf(h.ticker) ?? undefined,
        weight: Number(weightOf(h).toFixed(2)),
        action,
        researchRef: ref,
        rating: (notesQ.data?.notes ?? []).find(
          (n) => String(n.symbol).toUpperCase() === h.ticker.toUpperCase(),
        )
          ? undefined // Rating is in the note thesis; UI only renders the chip
          : undefined,
        rationale: rationaleBySymbol[h.ticker.toUpperCase()] || undefined,
        fromWeight: b ? Number(((priceOf(b.ticker) ?? 0) * b.shares / Math.max(working.reduce((s, hh) => s + (priceOf(hh.ticker) ?? 0) * hh.shares, 0), 1)) * 100).toFixed(2) : undefined,
        toWeight: Number(weightOf(h).toFixed(2)),
      };
    }),
    ...baseline
      .filter((b) => !workByKey.has(keyOf(b)))
      .map((b) => ({
        ticker: b.ticker,
        name: b.name,
        shares: 0,
        weight: 0,
        action: "remove" as CompAction,
        researchRef: researchRefFor(b.ticker),
        rationale: rationaleBySymbol[b.ticker.toUpperCase()] || undefined,
      })),
  ];

  // Per-row gate flags surfaced in the table + Submit button:
  //  • every changed name needs a research note (already enforced above)
  //  • every changed row needs a rationale (Lonwabo: "write a buy note")
  //  • basket-level: a SELL action requires at least one BUY action and at least
  //    one ADD/INCREASE with shares>0 — otherwise the cash can't land anywhere
  const rationalesMissing = changedTickers.filter(
    (t) => !(rationaleBySymbol[t] ?? "").trim(),
  );
  const sellActions = proposedComposition.filter(
    (p) => p.action === "remove" || p.action === "decrease",
  );
  const buyActions = proposedComposition.filter(
    (p) => (p.action === "add" || p.action === "increase") && (p.shares ?? 0) > 0,
  );
  const destinationSymbols = buyActions.map((row) => row.ticker.toUpperCase()).sort();
  const proposedDestination = destinationSymbols.length
    ? destinationSymbols.length === 1
      ? `BUY:${destinationSymbols[0]}`
      : `BUY:${destinationSymbols.join("+")}`
    : "";
  React.useEffect(() => {
    if (!sellActions.length || (proceedsDestination && proceedsDestination !== proposedDestination)) {
      setProceedsDestination("");
    }
  }, [proceedsDestination, proposedDestination, sellActions.length]);
  const proceedsPlanMissing = sellActions.length > 0 && proceedsDestination !== proposedDestination;

  // Investor impact — read-only, TEST CLIENTS ONLY (the server enforces is_test
  // and never reads a real client). Re-modelled whenever the proposed weights
  // change. This is the meeting's "affected investors / cash availability" gate.
  const impactSig = JSON.stringify(proposedComposition.map((p) => [p.ticker, p.action, p.weight]));
  const impactQ = useQuery<ImpactResponse>({
    queryKey: ["ric-impact", strategyId, impactSig],
    enabled: !!strategyId && changes > 0,
    queryFn: async () => {
      const res = await fetch("/api/rebalance/impact", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          strategy_id: strategyId,
          strategy_name: strategyName,
          proposed: proposedComposition,
        }),
      });
      return (await res.json().catch(() => ({ ok: false }))) as ImpactResponse;
    },
  });

  async function submitToIc() {
    setError(null);
    // Gates — short-circuit before opening the network tab.
    if (missingResearch.length) {
      setError(
        `Research required before submitting: ${missingResearch.join(", ")}. Add a note in the Research Library.`,
      );
      return;
    }
    if (rationalesMissing.length) {
      setError(
        `One-line rationale required for: ${rationalesMissing.join(", ")}. Tell the IC why.`,
      );
      return;
    }
    if (proceedsPlanMissing) {
      setError(
        buyActions.length
          ? "Confirm which proposed purchase will receive the sale proceeds."
          : "This sale has no replacement purchase. Add or increase an asset, then choose it as the proceeds destination.",
      );
      return;
    }
    if (impactQ.isFetching || !impactQ.data?.ok) {
      setError(
        impactQ.data?.error ??
          "Wait for the fee-adjusted investor impact preview before submitting this rebalance.",
      );
      return;
    }
    // Basket-level cash-availability gate: any per-investor shortfall blocks submit.
    if (impactQ.data?.totals && impactQ.data.totals.cashOk === false) {
      setError(
        "Insufficient cash across one or more investors. Trim something else or reduce the buy size.",
      );
      return;
    }
    setSubmitting(true);
    try {
      const current_composition: ProposedHolding[] = baseline.map((b) => ({
        ticker: b.ticker,
        name: b.name,
        shares: b.shares,
        price: priceOf(b.ticker) ?? undefined,
      }));
      const proposed_composition: ProposedHolding[] = proposedComposition;
      const res = await fetch("/api/rebalance/requests", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          strategy_id: strategyName,
          current_composition,
          proposed_composition,
          affected_investors: {
            scope: impactQ.data.scope,
            proceeds_destination: proceedsDestination,
            fee_config: impactQ.data.feeConfig,
            totals: impactQ.data.totals,
            investors: impactQ.data.investors,
          },
        }),
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

      {missingResearch.length > 0 && changes > 0 && (
        <p className="rounded-lg border border-amber-500/35 bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-400">
          Research required for {missingResearch.join(", ")} before this can go to the IC.{" "}
          <Link href="/oems/research" className="underline">
            Write a note
          </Link>
          .
        </p>
      )}
      {rationalesMissing.length > 0 && changes > 0 && missingResearch.length === 0 && (
        <p className="rounded-lg border border-amber-500/35 bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-400">
          One-line rationale required for {rationalesMissing.join(", ")} before this can go to the IC.
        </p>
      )}
      {proceedsPlanMissing && changes > 0 && (
        <p className="rounded-lg border border-[hsl(var(--down)/0.35)] bg-[hsl(var(--down)/0.1)] px-3 py-2 text-xs text-down">
          {buyActions.length
            ? "Confirm the proceeds destination before submitting."
            : "A SELL is present with no replacement BUY. Add or increase the asset the proceeds should fund."}
        </p>
      )}
      {impactQ.data?.totals && impactQ.data.totals.cashOk === false && changes > 0 && (
        <p className="rounded-lg border border-[hsl(var(--down)/0.35)] bg-[hsl(var(--down)/0.1)] px-3 py-2 text-xs text-down">
          Insufficient cash for one or more investors in this basket — trim something else or reduce the buy.
        </p>
      )}

      <div className="grid gap-5 lg:grid-cols-2">
        {/* working / current basket */}
        <GlassSection
          title="Current basket — click to trim / grow"
          dataSource="hybrid"
          db="retail"
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
                  <th className="px-3 py-2 text-right font-medium">Δ shares</th>
                  <th className="px-3 py-2 text-right font-medium">Price</th>
                  <th className="px-3 py-2 text-right font-medium">Weight</th>
                  <th className="px-3 py-2 font-medium">Action</th>
                  <th className="px-5 py-2 text-right font-medium">Edit</th>
                </tr>
              </thead>
              <tbody>
                {working.length === 0 && (
                  <tr>
                    <td colSpan={8} className="px-5 py-6 text-center text-caption">
                      {compQ.isLoading
                        ? "Loading current basket…"
                        : "No holdings for this strategy yet. Add stocks to build a proposal."}
                    </td>
                  </tr>
                )}
                {working.map((h) => {
                  const b = baseByKey.get(keyOf(h));
                  const delta = (b?.shares ?? 0) === 0 ? h.shares : h.shares - (b?.shares ?? 0);
                  const a = actionFor(h);
                  return (
                    <tr key={keyOf(h)} className="border-b border-[hsl(var(--glass-border))] last:border-0">
                      <td className="px-5 py-2 font-mono font-semibold text-foreground">{h.ticker}</td>
                      <td className="px-3 py-2 text-foreground/85">{h.name}</td>
                      <td className="px-3 py-2 text-right font-mono tabular-nums">{h.shares}</td>
                      <td
                        className={cn(
                          "px-3 py-2 text-right font-mono tabular-nums",
                          delta === 0
                            ? "text-muted-foreground"
                            : delta > 0
                              ? "text-up"
                              : "text-down",
                        )}
                      >
                        {delta > 0 ? `+${delta}` : delta}
                      </td>
                      <td className="px-3 py-2 text-right font-mono tabular-nums text-muted-foreground">
                        {moneyR(priceOf(h.ticker))}
                      </td>
                      <td className="px-3 py-2 text-right font-mono tabular-nums">{weightPct(weightOf(h))}</td>
                      <td className="px-3 py-2">
                        <ActionBadge action={a} />
                      </td>
                      <td className="px-5 py-2">
                        <div className="flex items-center justify-end gap-1">
                          <button
                            type="button"
                            onClick={() => setShares(keyOf(h), +1)}
                            className="rounded p-1 text-muted-foreground hover:text-up"
                            title="+1 share"
                          >
                            <ArrowUp className="h-3.5 w-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => setShares(keyOf(h), -1)}
                            className="rounded p-1 text-muted-foreground hover:text-down"
                            title="-1 share"
                          >
                            <ArrowDown className="h-3.5 w-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => removeHolding(keyOf(h))}
                            className="rounded p-1 text-muted-foreground hover:text-down"
                            title="Remove from basket"
                          >
                            <X className="h-3.5 w-3.5" />
                          </button>
                        </div>
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

        {/* proposed basket */}
        <GlassSection
          title="Proposed basket"
          dataSource="hybrid"
          subtitle={`${changes} change${changes === 1 ? "" : "s"} pending`}
          right={
            <button
              type="button"
              onClick={submitToIc}
              disabled={
                submitting ||
                changes === 0 ||
                missingResearch.length > 0 ||
                rationalesMissing.length > 0 ||
                proceedsPlanMissing ||
                impactQ.isFetching ||
                impactQ.data?.ok !== true ||
                (impactQ.data?.totals && impactQ.data.totals.cashOk === false) ||
                !perms.raiseRebalance
              }
              title={
                missingResearch.length > 0
                  ? "Research missing for one or more changes"
                  : rationalesMissing.length > 0
                    ? "Rationale required for one or more changes"
                    : proceedsPlanMissing
                      ? "Confirm the sale proceeds destination"
                      : impactQ.isFetching
                        ? "Calculating fee-adjusted investor impact"
                        : impactQ.data?.ok !== true
                          ? impactQ.data?.error ?? "Investor impact is unavailable"
                          : impactQ.data?.totals?.cashOk === false
                            ? "Insufficient cash for one or more investors"
                            : undefined
              }
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
                  <th className="px-3 py-2 font-medium">Action</th>
                  <th className="px-3 py-2 font-medium">Research</th>
                  <th className="px-5 py-2 font-medium">Rationale</th>
                </tr>
              </thead>
              <tbody>
                {working.map((h) => {
                  const b = baseByKey.get(keyOf(h));
                  const changed = !b || b.shares !== h.shares;
                  const a = actionFor(h);
                  const ref = researchRefFor(h.ticker);
                  return (
                    <tr
                      key={keyOf(h)}
                      className={cn(
                        "border-b border-[hsl(var(--glass-border))] last:border-0 align-top",
                        changed && "bg-primary/5",
                      )}
                    >
                      <td className="px-5 py-2 font-mono font-semibold text-foreground">{h.ticker}</td>
                      <td className="px-3 py-2 text-foreground/85">{h.name}</td>
                      <td className="px-3 py-2 text-right font-mono tabular-nums">{h.shares}</td>
                      <td className="px-3 py-2">
                        <ActionBadge action={a} />
                      </td>
                      <td className="px-3 py-2">
                        {ref ? (
                          <Link
                            href="/oems/research"
                            className="font-mono text-[11px] font-semibold text-primary hover:underline"
                            title="Open research note"
                          >
                            {ref}
                          </Link>
                        ) : (
                          <span className="text-caption">—</span>
                        )}
                      </td>
                      <td className="px-5 py-2">
                        {changed ? (
                          <input
                            value={rationaleBySymbol[h.ticker.toUpperCase()] ?? ""}
                            onChange={(e) => setRationale(h.ticker, e.target.value)}
                            placeholder={
                              a === "decrease" || a === "remove"
                                ? "What are the proceeds funding?"
                                : "Thesis / target / horizon…"
                            }
                            className="w-full min-w-[220px] rounded-md border border-[hsl(var(--glass-border))] bg-[hsl(var(--foreground)/0.03)] px-2 py-1 text-xs outline-none focus:border-primary/50"
                          />
                        ) : (
                          <span className="text-caption">—</span>
                        )}
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

      {sellActions.length > 0 && (
        <ProceedsDestinationPanel
          buySymbols={destinationSymbols}
          destination={proceedsDestination}
          expectedDestination={proposedDestination}
          onDestination={setProceedsDestination}
          netProceedsCents={impactQ.data?.totals?.netProceedsCents}
          loading={impactQ.isFetching}
        />
      )}

      <InvestorImpactPanel
        enabled={!!strategyId && changes > 0}
        loading={impactQ.isFetching}
        data={impactQ.data}
      />

      <ProposalsList pushingId={pushingId} setPushingId={setPushingId} canPush={perms.pushRebalance} />
    </ResearchLabCanvas>
  );
}

/** Cents (int) → "R1,234.00". */
function centsToR(c: number | null | undefined): string {
  return moneyR((Number(c) || 0) / 100);
}

function ProceedsDestinationPanel({
  buySymbols,
  destination,
  expectedDestination,
  onDestination,
  netProceedsCents,
  loading,
}: {
  buySymbols: string[];
  destination: string;
  expectedDestination: string;
  onDestination: (value: string) => void;
  netProceedsCents?: number;
  loading: boolean;
}) {
  const destinationLabel =
    buySymbols.length === 1
      ? `Buy ${buySymbols[0]}`
      : `Split across proposed buys · ${buySymbols.join(", ")}`;
  return (
    <GlassSection
      title="Sale proceeds plan"
      subtitle="Confirm where the fee-adjusted proceeds will be reinvested"
      dataSource="live"
      db="retail"
    >
      <div className="grid gap-3 md:grid-cols-[1fr_220px] md:items-end">
        <label className="space-y-1.5 text-xs font-medium">
          What should the sale proceeds buy?
          <select
            value={destination}
            disabled={!expectedDestination}
            onChange={(event) => onDestination(event.target.value)}
            className="block h-10 w-full rounded-lg border border-[hsl(var(--glass-border))] bg-[hsl(var(--foreground)/0.03)] px-3 text-sm outline-none focus:border-primary/50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <option value="">
              {expectedDestination ? "Select proceeds destination…" : "Add or increase a replacement asset first"}
            </option>
            {expectedDestination ? <option value={expectedDestination}>{destinationLabel}</option> : null}
          </select>
          <span className="block text-[10px] font-normal text-muted-foreground">
            The destination is saved with the IC proposal and must match the proposed BUY legs.
          </span>
        </label>
        <div className="rounded-xl border border-[hsl(var(--glass-border))] bg-[hsl(var(--foreground)/0.025)] p-3">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Estimated net proceeds</div>
          <div className="mt-1 font-mono text-lg font-semibold tabular-nums text-up">
            {loading ? "Calculating…" : netProceedsCents == null ? "—" : centsToR(netProceedsCents)}
          </div>
          <div className="mt-1 text-[10px] text-muted-foreground">After estimated sell brokerage and custody</div>
        </div>
      </div>
    </GlassSection>
  );
}

function ProceedsBreakdownDialog({ data }: { data: ImpactResponse }) {
  const totals = data.totals;
  if (!totals) return null;
  const feeRate = Number(data.feeConfig?.brokerageRate ?? 0) * 100;
  const rows = [
    ["Gross sale proceeds", totals.sellCents],
    ["Estimated sell fees", -totals.sellFeesCents],
    ["Net sale proceeds", totals.netProceedsCents],
    ["Replacement purchases", -totals.buyCents],
    ["Estimated buy fees", -totals.buyFeesCents],
    ["Execution reserve used", totals.reserveUsedCents],
    ["Fees not covered by reserve", -totals.feeShortfallCents],
    ["Cash after proposed sequence", totals.walletAfterCents],
  ] as const;
  return (
    <Dialog>
      <DialogTrigger asChild>
        <button
          type="button"
          aria-label="Show sale proceeds calculation"
          className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-[hsl(var(--glass-border))] text-muted-foreground transition-colors hover:border-primary/40 hover:text-primary"
        >
          <Info className="h-3 w-3" />
        </button>
      </DialogTrigger>
      <DialogContent className="glass-panel max-h-[88vh] max-w-3xl overflow-y-auto border-[hsl(var(--glass-border))]">
        <DialogHeader>
          <DialogTitle>Estimated proceeds and fee bridge</DialogTitle>
          <DialogDescription>
            Preview only. Actual settlement uses broker fills and charges configured in App Settings.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 md:grid-cols-2">
          <div className="rounded-xl border border-[hsl(var(--glass-border))] p-4">
            <div className="space-y-2 text-xs">
              {rows.map(([label, cents]) => (
                <div key={label} className="flex items-center justify-between gap-4">
                  <span className="text-muted-foreground">{label}</span>
                  <span className={cn("font-mono tabular-nums", cents < 0 && "text-down")}>
                    {cents < 0 ? "−" : ""}{centsToR(Math.abs(cents))}
                  </span>
                </div>
              ))}
            </div>
            <div className="mt-4 border-t border-[hsl(var(--glass-border))] pt-3 text-[10px] text-muted-foreground">
              Brokerage {feeRate.toFixed(3)}% · custody {centsToR(data.feeConfig?.custodyFeeCents)} per
              traded asset per affected investor · source {data.feeConfig?.source ?? "unavailable"}
            </div>
          </div>
          <div className="overflow-hidden rounded-xl border border-[hsl(var(--glass-border))]">
            <div className="border-b border-[hsl(var(--glass-border))] px-3 py-2 text-xs font-semibold">
              Per-investor effect
            </div>
            <div className="max-h-72 overflow-y-auto">
              {data.investors?.map((investor) => (
                <div key={investor.user_id} className="border-b border-[hsl(var(--glass-border))] p-3 last:border-0">
                  <div className="flex items-center justify-between gap-3 text-xs font-medium">
                    <span>{investor.name}</span>
                    <span className={cn("font-mono", investor.shortfall ? "text-down" : "text-up")}>
                      {centsToR(investor.cashAfterCents)} after
                    </span>
                  </div>
                  <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-[10px] text-muted-foreground">
                    <span>Gross sell {centsToR(investor.grossSellCents)}</span>
                    <span>Net proceeds {centsToR(investor.netProceedsCents)}</span>
                    <span>Total fees {centsToR(investor.totalFeesCents)}</span>
                    <span>Reserve used {centsToR(investor.reserveUsedCents)}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
        <p className="text-[10px] leading-4 text-muted-foreground">
          Standard net proceeds are gross sale proceeds less estimated sell fees. The sequence cash result also
          includes replacement-buy costs and fees. Execution reserve is applied to fees first; only an uncovered
          fee shortfall reduces the cash available for the replacement purchase.
        </p>
      </DialogContent>
    </Dialog>
  );
}

function InvestorImpactPanel({
  enabled,
  loading,
  data,
}: {
  enabled: boolean;
  loading: boolean;
  data: ImpactResponse | undefined;
}) {
  const investors = data?.investors ?? [];
  const totals = data?.totals ?? null;
  const cashOk = totals?.cashOk ?? true;

  return (
    <GlassSection
      title="Affected investors — cash & shares"
      dataSource="hybrid"
      db="retail"
      subtitle="Read-only impact of this rebalance"
      right={
        <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase text-amber-600 dark:text-amber-400">
          <FlaskConical className="h-3 w-3" /> Test clients only
        </span>
      }
      noPadding
    >
      {!enabled ? (
        <p className="px-5 py-4 text-caption">Make a change to model the impact on investors.</p>
      ) : data?.ok === false ? (
        <p className="border-l-2 border-down px-5 py-4 text-xs text-down">
          {data.error ?? "The fee-adjusted impact preview could not be calculated."}
        </p>
      ) : loading && investors.length === 0 ? (
        <p className="px-5 py-4 text-caption">Modelling impact…</p>
      ) : investors.length === 0 ? (
        <p className="px-5 py-4 text-caption">
          {data?.notice ?? "No test-client holdings match this strategy yet."}
        </p>
      ) : (
        <>
          <div
            className={cn(
              "flex flex-wrap items-center justify-between gap-3 border-b px-5 py-3 text-xs",
              cashOk
                ? "border-[hsl(var(--glass-border))]"
                : "border-[hsl(var(--down)/0.4)] bg-[hsl(var(--down)/0.06)]",
            )}
          >
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
              <span className="text-muted-foreground">
                {totals?.investorCount ?? investors.length} investor
                {(totals?.investorCount ?? investors.length) === 1 ? "" : "s"}
              </span>
              <span>
                Buys <span className="font-mono font-semibold text-down">{centsToR(totals?.buyCents)}</span>
              </span>
              <span>
                Sells <span className="font-mono font-semibold text-up">{centsToR(totals?.sellCents)}</span>
              </span>
              <span className="inline-flex items-center gap-1">
                Net proceeds{" "}
                <span className="font-mono font-semibold text-up">{centsToR(totals?.netProceedsCents)}</span>
                {data ? <ProceedsBreakdownDialog data={data} /> : null}
              </span>
              <span className="text-muted-foreground">
                Combined wallets <span className="font-mono">{centsToR(totals?.walletCents)}</span>
              </span>
            </div>
            <span
              className={cn(
                "rounded-full px-2 py-0.5 text-[11px] font-semibold",
                cashOk ? "bg-[hsl(var(--up)/0.15)] text-up" : "bg-[hsl(var(--down)/0.15)] text-down",
              )}
            >
              {cashOk ? "Cash available" : "Insufficient cash"}
            </span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[hsl(var(--glass-border))] text-left text-[10px] uppercase tracking-wide text-muted-foreground">
                  <th className="px-5 py-2 font-medium">Investor</th>
                  <th className="px-3 py-2 text-right font-medium">Basket</th>
                  <th className="px-3 py-2 text-right font-medium">To buy</th>
                  <th className="px-3 py-2 text-right font-medium">To sell</th>
                  <th className="px-3 py-2 text-right font-medium">Net proceeds</th>
                  <th className="px-3 py-2 text-right font-medium">Wallet</th>
                  <th className="px-5 py-2 text-right font-medium">Wallet after</th>
                </tr>
              </thead>
              <tbody>
                {investors.map((inv) => (
                  <React.Fragment key={inv.user_id}>
                    <tr className="border-b border-[hsl(var(--glass-border))]">
                      <td className="px-5 py-2 font-medium">{inv.name}</td>
                      <td className="px-3 py-2 text-right font-mono tabular-nums text-muted-foreground">
                        {centsToR(inv.basketCents)}
                      </td>
                      <td className="px-3 py-2 text-right font-mono tabular-nums text-down">
                        {inv.buyCents ? centsToR(inv.buyCents) : "—"}
                      </td>
                      <td className="px-3 py-2 text-right font-mono tabular-nums text-up">
                        {inv.sellCents ? centsToR(inv.sellCents) : "—"}
                      </td>
                      <td className="px-3 py-2 text-right font-mono tabular-nums text-up">
                        {inv.netProceedsCents ? centsToR(inv.netProceedsCents) : "—"}
                      </td>
                      <td className="px-3 py-2 text-right font-mono tabular-nums text-muted-foreground">
                        {centsToR(inv.walletCents)}
                      </td>
                      <td
                        className={cn(
                          "px-5 py-2 text-right font-mono tabular-nums font-semibold",
                          inv.shortfall ? "text-down" : "text-foreground",
                        )}
                      >
                        {centsToR(inv.walletAfterCents)}
                      </td>
                    </tr>
                    {inv.lines.length > 0 && (
                      <tr className="border-b border-[hsl(var(--glass-border))]">
                        <td colSpan={7} className="px-5 pb-2 pt-0">
                          <div className="flex flex-wrap gap-1.5">
                            {inv.lines.map((ln) => (
                              <span
                                key={ln.symbol}
                                className={cn(
                                  "rounded border px-1.5 py-0.5 font-mono text-[10px]",
                                  ln.side === "buy"
                                    ? "border-[hsl(var(--down)/0.3)] text-down"
                                    : "border-[hsl(var(--up)/0.3)] text-up",
                                )}
                              >
                                {ln.side === "buy" ? "BUY" : "SELL"} {Math.abs(ln.deltaQty)} {ln.symbol}
                              </span>
                            ))}
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </GlassSection>
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
    <GlassSection title="Proposals — at IC or executed" endpoint="GET /api/rebalance/requests" dataSource="supabase" db="institutional">
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
