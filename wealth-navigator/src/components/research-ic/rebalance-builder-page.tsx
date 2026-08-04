"use client";

/**
 * Rebalance Builder — build a proposal instrument-by-instrument. Left: the
 * working basket (trim / grow / drop, live prices → live weights). Right: the
 * resulting proposed basket + changes pending. Submit to IC writes a
 * rebalance_request_c (status=pending); the IC gate promotes it to ic_approved,
 * after which "Send to Order Book" pushes it into oems_order_audit.
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Info, Plus, Rocket, Send, X } from "lucide-react";
import Link from "next/link";
import * as React from "react";

import { GlassSection, ResearchLabCanvas } from "@/components/oems/primitives/glass";
import { cn } from "@/lib/cn";
import type { CompAction, ProposedHolding, RebalanceRequest, ResearchPerms } from "./types";
import { moneyR, rebalanceCodeMap, useQuotes, weightPct, ActionBadge } from "./ui";

type Holding = { ticker: string; name: string; shares: number };
type StrategyOpt = { id: string; name: string; investorEnvironment: "LIVE" | "UAT" };

type ImpactLine = {
  symbol: string;
  action: string;
  lots: number | null;
  currentQty: number;
  targetQty: number;
  deltaQty: number;
  side: "buy" | "sell" | "none";
  priceCents: number;
  valueCents: number;
  currentPnlCents: number;
};
type ImpactInvestor = {
  user_id: string;
  name: string;
  account?: string;
  basketCents: number;
  buyCents: number;
  sellCents: number;
  netCashCents: number;
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
  residualCents: number;
  strategyCashAfterCents: number;
  cashAfterCents: number;
  lines: ImpactLine[];
};
type ImpactTotals = {
  investorCount: number;
  buyCents: number;
  sellCents: number;
  netProceedsCents: number;
  sellFeesCents: number;
  buyFeesCents: number;
  totalFeesCents: number;
  reserveCents: number;
  reserveUsedCents: number;
  feeShortfallCents: number;
  residualCents: number;
  strategyCashAfterCents: number;
  cashAfterCents: number;
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
  proceedsMode?: "reinvest" | "liquidate" | null;
};

function keyOf(h: Holding) {
  return h.ticker.toUpperCase();
}

/** "MTN.JO" / " mtn " -> "MTN" (matches the bare-symbol convention `working` uses). */
function bare(sym: string): string {
  return String(sym ?? "")
    .trim()
    .toUpperCase()
    .replace(/\.(JO|JSE)$/i, "");
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
  const strategiesQ = useQuery<{
    strategies?: Array<{ id: string; name: string; investorEnvironment?: "LIVE" | "UAT" }>;
  }>({
    queryKey: ["ric-strategies"],
    queryFn: async () => (await fetch("/api/strategies", { cache: "no-store" })).json(),
  });
  const strategies: StrategyOpt[] = (strategiesQ.data?.strategies ?? []).map((s) => ({
    id: s.id,
    name: s.name,
    investorEnvironment: s.investorEnvironment === "UAT" ? "UAT" : "LIVE",
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
  const isTestStrategy =
    strategies.find((strategy) => strategy.id === strategyId)?.investorEnvironment === "UAT";

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
  const setRationale = (sym: string, v: string) =>
    setRationaleBySymbol((prev) => ({ ...prev, [sym.toUpperCase()]: v }));
  const [submitting, setSubmitting] = React.useState(false);
  const [pushingId, setPushingId] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  // Embedded two-stage trade sequence: "compose" is the editable basket (as
  // today); "execute" swaps that out for the CRM-style Sell/Buy execution
  // panel (instrument dropdown + inline fee bridge). Submit to IC only ever
  // fires from the final Commit button inside "execute".
  const [stage, setStage] = React.useState<"compose" | "execute">("compose");
  const [dropdownBuySymbol, setDropdownBuySymbol] = React.useState<string>("");
  // Explicit Liquidate-vs-Reinvest choice, made on the execute step — mirrors
  // CRM's Sell modal offering both "Confirm & Proceed to Buy" and "Liquidate
  // to Cash" as buttons rather than inferring it from the basket editor.
  // null until the admin picks one on the execute step.
  const [sequenceMode, setSequenceMode] = React.useState<"liquidate" | "reinvest" | null>(null);

  // Reset rationale when the basket switches strategies so old text doesn't
  // leak across strategies.
  React.useEffect(() => {
    setRationaleBySymbol({});
  }, [strategyId]);

  React.useEffect(() => {
    setWorking(baseline.map((h) => ({ ...h })));
    setAddOpen(false);
    setStage("compose");
    setDropdownBuySymbol("");
    setSequenceMode(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [strategyId, compQ.data]);

  // Buy-instrument universe for the trade-sequence dropdown (mirrors CRM's
  // rebLoadBuySecurities). Read-only; reuses the existing equities board.
  const equitiesQ = useQuery<{ securities?: Array<{ symbol: string; name: string | null; last_price: number | null; is_active: boolean | null }> }>({
    queryKey: ["ric-buy-universe"],
    queryFn: async () => (await fetch("/api/equities", { cache: "no-store" })).json(),
  });
  const buyUniverse = (equitiesQ.data?.securities ?? [])
    .filter((s) => s.is_active !== false)
    .map((s) => ({
      symbol: bare(s.symbol),
      name: s.name || bare(s.symbol),
      priceCents: Number(s.last_price) || 0,
    }))
    .filter((s, i, arr) => arr.findIndex((x) => x.symbol === s.symbol) === i)
    .sort((a, b) => a.symbol.localeCompare(b.symbol));

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
  const setAbsoluteShares = (t: string, value: number) =>
    setWorking((prev) => prev.map((h) => (keyOf(h) === t ? { ...h, shares: Math.max(0, Math.floor(value)) } : h)));
  const removeHolding = (t: string) => setWorking((prev) => prev.filter((h) => keyOf(h) !== t));
  // Trade-sequence dropdown: picking an instrument sets/replaces the single
  // reinvest destination, auto-sized from net sale proceeds (CRM's
  // "max-affordable" default) — the admin can still fine-tune via the shares
  // input next to the dropdown.
  const chooseBuyInstrument = (symbol: string, name: string, priceCents: number) => {
    const netProceeds = impactQ.data?.totals?.netProceedsCents ?? 0;
    const affordable = priceCents > 0 ? Math.max(0, Math.floor(netProceeds / priceCents)) : 0;
    setWorking((prev) => {
      const withoutOldPick = dropdownBuySymbol ? prev.filter((h) => keyOf(h) !== dropdownBuySymbol) : prev;
      const already = withoutOldPick.find((h) => keyOf(h) === symbol);
      if (already) {
        return withoutOldPick.map((h) => (keyOf(h) === symbol ? { ...h, shares: affordable } : h));
      }
      return [...withoutOldPick, { ticker: symbol, name, shares: affordable }];
    });
    setDropdownBuySymbol(symbol);
  };
  // "Liquidate to Cash" choice on the execute step: drop whatever buy leg the
  // dropdown had staged, so the impact call goes out sell-only.
  const clearBuyInstrument = () => {
    if (dropdownBuySymbol) removeHolding(dropdownBuySymbol);
    setDropdownBuySymbol("");
  };
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
  // The trade shape determines the proceeds path automatically. A sell-only
  // change liquidates into strategy CA; sells paired with replacement buys are
  // reinvested. Increases use only existing strategy CA and execution reserve.
  const inferredProceedsMode: "reinvest" | "liquidate" | null =
    sellActions.length > 0 ? (buyActions.length > 0 ? "reinvest" : "liquidate") : null;
  // Once the admin has explicitly picked a direction on the execute step,
  // that choice wins; before that (still composing), fall back to what the
  // basket editor implies.
  const effectiveProceedsMode = sequenceMode ?? inferredProceedsMode;
  const inferredProceedsDestination = effectiveProceedsMode === "reinvest" ? proposedDestination : "";

  // Client impact is read-only and re-modelled immediately whenever proposed
  // shares change. The server derives LIVE versus UAT owner scope from the
  // persisted strategy, never from a browser-provided environment flag.
  const impactSig = JSON.stringify([
    effectiveProceedsMode,
    ...proposedComposition.map((p) => [p.ticker, p.action, p.shares]),
  ]);
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
          proceeds_mode: effectiveProceedsMode,
          current: baseline,
          proposed: proposedComposition,
        }),
      });
      return (await res.json().catch(() => ({ ok: false }))) as ImpactResponse;
    },
  });

  async function submitToIc() {
    setError(null);
    // Gates — short-circuit before opening the network tab.
    if (!isTestStrategy && missingResearch.length) {
      setError(
        `Research required before submitting: ${missingResearch.join(", ")}. Add a note in the Research Library.`,
      );
      return;
    }
    if (!isTestStrategy && rationalesMissing.length) {
      setError(
        `One-line rationale required for: ${rationalesMissing.join(", ")}. Tell the IC why.`,
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
            proceeds_mode: effectiveProceedsMode,
            proceeds_destination: inferredProceedsDestination,
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
      // Proposal raised — return the page to a clean slate instead of leaving
      // the just-committed edits on screen.
      setWorking(baseline.map((h) => ({ ...h })));
      setRationaleBySymbol({});
      setDropdownBuySymbol("");
      setSequenceMode(null);
      setStage("compose");
    } finally {
      setSubmitting(false);
    }
  }

  const commitDisabled =
    submitting ||
    changes === 0 ||
    (!isTestStrategy && missingResearch.length > 0) ||
    (!isTestStrategy && rationalesMissing.length > 0) ||
    impactQ.isFetching ||
    impactQ.data?.ok !== true ||
    impactQ.data?.totals?.cashOk === false ||
    !perms.raiseRebalance;
  const commitTitle =
    !isTestStrategy && missingResearch.length > 0
      ? "Research missing for one or more changes"
      : !isTestStrategy && rationalesMissing.length > 0
        ? "Rationale required for one or more changes"
        : impactQ.isFetching
            ? "Calculating fee-adjusted client impact"
            : impactQ.data?.ok !== true
              ? impactQ.data?.error ?? "Client impact is unavailable"
              : impactQ.data?.totals?.cashOk === false
                ? "Insufficient cash for one or more clients"
                : "Create the controlled trade-sequence proposal for IC review";

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

      {isTestStrategy && (
        <p className="rounded-lg border border-amber-500/35 bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-400">
          UAT test strategy · research-note and rationale gates are disabled. Cash, fee and proceeds checks remain
          active.
        </p>
      )}

      {!isTestStrategy && missingResearch.length > 0 && changes > 0 && (
        <p className="rounded-lg border border-amber-500/35 bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-400">
          Research required for {missingResearch.join(", ")} before this can go to the IC.{" "}
          <Link href="/oems/research" className="underline">
            Write a note
          </Link>
          .
        </p>
      )}
      {!isTestStrategy && rationalesMissing.length > 0 && changes > 0 && missingResearch.length === 0 && (
        <p className="rounded-lg border border-amber-500/35 bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-400">
          One-line rationale required for {rationalesMissing.join(", ")} before this can go to the IC.
        </p>
      )}
      {impactQ.data?.totals && impactQ.data.totals.cashOk === false && changes > 0 && (
        <p className="rounded-lg border border-[hsl(var(--down)/0.35)] bg-[hsl(var(--down)/0.1)] px-3 py-2 text-xs text-down">
          Insufficient cash for one or more investors in this basket — trim something else or reduce the buy.
        </p>
      )}

      {stage === "compose" && (
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
            <span className="rounded-full border border-primary/25 bg-primary/10 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide text-primary">
              Review client impact
            </span>
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
      )}

      <TradeSequencePanel
        mode={stage}
        enabled={!!strategyId && changes > 0}
        loading={impactQ.isFetching}
        data={impactQ.data}
        strategyName={strategyName}
        sellSymbols={sellActions.map((action) => action.ticker.toUpperCase())}
        submitting={submitting}
        commitDisabled={commitDisabled}
        commitTitle={commitTitle}
        onProceed={() => {
          if (commitDisabled) return;
          setSequenceMode(inferredProceedsMode);
          setStage("execute");
        }}
        onCommit={submitToIc}
        onBack={() => {
          setSequenceMode(null);
          setStage("compose");
        }}
        proceedsMode={effectiveProceedsMode}
        buySymbols={destinationSymbols}
        buyUniverse={buyUniverse}
        buyUniverseLoading={equitiesQ.isLoading}
        dropdownBuySymbol={dropdownBuySymbol}
        onSelectBuyInstrument={chooseBuyInstrument}
        onSharesOverride={(value) => dropdownBuySymbol && setAbsoluteShares(dropdownBuySymbol, value)}
        onChooseLiquidate={() => {
          clearBuyInstrument();
          setSequenceMode("liquidate");
        }}
        onChooseReinvest={() => setSequenceMode("reinvest")}
      />

      <ProposalsList pushingId={pushingId} setPushingId={setPushingId} canPush={perms.pushRebalance} />
    </ResearchLabCanvas>
  );
}

/** Cents (int) → "R1,234.00". */
function centsToR(c: number | null | undefined): string {
  return moneyR((Number(c) || 0) / 100);
}

/**
 * Always-visible fee/proceeds bridge — embedded, not a click-to-open dialog,
 * so it's guaranteed to show whenever there's a valid impact preview (this
 * replaces the old Info-icon Dialog that only rendered three conditions deep
 * and was easy to never see).
 */
function FeeProceedsBreakdown({ data }: { data: ImpactResponse }) {
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
    ["Existing strategy cash", totals.residualCents],
    ["Strategy cash after sequence", totals.strategyCashAfterCents],
  ] as const;
  return (
    <div className="border-b border-[hsl(var(--glass-border))] bg-[hsl(var(--foreground)/0.015)] px-5 py-4">
      <div className="mb-3 flex items-center gap-1.5 text-xs font-semibold">
        <Info className="h-3.5 w-3.5 text-primary" /> Estimated proceeds and fee bridge
      </div>
      <div className="grid gap-2 sm:grid-cols-2 md:grid-cols-3">
        {rows.map(([label, cents]) => (
          <div key={label} className="flex items-center justify-between gap-4 text-xs">
            <span className="text-muted-foreground">{label}</span>
            <span className={cn("font-mono tabular-nums", cents < 0 && "text-down")}>
              {cents < 0 ? "−" : ""}{centsToR(Math.abs(cents))}
            </span>
          </div>
        ))}
      </div>
      <div className="mt-3 border-t border-[hsl(var(--glass-border))] pt-2.5 text-[10px] text-muted-foreground">
        Brokerage {feeRate.toFixed(3)}% · custody {centsToR(data.feeConfig?.custodyFeeCents)} per traded
        asset per affected investor · source {data.feeConfig?.source ?? "unavailable"} · preview only,
        actual settlement uses broker fills and App Settings charges.
      </div>
      {data.investors?.length ? (
        <div className="mt-3 overflow-hidden rounded-xl border border-[hsl(var(--glass-border))]">
          <div className="border-b border-[hsl(var(--glass-border))] bg-[hsl(var(--foreground)/0.02)] px-3 py-2 text-xs font-semibold">
            Per-investor effect
          </div>
          <div className="max-h-56 overflow-y-auto">
            {data.investors.map((investor) => (
              <div key={investor.user_id} className="border-b border-[hsl(var(--glass-border))] p-3 last:border-0">
                <div className="flex items-center justify-between gap-3 text-xs font-medium">
                  <span>{investor.name}</span>
                  <span className={cn("font-mono", investor.shortfall ? "text-down" : "text-up")}>
                    {centsToR(investor.cashAfterCents)} cash after
                  </span>
                </div>
                <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-[10px] text-muted-foreground sm:grid-cols-3">
                  <span>Gross sell {centsToR(investor.grossSellCents)}</span>
                  <span>Net proceeds {centsToR(investor.netProceedsCents)}</span>
                  <span>Total fees {centsToR(investor.totalFeesCents)}</span>
                  <span>Reserve used {centsToR(investor.reserveUsedCents)}</span>
                  <span>Strategy CA after {centsToR(investor.strategyCashAfterCents)}</span>
                  <span>Reserve remaining {centsToR(investor.reserveAfterCents)}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function TradeSequencePanel({
  mode,
  enabled,
  loading,
  data,
  strategyName,
  sellSymbols,
  submitting,
  commitDisabled,
  commitTitle,
  onProceed,
  onCommit,
  onBack,
  proceedsMode,
  buySymbols,
  buyUniverse,
  buyUniverseLoading,
  dropdownBuySymbol,
  onSelectBuyInstrument,
  onSharesOverride,
  onChooseLiquidate,
  onChooseReinvest,
}: {
  mode: "compose" | "execute";
  enabled: boolean;
  loading: boolean;
  data: ImpactResponse | undefined;
  strategyName: string;
  sellSymbols: string[];
  submitting: boolean;
  commitDisabled: boolean;
  commitTitle: string;
  onProceed: () => void;
  onCommit: () => void;
  onBack: () => void;
  proceedsMode: "reinvest" | "liquidate" | null;
  buySymbols: string[];
  buyUniverse: Array<{ symbol: string; name: string; priceCents: number }>;
  buyUniverseLoading: boolean;
  dropdownBuySymbol: string;
  onSelectBuyInstrument: (symbol: string, name: string, priceCents: number) => void;
  onSharesOverride: (value: number) => void;
  onChooseLiquidate: () => void;
  onChooseReinvest: () => void;
}) {
  const investors = data?.investors ?? [];
  const totals = data?.totals ?? null;
  const cashOk = totals?.cashOk ?? true;
  const [residualView, setResidualView] = React.useState(false);
  const scopeLabel =
    data?.scope === "live" ? "LIVE clients" : data?.scope === "uat" ? "UAT clients" : "Scope unavailable";
  const impactLabel = sellSymbols.length ? sellSymbols.join(" + ") : strategyName;
  const selectedInstrument = buyUniverse.find((u) => u.symbol === dropdownBuySymbol) ?? null;
  const isExecute = mode === "execute";

  return (
    <GlassSection
      title={isExecute ? "Trade sequence execution" : "Client impact preview"}
      dataSource="hybrid"
      db="retail"
      subtitle={
        isExecute
          ? `${impactLabel} · ${totals?.investorCount ?? investors.length} client${(totals?.investorCount ?? investors.length) === 1 ? "" : "s"} · review the sequence before committing`
          : `${impactLabel} · ${totals?.investorCount ?? investors.length} client${(totals?.investorCount ?? investors.length) === 1 ? "" : "s"} · review projected holdings before commitment`
      }
      right={
        <div className="flex items-center gap-3">
          {!isExecute ? (
            <label className="inline-flex cursor-pointer items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              Show residual view
              <input
                type="checkbox"
                checked={residualView}
                onChange={(event) => setResidualView(event.target.checked)}
                className="h-4 w-4 rounded border-[hsl(var(--glass-border))] accent-primary"
              />
            </label>
          ) : (
            <button
              type="button"
              onClick={onBack}
              className="rounded-md border border-[hsl(var(--glass-border))] px-2.5 py-1 text-[11px] font-medium hover:bg-[hsl(var(--foreground)/0.05)]"
            >
              Back to editing
            </button>
          )}
        </div>
      }
      noPadding
    >
      {isExecute && enabled ? (
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[hsl(var(--glass-border))] bg-primary/[0.035] px-5 py-3">
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-wide text-primary">
              {proceedsMode === "liquidate" ? "Liquidate to Cash" : proceedsMode === "reinvest" ? "Reinvest / Buy" : "Increase"}
            </div>
            <div className="mt-0.5 text-xs font-medium">
              {proceedsMode === "liquidate"
                ? "Sell-only · net proceeds settle into this strategy’s CA"
                : proceedsMode === "reinvest"
                  ? `Sell + buy · proceeds fund ${buySymbols.join(", ")}`
                  : "Increase · funding is checked against strategy CA and reserve"}
            </div>
          </div>
          <div className="text-right">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
              Strategy CA after
            </div>
            <div className="mt-0.5 font-mono text-sm font-semibold tabular-nums text-up">
              {loading
                ? "Calculating…"
                : centsToR(
                    proceedsMode === "liquidate" ? totals?.strategyCashAfterCents : totals?.cashAfterCents,
                  )}
            </div>
          </div>
        </div>
      ) : null}
      {/* Explicit Liquidate-vs-Reinvest choice — mirrors CRM's Sell modal,
          which always offers both "Confirm & Proceed to Buy" and "Liquidate
          to Cash (skip buy)" as buttons rather than inferring the direction. */}
      {isExecute && enabled && sellSymbols.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2 border-b border-[hsl(var(--glass-border))] px-5 py-3">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Sale proceeds:
          </span>
          <button
            type="button"
            onClick={onChooseReinvest}
            className={cn(
              "rounded-full border px-3 py-1 text-[11px] font-semibold transition",
              proceedsMode === "reinvest"
                ? "border-primary/50 bg-primary/15 text-primary"
                : "border-[hsl(var(--glass-border))] text-muted-foreground hover:bg-[hsl(var(--foreground)/0.05)]",
            )}
          >
            Reinvest · buy replacement
          </button>
          <button
            type="button"
            onClick={onChooseLiquidate}
            className={cn(
              "rounded-full border px-3 py-1 text-[11px] font-semibold transition",
              proceedsMode === "liquidate"
                ? "border-primary/50 bg-primary/15 text-primary"
                : "border-[hsl(var(--glass-border))] text-muted-foreground hover:bg-[hsl(var(--foreground)/0.05)]",
            )}
          >
            Liquidate to Cash
          </button>
        </div>
      ) : null}
      {isExecute && enabled && proceedsMode === "reinvest" ? (
        <div className="flex flex-wrap items-center gap-3 border-b border-[hsl(var(--glass-border))] px-5 py-3">
          <label className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Instrument to buy
          </label>
          <select
            value={dropdownBuySymbol}
            onChange={(e) => {
              const meta = buyUniverse.find((u) => u.symbol === e.target.value);
              if (meta) onSelectBuyInstrument(meta.symbol, meta.name, meta.priceCents);
            }}
            className="min-w-[260px] rounded-lg border border-[hsl(var(--glass-border))] bg-[hsl(var(--foreground)/0.03)] px-3 py-1.5 text-xs outline-none focus:border-primary/50"
          >
            <option value="">
              {buyUniverseLoading
                ? "Loading instruments…"
                : `Select instrument (${buyUniverse.length} available)…`}
            </option>
            {buyUniverse.map((u) => (
              <option key={u.symbol} value={u.symbol}>
                {u.symbol} · {u.name}
                {u.priceCents > 0 ? ` · ${centsToR(u.priceCents)}` : " · N/A"}
              </option>
            ))}
          </select>
          {selectedInstrument ? (
            <span className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
              Shares
              <input
                type="number"
                min={0}
                step={1}
                defaultValue={undefined}
                onChange={(e) => onSharesOverride(Number(e.target.value) || 0)}
                placeholder="auto"
                className="w-20 rounded-md border border-[hsl(var(--glass-border))] bg-[hsl(var(--foreground)/0.03)] px-2 py-1 text-xs outline-none"
              />
            </span>
          ) : null}
        </div>
      ) : null}
      {isExecute && data ? <FeeProceedsBreakdown data={data} /> : null}
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
              </span>
              <span className="text-muted-foreground">
                CA <span className="font-mono">{centsToR(totals?.residualCents)}</span>
              </span>
              <span className="text-muted-foreground">
                Reserve <span className="font-mono">{centsToR(totals?.reserveCents)}</span>
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span className="rounded-full border border-[hsl(var(--glass-border))] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                {scopeLabel}
              </span>
              <span
                className={cn(
                  "rounded-full px-2 py-0.5 text-[11px] font-semibold",
                  cashOk ? "bg-[hsl(var(--up)/0.15)] text-up" : "bg-[hsl(var(--down)/0.15)] text-down",
                )}
              >
                {cashOk ? "Cash available" : "Insufficient cash"}
              </span>
            </div>
          </div>
          {!isExecute && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[hsl(var(--glass-border))] text-left text-[10px] uppercase tracking-wide text-muted-foreground">
                  <th className="px-5 py-2 font-medium">Client</th>
                  {residualView ? (
                    <>
                      <th className="px-3 py-2 text-right font-medium">Basket</th>
                      <th className="px-3 py-2 text-right font-medium">CA before</th>
                      <th className="px-3 py-2 text-right font-medium">Reserve before</th>
                      <th className="px-3 py-2 text-right font-medium">Strategy CA after</th>
                      <th className="px-5 py-2 text-right font-medium">Reserve after</th>
                    </>
                  ) : (
                    <>
                      <th className="px-3 py-2 text-right font-medium">Lots</th>
                      <th className="px-3 py-2 text-right font-medium">Current</th>
                      <th className="px-3 py-2 text-right font-medium">New</th>
                      <th className="px-3 py-2 text-right font-medium">Δ</th>
                      <th className="px-5 py-2 text-right font-medium">P/L</th>
                    </>
                  )}
                </tr>
              </thead>
              <tbody>
                {investors.map((inv) => (
                  <React.Fragment key={inv.user_id}>
                    <tr
                      className={cn(
                        "border-b border-[hsl(var(--glass-border))] transition-colors",
                        inv.shortfall
                          ? "bg-[hsl(var(--down)/0.07)]"
                          : "bg-amber-500/[0.035] hover:bg-amber-500/[0.065]",
                      )}
                    >
                      <td className="px-5 py-3">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="font-medium">{inv.name}</span>
                          {!residualView && inv.lines.map((line) => (
                            <span
                              key={line.symbol}
                              className={cn(
                                "rounded-md border px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide",
                                line.side === "buy"
                                  ? "border-[hsl(var(--down)/0.3)] bg-[hsl(var(--down)/0.08)] text-down"
                                  : line.side === "sell"
                                    ? "border-[hsl(var(--up)/0.3)] bg-[hsl(var(--up)/0.08)] text-up"
                                    : "border-[hsl(var(--glass-border))] bg-muted/30 text-muted-foreground",
                              )}
                            >
                              {line.symbol} {line.side === "none" ? "no trade" : line.side}
                            </span>
                          ))}
                        </div>
                        <div className="mt-0.5 font-mono text-[10px] text-muted-foreground">
                          {inv.account || inv.user_id}
                        </div>
                      </td>
                      {residualView ? (
                        <>
                          <td className="px-3 py-2 text-right font-mono tabular-nums text-muted-foreground">
                            {centsToR(inv.basketCents)}
                          </td>
                          <td className="px-3 py-2 text-right font-mono tabular-nums text-emerald-500">
                            {centsToR(inv.residualCents)}
                          </td>
                          <td className="px-3 py-2 text-right font-mono tabular-nums text-violet-400">
                            {centsToR(inv.reserveCents)}
                          </td>
                          <td className="px-3 py-2 text-right font-mono tabular-nums text-emerald-500">
                            {centsToR(inv.strategyCashAfterCents)}
                          </td>
                          <td
                            className={cn(
                              "px-5 py-2 text-right font-mono tabular-nums font-semibold",
                              inv.shortfall ? "text-down" : "text-foreground",
                            )}
                          >
                            {centsToR(inv.reserveAfterCents)}
                          </td>
                        </>
                      ) : (
                        <>
                          <td className="px-3 py-2 text-right font-mono text-[11px] tabular-nums text-muted-foreground">
                            <div className="space-y-1">
                              {inv.lines.map((line) => (
                                <div key={line.symbol}>
                                  {line.lots == null
                                    ? "—"
                                    : Number.isInteger(line.lots)
                                      ? line.lots
                                      : line.lots.toLocaleString("en-ZA", { maximumFractionDigits: 2 })}
                                </div>
                              ))}
                            </div>
                          </td>
                          <td className="px-3 py-2 text-right font-mono text-[11px] tabular-nums text-muted-foreground">
                            <div className="space-y-1">
                              {inv.lines.map((line) => <div key={line.symbol}>{line.currentQty}</div>)}
                            </div>
                          </td>
                          <td className="px-3 py-2 text-right font-mono text-[11px] font-semibold tabular-nums">
                            <div className="space-y-1">
                              {inv.lines.map((line) => <div key={line.symbol}>{line.targetQty}</div>)}
                            </div>
                          </td>
                          <td className="px-3 py-2 text-right font-mono text-[11px] font-semibold tabular-nums">
                            <div className="space-y-1">
                              {inv.lines.map((line) => (
                                <div key={line.symbol} className={line.deltaQty < 0 ? "text-down" : "text-up"}>
                                  {line.deltaQty > 0 ? "+" : ""}{line.deltaQty}
                                </div>
                              ))}
                            </div>
                          </td>
                          <td className="px-5 py-2 text-right font-mono text-[11px] font-semibold tabular-nums">
                            <div className="space-y-1">
                              {inv.lines.map((line) => (
                                <div
                                  key={line.symbol}
                                  className={line.currentPnlCents < 0 ? "text-down" : line.currentPnlCents > 0 ? "text-up" : "text-muted-foreground"}
                                >
                                  {line.currentPnlCents > 0 ? "+" : ""}{centsToR(line.currentPnlCents)}
                                </div>
                              ))}
                            </div>
                          </td>
                        </>
                      )}
                    </tr>
                  </React.Fragment>
                ))}
              </tbody>
            </table>
          </div>
          )}
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[hsl(var(--glass-border))] bg-[hsl(var(--foreground)/0.018)] px-5 py-4">
            <div>
              <div className="text-xs font-semibold">
                {isExecute ? "Ready to commit this trade sequence?" : "Review the sequence before it goes to the IC"}
              </div>
              <div className="mt-0.5 text-[10px] text-muted-foreground">
                {isExecute
                  ? "Creates the controlled IC proposal with this client-impact snapshot. No market order is sent yet."
                  : "Continue to pick the buy instrument and review the full fee bridge before this is sent to the IC."}
              </div>
            </div>
            <button
              type="button"
              onClick={isExecute ? onCommit : onProceed}
              disabled={commitDisabled}
              title={commitTitle}
              className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground shadow-[0_8px_24px_hsl(var(--primary)/0.18)] transition hover:-translate-y-0.5 disabled:translate-y-0 disabled:cursor-not-allowed disabled:opacity-45"
            >
              <Send className="h-3.5 w-3.5" />
              {isExecute ? (submitting ? "Committing…" : "Commit trade sequence") : "Commit trade sequence"}
            </button>
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
