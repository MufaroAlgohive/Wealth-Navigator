"use client";

/**
 * Rebalance Builder — build a proposal instrument-by-instrument. Left: the
 * working basket (trim / grow / drop, live prices → live weights). Right: the
 * resulting proposed basket + changes pending. Submit to IC writes a
 * rebalance_request_c (status=pending); the IC gate promotes it to ic_approved,
 * after which "Send to Order Book" pushes it into oems_order_audit.
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ArrowDown, ArrowUp, ChevronDown, Info, Plus, Rocket, Send, X } from "lucide-react";
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
// One symbol's compliance drift for a single client — current holding vs.
// where the strategy's persisted model says they should be, independent of
// whatever's staged in compose. Always populated for every held/modelled
// symbol (unlike ImpactLine, which only exists for symbols with an actual
// proposed change) — used by the "expand a client row" comparison panel.
type DriftLine = {
  symbol: string;
  lots: number;
  currentQty: number;
  modelQty: number;
  deltaQty: number;
  priceCents: number;
  currentValueCents: number;
  modelValueCents: number;
  currentWeightPct: number;
  modelWeightPct: number;
  currentPnlCents: number;
};
type ImpactInvestor = {
  user_id: string;
  name: string;
  account?: string;
  basketCents: number;
  driftLines: DriftLine[];
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
  // Must match on the bare symbol, not the raw ticker: baseline holdings
  // (from the strategy's stored composition) carry the ".JO"/".JSE" suffix,
  // but the buy-instrument dropdown's universe is bare-symbol only (see
  // `buyUniverse` below). Comparing suffixed vs bare made every buy of an
  // instrument already in the model register as a brand-new "add" instead
  // of an "increase" — which the impact API correctly rejects, since an
  // "add" is only valid when the symbol has zero current model units.
  return bare(h.ticker);
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
  // today); "execute" swaps that out for a per-leg wizard — one sell at a
  // time, each independently Liquidated or Reinvested and sized off its own
  // proceeds — followed by a review screen. Submit to IC only ever fires from
  // the final Commit button on the review screen.
  const [stage, setStage] = React.useState<"compose" | "execute">("compose");
  // Wizard: "leg" while stepping through sell 1-of-N..N-of-N, "review" once
  // every leg has a resolved choice (liquidate, or reinvest + buy picked).
  const [wizardStage, setWizardStage] = React.useState<"leg" | "review">("leg");
  const [currentLegIndex, setCurrentLegIndex] = React.useState(0);
  // Per-leg state, keyed by the SELL symbol that leg is funded by. A leg with
  // no entry here yet is unresolved (wizard can't advance past it).
  const [legChoiceBySymbol, setLegChoiceBySymbol] = React.useState<
    Record<string, "reinvest" | "liquidate">
  >({});
  const [legBuyBySymbol, setLegBuyBySymbol] = React.useState<
    Record<string, { symbol: string; name: string; priceCents: number; shares: number } | null>
  >({});
  const [legBuySearchBySymbol, setLegBuySearchBySymbol] = React.useState<Record<string, string>>({});
  // Buy Execution step (mirrors CRM's rebShowBuyModal): an 8% conservative-
  // price buffer applied to the auto-sized share count, shared across every
  // leg for simplicity. "Use remaining + wallet credits to buy another
  // security" and "View Detailed Effect" are CRM features not ported — see chat.
  const [applyBuffer, setApplyBuffer] = React.useState(true);
  // Default: a direct compose-level increase with no matching sell is paired
  // implicitly into the same combined swap/pool as everything else — no
  // separate wizard step, funded silently from strategy CA + reserve. Turning
  // this on gives every such increase its own leg in the wizard instead: its
  // own step, its own Buy Execution breakdown, its own affordability check
  // against what's left of CA + reserve after earlier legs. Off by default
  // so the common "just bump one holding" case stays a single click.
  const [splitIncreaseLegs, setSplitIncreaseLegs] = React.useState(false);

  // Reset rationale when the basket switches strategies so old text doesn't
  // leak across strategies.
  React.useEffect(() => {
    setRationaleBySymbol({});
  }, [strategyId]);

  React.useEffect(() => {
    setWorking(baseline.map((h) => ({ ...h })));
    setAddOpen(false);
    setStage("compose");
    setWizardStage("leg");
    setCurrentLegIndex(0);
    setLegChoiceBySymbol({});
    setLegBuyBySymbol({});
    setLegBuySearchBySymbol({});
    setApplyBuffer(true);
    setSplitIncreaseLegs(false);
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
  // On a real (non-test) strategy, don't just block submit on missing research
  // -- don't even offer the instrument as a buy target. Submitting without
  // research was previously only caught at the very end (submitToIc), which
  // meant an admin could build out a whole buy leg, fee bridge and all,
  // before discovering it can't go to the IC.
  const buyUniverseForStrategy = isTestStrategy
    ? buyUniverse
    : buyUniverse.filter((u) => notedSymbols.has(u.symbol.toUpperCase()));
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

  // Combine every leg's chosen buy into one set of rows, summing shares when
  // two different legs happen to pick the same instrument (rather than one
  // leg's pick silently overwriting another's).
  const wizardBuyRows: ProposedHolding[] = React.useMemo(() => {
    const bySymbol = new Map<string, { name: string; shares: number }>();
    for (const leg of Object.values(legBuyBySymbol)) {
      if (!leg) continue;
      const key = leg.symbol.toUpperCase();
      const cur = bySymbol.get(key) ?? { name: leg.name, shares: 0 };
      cur.shares += leg.shares;
      bySymbol.set(key, cur);
    }
    return [...bySymbol.entries()].map(([ticker, { name, shares }]) => {
      const b = baseByKey.get(ticker);
      const action: CompAction = !b
        ? "add"
        : shares > b.shares
          ? "increase"
          : shares < b.shares
            ? "decrease"
            : "hold";
      return {
        ticker,
        name,
        shares,
        price: priceOf(ticker) ?? undefined,
        weight: 0,
        action,
        researchRef: researchRefFor(ticker),
        rationale: rationaleBySymbol[ticker] || undefined,
      };
    });
  }, [legBuyBySymbol, baseByKey, priceOf, rationaleBySymbol]);

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
    // Buys picked in the per-leg wizard — never written into `working` itself
    // (see chooseLegBuyInstrument), so they're folded in here instead.
    ...wizardBuyRows,
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
  // The per-leg wizard resolves each sell independently (liquidate or
  // reinvest-with-buy), so the overall mode is just whatever that mix
  // produces — reinvest the moment any leg has a buy, liquidate otherwise.
  // No separate override needed: `buyActions`/`sellActions` already reflect
  // every leg's resolved choice via `wizardBuyRows` above.
  const effectiveProceedsMode = inferredProceedsMode;
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
    // Fetches even with zero changes: the "Client impact preview" screen
    // should show every current holder of this strategy (baseline cash,
    // reserve, holdings) before the user has proposed any move at all,
    // not just after — the route already handles an all-"hold" `proposed`
    // array fine, it just returns side:"none" lines with no fee impact.
    enabled: !!strategyId,
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

  // Per-leg sell breakdown (qty, price, gross, fees, net proceeds) computed
  // directly from the impact response's own per-investor lines, filtered to
  // one sell symbol — the same math the server's calculateProceedsBridge
  // uses, just scoped to a single leg instead of the pooled total. This is
  // what lets each leg size its own buy off its own proceeds, not everyone
  // else's combined pool.
  const legSellBreakdown = React.useCallback(
    (sellSymbol: string) => {
      const investorsData = impactQ.data?.investors ?? [];
      const brokerageRate = impactQ.data?.feeConfig?.brokerageRate ?? 0;
      const custodyFeeCents = impactQ.data?.feeConfig?.custodyFeeCents ?? 0;
      const lines = investorsData.flatMap((inv) =>
        inv.lines.filter((l) => l.side === "sell" && l.symbol === sellSymbol),
      );
      const qty = lines.reduce((s, l) => s + Math.abs(l.deltaQty), 0);
      const grossCents = lines.reduce((s, l) => s + l.valueCents, 0);
      const priceCents = qty > 0 ? grossCents / qty : (lines[0]?.priceCents ?? 0);
      const investorCount = investorsData.filter((inv) =>
        inv.lines.some((l) => l.side === "sell" && l.symbol === sellSymbol),
      ).length;
      const brokerageCents = Math.round(grossCents * brokerageRate);
      const custodyCents = investorCount * custodyFeeCents;
      const netCents = Math.max(0, grossCents - brokerageCents - custodyCents);
      return { qty, priceCents, grossCents, brokerageCents, custodyCents, netCents, investorCount };
    },
    [impactQ.data],
  );

  // Same idea as legSellBreakdown, mirrored for the buy side — used by a
  // standalone "increase" leg (a direct compose-level bump with no matching
  // sell), which has no picker of its own: the instrument and share count
  // are already fixed by the compose edit, so this just reads what the
  // impact response already computed for it.
  const legBuyBreakdown = React.useCallback(
    (buySymbol: string) => {
      const investorsData = impactQ.data?.investors ?? [];
      const brokerageRate = impactQ.data?.feeConfig?.brokerageRate ?? 0;
      const custodyFeeCents = impactQ.data?.feeConfig?.custodyFeeCents ?? 0;
      const lines = investorsData.flatMap((inv) =>
        inv.lines.filter((l) => l.side === "buy" && l.symbol === buySymbol),
      );
      const qty = lines.reduce((s, l) => s + Math.abs(l.deltaQty), 0);
      const grossCents = lines.reduce((s, l) => s + l.valueCents, 0);
      const priceCents = qty > 0 ? grossCents / qty : (lines[0]?.priceCents ?? 0);
      const investorCount = investorsData.filter((inv) =>
        inv.lines.some((l) => l.side === "buy" && l.symbol === buySymbol),
      ).length;
      const brokerageCents = Math.round(grossCents * brokerageRate);
      const custodyCents = investorCount * custodyFeeCents;
      const totalCostCents = grossCents + brokerageCents + custodyCents;
      return { qty, priceCents, grossCents, brokerageCents, custodyCents, totalCostCents, investorCount };
    },
    [impactQ.data],
  );

  // Every direct compose-level increase with no matching sell — used both as
  // the (optional) standalone wizard legs when splitIncreaseLegs is on, and
  // pooled into the combined step's totals when it's off.
  const standaloneIncreaseLegs: Array<Extract<Leg, { kind: "increase" }>> = working
    .filter((h) => actionFor(h) === "increase")
    .map((h) => {
      const symbol = keyOf(h);
      return { kind: "increase" as const, symbol, name: h.name ?? symbol, breakdown: legBuyBreakdown(symbol) };
    });
  const combinedSellLegs: Array<Extract<Leg, { kind: "sell" }>> = sellActions.map((a) => {
    const symbol = a.ticker.toUpperCase();
    return { kind: "sell" as const, symbol, name: a.name ?? symbol, breakdown: legSellBreakdown(symbol) };
  });
  // Interactive per-leg stepping (LegStepView / IncreaseLegStepView, each
  // with its own Liquidate/Reinvest choice) only applies when the user has
  // explicitly asked to split — otherwise every sell and every increase,
  // no matter how many of each, are pooled into ONE combined step (see
  // CombinedStepView) and there's nothing per-leg to decide.
  const wizardLegs: Leg[] = splitIncreaseLegs ? [...combinedSellLegs, ...standaloneIncreaseLegs] : [];
  // Always the full set, used to render the Review screen's sequence list
  // regardless of split state — a pooled increase is still a real leg that
  // happened, just not one the user stepped through individually.
  const allLegsForReview: Leg[] = [...combinedSellLegs, ...standaloneIncreaseLegs];

  // Picking an instrument for ONE leg — auto-sized off that leg's own net
  // proceeds (legSellBreakdown), never the pooled total across every sell.
  const chooseLegBuyInstrument = (sellSymbol: string, symbol: string, name: string, priceCents: number) => {
    const netProceeds = legSellBreakdown(sellSymbol).netCents;
    const bufferedPriceCents = priceCents * (applyBuffer ? 1.08 : 1);
    const affordable = bufferedPriceCents > 0 ? Math.max(0, Math.floor(netProceeds / bufferedPriceCents)) : 0;
    setLegBuyBySymbol((prev) => ({ ...prev, [sellSymbol]: { symbol, name, priceCents, shares: affordable } }));
    setLegChoiceBySymbol((prev) => ({ ...prev, [sellSymbol]: "reinvest" }));
  };
  const setLegBuyShares = (sellSymbol: string, shares: number) =>
    setLegBuyBySymbol((prev) => {
      const cur = prev[sellSymbol];
      if (!cur) return prev;
      return { ...prev, [sellSymbol]: { ...cur, shares: Math.max(0, Math.floor(shares)) } };
    });
  const chooseLegMode = (sellSymbol: string, mode: "reinvest" | "liquidate") => {
    setLegChoiceBySymbol((prev) => ({ ...prev, [sellSymbol]: mode }));
    if (mode === "liquidate") {
      setLegBuyBySymbol((prev) => ({ ...prev, [sellSymbol]: null }));
      setLegBuySearchBySymbol((prev) => ({ ...prev, [sellSymbol]: "" }));
    }
  };
  // Re-price every leg's auto-computed share count when the buffer toggle
  // changes — matches CRM recomputing autoBuyPerLot off the buffered price.
  // A manual shares override afterward still wins until the buffer flips again.
  React.useEffect(() => {
    setLegBuyBySymbol((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const [sellSymbol, leg] of Object.entries(prev)) {
        if (!leg) continue;
        const netProceeds = legSellBreakdown(sellSymbol).netCents;
        const bufferedPriceCents = leg.priceCents * (applyBuffer ? 1.08 : 1);
        const affordable = bufferedPriceCents > 0 ? Math.max(0, Math.floor(netProceeds / bufferedPriceCents)) : 0;
        if (affordable !== leg.shares) {
          next[sellSymbol] = { ...leg, shares: affordable };
          changed = true;
        }
      }
      return changed ? next : prev;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applyBuffer]);

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
    // The impact API now computes sell-only totals when Reinvest is chosen
    // but no BUY is picked yet (see impact/route.ts) — this is the one place
    // that must still refuse to submit that state.
    if (effectiveProceedsMode === "reinvest" && buyActions.length === 0) {
      setError("Pick a replacement BUY instrument before committing this reinvest.");
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
      setWizardStage("leg");
      setCurrentLegIndex(0);
      setLegChoiceBySymbol({});
      setLegBuyBySymbol({});
      setLegBuySearchBySymbol({});
      setApplyBuffer(true);
      setSplitIncreaseLegs(false);
      setStage("compose");
    } finally {
      setSubmitting(false);
    }
  }

  const reinvestMissingBuy = effectiveProceedsMode === "reinvest" && buyActions.length === 0;
  // Belt-and-braces: the real Commit button only ever renders on the review
  // screen (see wizardStage wiring below), but guard the disabled state too
  // in case that ever changes.
  const wizardNotReady = stage === "execute" && wizardStage !== "review";
  const commitDisabled =
    submitting ||
    changes === 0 ||
    (!isTestStrategy && missingResearch.length > 0) ||
    (!isTestStrategy && rationalesMissing.length > 0) ||
    impactQ.isFetching ||
    impactQ.data?.ok !== true ||
    impactQ.data?.totals?.cashOk === false ||
    reinvestMissingBuy ||
    wizardNotReady ||
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
              : reinvestMissingBuy
                ? "Pick a replacement BUY instrument before committing"
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
          style={{ colorScheme: "dark" }}
          className="rounded-lg border border-[hsl(var(--glass-border))] bg-[hsl(var(--foreground)/0.03)] px-3 py-2 text-sm text-foreground outline-none focus:border-primary/50"
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
        enabled={!!strategyId}
        loading={impactQ.isFetching}
        data={impactQ.data}
        strategyName={strategyName}
        legs={wizardLegs}
        reviewLegs={allLegsForReview}
        combinedSellLegs={combinedSellLegs}
        standaloneIncreaseLegs={standaloneIncreaseLegs}
        splitIncreaseLegs={splitIncreaseLegs}
        onSplitIncreaseLegsChange={setSplitIncreaseLegs}
        wizardStage={wizardStage}
        currentLegIndex={currentLegIndex}
        legChoiceBySymbol={legChoiceBySymbol}
        legBuyBySymbol={legBuyBySymbol}
        legBuySearchBySymbol={legBuySearchBySymbol}
        submitting={submitting}
        commitDisabled={commitDisabled}
        commitTitle={commitTitle}
        onProceed={() => {
          if (commitDisabled) return;
          setWizardStage("leg");
          setCurrentLegIndex(0);
          setStage("execute");
        }}
        onCommit={submitToIc}
        onBack={() => {
          setWizardStage("leg");
          setCurrentLegIndex(0);
          setStage("compose");
        }}
        onChooseLegMode={chooseLegMode}
        onSelectLegBuyInstrument={chooseLegBuyInstrument}
        onLegSharesOverride={setLegBuyShares}
        onLegBuySearchChange={(symbol, value) =>
          setLegBuySearchBySymbol((prev) => ({ ...prev, [symbol]: value }))
        }
        onPrevLeg={() => setCurrentLegIndex((i) => Math.max(0, i - 1))}
        onNextLeg={(legCount) =>
          setCurrentLegIndex((i) => {
            const next = i + 1;
            if (next >= legCount) setWizardStage("review");
            return next;
          })
        }
        onBackToLegs={() => {
          setCurrentLegIndex(Math.max(0, wizardLegs.length - 1));
          setWizardStage("leg");
        }}
        proceedsMode={effectiveProceedsMode}
        buyUniverse={buyUniverseForStrategy}
        buyUniverseLoading={equitiesQ.isLoading}
        buyUniverseResearchGated={!isTestStrategy}
        applyBuffer={applyBuffer}
        onApplyBufferChange={setApplyBuffer}
      />

      <ProposalsList pushingId={pushingId} setPushingId={setPushingId} canPush={perms.pushRebalance} />
    </ResearchLabCanvas>
  );
}

/** Cents (int) → "R1,234.00". */
function centsToR(c: number | null | undefined): string {
  return moneyR((Number(c) || 0) / 100);
}

/** A single fee-bridge line: label left, value right, red when it's a deduction. */
function BridgeRow({ label, value, deduct, bold }: { label: string; value: string; deduct?: boolean; bold?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4 text-xs">
      <span className={cn(bold ? "font-semibold" : "text-muted-foreground")}>{label}</span>
      <span className={cn("font-mono tabular-nums", bold && "font-semibold", deduct && "text-down")}>
        {deduct ? "−" : ""}{value}
      </span>
    </div>
  );
}

/**
 * Sell/Buy execution breakdown — the exact CRM layout (dashboard.html's
 * rebShowSellModal / rebShowBuyModal: Total Shares to Sell, Price per Share,
 * Gross Proceeds, Brokerage, Off-Custody Fee, Net Proceeds — same for the buy
 * leg), computed directly from the per-investor lines already in the impact
 * response rather than the murkier pooled totals. No "estimated" hedging —
 * these are the same brokerage/custody figures App Settings drives on CRM.
 * Sell and buy are kept in separate self-contained cards: CRM's Sell modal
 * never mixes in reserve/shortfall figures, those are Buy-modal-only.
 */
function FeeProceedsBreakdown({
  data,
  proceedsMode,
}: {
  data: ImpactResponse;
  proceedsMode: "reinvest" | "liquidate" | null;
}) {
  const totals = data.totals;
  if (!totals) return null;
  const investors = data.investors ?? [];
  const feeRate = Number(data.feeConfig?.brokerageRate ?? 0) * 100;

  const sellLines = investors.flatMap((inv) => inv.lines.filter((l) => l.side === "sell"));
  const totalSharesToSell = sellLines.reduce((s, l) => s + Math.abs(l.deltaQty), 0);
  const grossProceeds = sellLines.reduce((s, l) => s + l.valueCents, 0);
  const sellBrokerage = investors.reduce((s, inv) => s + (inv.sellBrokerageCents || 0), 0);
  const sellCustody = investors.reduce((s, inv) => s + (inv.sellCustodyCents || 0), 0);
  // Custody is flat per client per traded asset — the "(xN)" label must count
  // only clients actually touching THIS leg, not everyone in the sequence.
  // Using the blanket investor count here mislabeled the fee (e.g. "(x2)" next
  // to an amount that was actually only 1 client's flat fee).
  const sellInvestorCount = investors.filter((inv) => inv.lines.some((l) => l.side === "sell")).length;
  const netProceeds = grossProceeds - sellBrokerage - sellCustody;
  const avgSellPriceCents = totalSharesToSell > 0 ? grossProceeds / totalSharesToSell : 0;
  const sellTickers = [...new Set(sellLines.map((l) => l.symbol))];

  const buyLines = investors.flatMap((inv) => inv.lines.filter((l) => l.side === "buy"));
  const showBuyCard = proceedsMode === "reinvest" && buyLines.length > 0;
  const totalSharesToBuy = buyLines.reduce((s, l) => s + Math.abs(l.deltaQty), 0);
  const grossCost = buyLines.reduce((s, l) => s + l.valueCents, 0);
  const buyBrokerage = investors.reduce((s, inv) => s + (inv.buyBrokerageCents || 0), 0);
  const buyCustody = investors.reduce((s, inv) => s + (inv.buyCustodyCents || 0), 0);
  const buyInvestorCount = investors.filter((inv) => inv.lines.some((l) => l.side === "buy")).length;
  const totalCost = grossCost + buyBrokerage + buyCustody;
  const avgBuyPriceCents = totalSharesToBuy > 0 ? grossCost / totalSharesToBuy : 0;
  const buyTickers = [...new Set(buyLines.map((l) => l.symbol))];
  const reserveBefore = totals.reserveCents ?? 0;
  const reserveUsed = totals.reserveUsedCents ?? 0;
  const reserveAfter = investors.reduce((s, inv) => s + (inv.reserveAfterCents || 0), 0);
  const feeShortfall = totals.feeShortfallCents ?? 0;
  const residualAfter = proceedsMode === "liquidate" ? totals.strategyCashAfterCents : totals.cashAfterCents;
  const shortfallInvestors = investors.filter((inv) => inv.shortfall);
  const cashOk = totals.cashOk ?? true;

  return (
    <div className="border-b border-[hsl(var(--glass-border))] px-5 py-4 space-y-4">
      {!cashOk ? (
        <div className="rounded-xl border border-[hsl(var(--down)/0.4)] bg-[hsl(var(--down)/0.08)] p-4 text-xs">
          <p className="font-semibold text-down">
            Fees exceed what {shortfallInvestors.length === 1 ? "this client" : "these clients"} can absorb —
            commit is blocked.
          </p>
          <p className="mt-1 text-foreground/80">
            Sale proceeds don't cover the fees, and the shortfall isn't fully covered by their 8% execution
            reserve either — the remainder would have to reduce invested portfolio value. This is never charged
            to the client directly; the sequence simply can't commit until it's resolved (reduce the trade size,
            or wait for reserve to rebuild).
          </p>
          {shortfallInvestors.length ? (
            <p className="mt-1.5 font-medium text-down">
              Affected: {shortfallInvestors.map((inv) => inv.name).join(", ")}
            </p>
          ) : null}
        </div>
      ) : null}
      <div className="rounded-xl border border-[hsl(var(--glass-border))] p-4">
        <div className="mb-3 flex items-center gap-1.5 text-xs font-semibold">
          <Info className="h-3.5 w-3.5 text-primary" /> Sell Execution
          <span className="font-normal text-muted-foreground">
            · {sellTickers.join(", ") || "—"}
          </span>
        </div>
        <div className="space-y-2">
          <BridgeRow label="Total Shares to Sell" value={totalSharesToSell.toLocaleString()} />
          <BridgeRow label="Price per Share" value={centsToR(avgSellPriceCents)} />
          <BridgeRow label="Gross Proceeds" value={centsToR(grossProceeds)} />
          <BridgeRow label={`Brokerage (${feeRate.toFixed(1)}%)`} value={centsToR(sellBrokerage)} deduct />
          <BridgeRow label={`Off-Custody Fee (x${sellInvestorCount})`} value={centsToR(sellCustody)} deduct />
          <div className="border-t border-[hsl(var(--glass-border))] pt-2">
            <BridgeRow label="Net Proceeds" value={centsToR(netProceeds)} bold />
          </div>
        </div>
      </div>

      {showBuyCard ? (
        <div className="rounded-xl border border-[hsl(var(--glass-border))] p-4">
          <div className="mb-3 flex items-center gap-1.5 text-xs font-semibold">
            <Info className="h-3.5 w-3.5 text-primary" /> Buy Execution
            <span className="font-normal text-muted-foreground">
              · {buyTickers.join(", ") || "—"}
            </span>
          </div>
          <div className="space-y-2">
            <BridgeRow label="Execution Price" value={centsToR(avgBuyPriceCents)} />
            <BridgeRow label="Total Shares" value={totalSharesToBuy.toLocaleString()} />
            <BridgeRow label="Gross Cost" value={centsToR(grossCost)} />
            <BridgeRow label={`Brokerage (${feeRate.toFixed(1)}%)`} value={centsToR(buyBrokerage)} deduct />
            <BridgeRow label={`Custody Fee (x${buyInvestorCount})`} value={centsToR(buyCustody)} deduct />
            <div className="border-t border-[hsl(var(--glass-border))] pt-2">
              <BridgeRow label="Total Cost" value={centsToR(totalCost)} bold />
            </div>
            <div className="border-t border-[hsl(var(--glass-border))] pt-2 mt-1">
              <BridgeRow label="8% Reserve Before" value={centsToR(reserveBefore)} />
              <BridgeRow label="Fees Paid from Reserve" value={centsToR(reserveUsed)} deduct />
              <BridgeRow label="8% Reserve After" value={centsToR(reserveAfter)} />
              <BridgeRow label="Portfolio-Funded Fee Shortfall" value={centsToR(feeShortfall)} deduct={feeShortfall > 0} />
              <BridgeRow label="Residual Cash" value={centsToR(residualAfter)} bold />
            </div>
          </div>
          {/* Per-Client Allocation — CRM's exact shape: shares bought + residual
              cash per client, not the denser stat grid the sell side doesn't have. */}
          <div className="mt-3 border-t border-[hsl(var(--glass-border))] pt-3">
            <p className="mb-2 text-xs font-semibold text-muted-foreground">Per-Client Allocation</p>
            <div className="space-y-1.5">
              {data.investors?.map((investor) => {
                const buyLine = investor.lines.find((l) => l.side === "buy");
                const shares = buyLine ? Math.abs(buyLine.deltaQty) : 0;
                return (
                  <div key={investor.user_id} className="flex items-center justify-between text-xs">
                    <span>{investor.name}</span>
                    <span className="font-mono text-muted-foreground">
                      {shares.toLocaleString()} shares · {centsToR(investor.cashAfterCents)} residual
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      ) : null}

      {!showBuyCard && data.investors?.length ? (
        <div className="overflow-hidden rounded-xl border border-[hsl(var(--glass-border))]">
          <div className="border-b border-[hsl(var(--glass-border))] bg-[hsl(var(--foreground)/0.02)] px-3 py-2 text-xs font-semibold">
            Per-Client Effect
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

type LegBuyPick = { symbol: string; name: string; priceCents: number; shares: number };
type LegSellBreakdown = {
  qty: number;
  priceCents: number;
  grossCents: number;
  brokerageCents: number;
  custodyCents: number;
  netCents: number;
  investorCount: number;
};
type LegBuyBreakdown = {
  qty: number;
  priceCents: number;
  grossCents: number;
  brokerageCents: number;
  custodyCents: number;
  totalCostCents: number;
  investorCount: number;
};
type Leg =
  | { kind: "sell"; symbol: string; name: string; breakdown: LegSellBreakdown }
  | { kind: "increase"; symbol: string; name: string; breakdown: LegBuyBreakdown };

/**
 * One step of the sell→buy wizard: this leg's own sell breakdown, an
 * independent Liquidate/Reinvest choice, and — if reinvesting — a buy picker
 * sized off THIS leg's own net proceeds only, never the pooled total across
 * every sell in the sequence. Reuses the same visual language as the rest of
 * the panel (bordered cards, BridgeRow, the dark-mode-fixed select).
 */
function LegStepView({
  leg,
  legIndex,
  legCount,
  choice,
  buyPick,
  brokerageRate,
  custodyFeeCents,
  buySearch,
  buyUniverse,
  buyUniverseLoading,
  buyUniverseResearchGated,
  applyBuffer,
  onApplyBufferChange,
  onChooseMode,
  onSelectBuyInstrument,
  onSharesOverride,
  onBuySearchChange,
  onPrev,
  onNext,
}: {
  leg: Extract<Leg, { kind: "sell" }>;
  legIndex: number;
  legCount: number;
  choice: "reinvest" | "liquidate" | undefined;
  buyPick: LegBuyPick | null | undefined;
  brokerageRate: number;
  custodyFeeCents: number;
  buySearch: string;
  buyUniverse: Array<{ symbol: string; name: string; priceCents: number }>;
  buyUniverseLoading: boolean;
  buyUniverseResearchGated: boolean;
  applyBuffer: boolean;
  onApplyBufferChange: (value: boolean) => void;
  onChooseMode: (mode: "reinvest" | "liquidate") => void;
  onSelectBuyInstrument: (symbol: string, name: string, priceCents: number) => void;
  onSharesOverride: (shares: number) => void;
  onBuySearchChange: (value: string) => void;
  onPrev: () => void;
  onNext: () => void;
}) {
  // Mirrors what the commit-time aggregate (calculateProceedsBridge /
  // impact/route.ts) actually charges: brokerage % + a flat custody fee per
  // investor on the REAL price, not the buffered sizing price — the 8%
  // buffer only sizes the auto-suggested share count, the server never
  // applies it to real trade value or fees.
  //
  // Critically, `buyPick.shares` is the MODEL-UNIT share count — it gets
  // applied to EVERY investor in this leg independently (calculateModelUnitImpact
  // multiplies by each investor's own lot count), not spent once. leg's own
  // sell breakdown already reflects this (its `qty` is the summed total
  // across every investor), so the buy side must scale the same way or the
  // two sides of this comparison aren't the same unit — which is exactly
  // how a leg could show "covered" here and then fail the real aggregate:
  // a 2-investor leg buying "9 shares" actually spends 9-per-investor (18
  // total), not 9 total. Assumes uniform 1-lot-per-investor, matching the
  // common case — not a guarantee for an investor holding multiple lots.
  const buyGrossCents = buyPick ? buyPick.shares * buyPick.priceCents * leg.breakdown.investorCount : 0;
  const buyBrokerageCents = Math.round(buyGrossCents * brokerageRate);
  const buyCustodyCents = buyPick ? custodyFeeCents * leg.breakdown.investorCount : 0;
  const buyCostCents = buyGrossCents + buyBrokerageCents + buyCustodyCents;
  const affordable = !buyPick || buyCostCents <= leg.breakdown.netCents;
  const resolved = choice === "liquidate" || (choice === "reinvest" && !!buyPick && affordable);
  const buySearchQ = buySearch.trim().toLowerCase();
  const filteredBuyUniverse = buySearchQ
    ? buyUniverse.filter((u) => `${u.symbol} ${u.name}`.toLowerCase().includes(buySearchQ))
    : buyUniverse;

  return (
    <div>
      <div className="border-b border-[hsl(var(--glass-border))] px-5 py-4">
        <div className="rounded-xl border border-[hsl(var(--glass-border))] p-4">
          <div className="mb-3 flex items-center gap-1.5 text-xs font-semibold">
            <Info className="h-3.5 w-3.5 text-primary" /> Sell Execution
            <span className="font-normal text-muted-foreground">· {leg.symbol}</span>
          </div>
          <div className="space-y-2">
            <BridgeRow label="Total Shares to Sell" value={leg.breakdown.qty.toLocaleString()} />
            <BridgeRow label="Price per Share" value={centsToR(leg.breakdown.priceCents)} />
            <BridgeRow label="Gross Proceeds" value={centsToR(leg.breakdown.grossCents)} />
            <BridgeRow label="Brokerage" value={centsToR(leg.breakdown.brokerageCents)} deduct />
            <BridgeRow
              label={`Off-Custody Fee (x${leg.breakdown.investorCount})`}
              value={centsToR(leg.breakdown.custodyCents)}
              deduct
            />
            <div className="border-t border-[hsl(var(--glass-border))] pt-2">
              <BridgeRow label="Net Proceeds" value={centsToR(leg.breakdown.netCents)} bold />
            </div>
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 border-b border-[hsl(var(--glass-border))] px-5 py-3">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          This leg's proceeds:
        </span>
        <button
          type="button"
          onClick={() => onChooseMode("reinvest")}
          className={cn(
            "rounded-full border px-3 py-1 text-[11px] font-semibold transition",
            choice === "reinvest"
              ? "border-primary/50 bg-primary/15 text-primary"
              : "border-[hsl(var(--glass-border))] text-muted-foreground hover:bg-[hsl(var(--foreground)/0.05)]",
          )}
        >
          Reinvest · buy replacement
        </button>
        <button
          type="button"
          onClick={() => onChooseMode("liquidate")}
          className={cn(
            "rounded-full border px-3 py-1 text-[11px] font-semibold transition",
            choice === "liquidate"
              ? "border-primary/50 bg-primary/15 text-primary"
              : "border-[hsl(var(--glass-border))] text-muted-foreground hover:bg-[hsl(var(--foreground)/0.05)]",
          )}
        >
          Liquidate to Cash
        </button>
      </div>

      {choice === "reinvest" ? (
        <div className="border-b border-[hsl(var(--glass-border))] px-5 py-4">
          <div className="flex items-baseline justify-between gap-3">
            <div className="text-xs font-semibold">Buy Execution</div>
            <div className="text-[11px] text-muted-foreground">
              Net capital: <span className="font-mono tabular-nums text-foreground/85">{centsToR(leg.breakdown.netCents)}</span>
            </div>
          </div>
          <div className="mt-3 rounded-lg border border-[hsl(var(--glass-border))] bg-[hsl(var(--foreground)/0.02)] p-3">
            <label className="block text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              Instrument to buy
            </label>
            {buyUniverseResearchGated ? (
              <p className="mt-0.5 text-[10px] text-muted-foreground/70">
                Only instruments with an existing research note are listed — add one in the Research Library to unlock it here.
              </p>
            ) : null}
            <input
              value={buySearch}
              onChange={(e) => onBuySearchChange(e.target.value)}
              placeholder="Search by name or symbol…"
              className="mt-1.5 block w-full rounded-lg border border-[hsl(var(--glass-border))] bg-[hsl(var(--foreground)/0.03)] px-3 py-1.5 text-xs outline-none focus:border-primary/50"
            />
            <div className="mt-2.5 flex flex-wrap items-center gap-3">
              <select
                value={buyPick?.symbol ?? ""}
                onChange={(e) => {
                  const meta = buyUniverse.find((u) => u.symbol === e.target.value);
                  if (meta) onSelectBuyInstrument(meta.symbol, meta.name, meta.priceCents);
                }}
                style={{ colorScheme: "dark" }}
                className="min-w-[260px] flex-1 rounded-lg border border-[hsl(var(--glass-border))] bg-[hsl(var(--foreground)/0.03)] px-3 py-1.5 text-xs text-foreground outline-none focus:border-primary/50"
              >
                <option value="">
                  {buyUniverseLoading
                    ? "Loading instruments…"
                    : `Select instrument (${filteredBuyUniverse.length})…`}
                </option>
                {filteredBuyUniverse.map((u) => (
                  <option key={u.symbol} value={u.symbol}>
                    {u.symbol} · {u.name}
                    {u.priceCents > 0 ? ` · ${centsToR(u.priceCents)}` : " · N/A"}
                  </option>
                ))}
              </select>
              {buyPick ? (
                <label className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  Shares
                  <input
                    type="number"
                    min={0}
                    step={1}
                    value={buyPick.shares}
                    onChange={(e) => onSharesOverride(Number(e.target.value) || 0)}
                    placeholder="auto"
                    className="w-20 rounded-md border border-[hsl(var(--glass-border))] bg-[hsl(var(--foreground)/0.03)] px-2 py-1 text-xs outline-none"
                  />
                </label>
              ) : null}
            </div>
            {buyPick ? (
              <div
                className={cn(
                  "mt-2 rounded-md px-2.5 py-1.5 text-[11px] font-medium",
                  affordable ? "bg-[hsl(var(--up)/0.1)] text-up" : "bg-[hsl(var(--down)/0.1)] text-down",
                )}
              >
                {affordable
                  ? `Covered — ${centsToR(leg.breakdown.netCents - buyCostCents)} left over from this leg's proceeds (fees included).`
                  : `Not enough — this costs ${centsToR(buyCostCents)} with fees but only ${centsToR(leg.breakdown.netCents)} is available. Reduce share amount or choose another asset to proceed.`}
              </div>
            ) : null}
          </div>
          <label className="mt-3 flex items-center gap-2 text-xs text-foreground/85">
            <input
              type="checkbox"
              checked={applyBuffer}
              onChange={(e) => onApplyBufferChange(e.target.checked)}
              className="h-4 w-4 rounded border-[hsl(var(--glass-border))] accent-primary"
            />
            Apply 8% buffer to price (conservative)
          </label>
        </div>
      ) : null}

      <div className="flex items-center justify-between border-t border-[hsl(var(--glass-border))] bg-[hsl(var(--foreground)/0.018)] px-5 py-4">
        <button
          type="button"
          onClick={onPrev}
          disabled={legIndex === 0}
          className="rounded-lg border border-[hsl(var(--glass-border))] px-4 py-2 text-xs font-medium hover:bg-[hsl(var(--foreground)/0.05)] disabled:cursor-not-allowed disabled:opacity-45"
        >
          ← Back
        </button>
        <button
          type="button"
          onClick={onNext}
          disabled={!resolved}
          title={resolved ? undefined : "Choose Liquidate or pick a replacement buy for this leg"}
          className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground shadow-[0_8px_24px_hsl(var(--primary)/0.18)] transition hover:-translate-y-0.5 disabled:translate-y-0 disabled:cursor-not-allowed disabled:opacity-45"
        >
          {legIndex + 1 < legCount ? "Next leg →" : "Review sequence →"}
        </button>
      </div>
    </div>
  );
}

/**
 * A standalone "increase" leg: a direct compose-level bump with no matching
 * sell (e.g. bump HYP from 3 to 5 units with nothing decreased to fund it).
 * Unlike a sell leg there's no Liquidate/Reinvest choice and no instrument
 * picker — the instrument and share count are already fixed by the compose
 * edit. This just shows what it costs and checks it against what's left of
 * the strategy's existing CA + reserve pool, after any earlier increase-legs
 * in this same sequence have already claimed their share of it.
 */
function IncreaseLegStepView({
  leg,
  legIndex,
  legCount,
  availablePoolCents,
  investors,
  onPrev,
  onNext,
}: {
  leg: Extract<Leg, { kind: "increase" }>;
  legIndex: number;
  legCount: number;
  availablePoolCents: number;
  // Only the investors this leg actually affects (i.e. hold a buy line for
  // leg.symbol) — used to show each client's own cash + reserve impact.
  investors: ImpactInvestor[];
  onPrev: () => void;
  onNext: () => void;
}) {
  const affordable = leg.breakdown.totalCostCents <= availablePoolCents;
  const [clientsOpen, setClientsOpen] = React.useState(false);

  return (
    <div>
      {investors.length > 0 ? (
        <div className="border-b border-[hsl(var(--glass-border))]">
          <button
            type="button"
            onClick={() => setClientsOpen((v) => !v)}
            className="flex w-full items-center justify-between px-5 py-3 text-left text-xs font-semibold hover:bg-[hsl(var(--foreground)/0.03)]"
          >
            <span>
              Per-client cash impact <span className="font-normal text-muted-foreground">· {investors.length} client{investors.length === 1 ? "" : "s"}</span>
            </span>
            <ChevronDown className={cn("h-4 w-4 text-muted-foreground transition-transform", clientsOpen && "rotate-180")} />
          </button>
          {clientsOpen ? (
            <div className="px-5 pb-4">
              <p className="mb-2 text-[10px] text-muted-foreground">
                "Now" is each client's cash + reserve before any leg in this sequence runs. "After full
                sequence" is what it will be once every leg (not just this one) has been committed — there's
                no separate "after this leg only" figure, since legs settle together in one commit.
              </p>
              <div className="overflow-x-auto rounded-lg border border-[hsl(var(--glass-border))]">
                <table className="w-full min-w-[520px] text-[11px]">
                  <thead className="bg-[hsl(var(--foreground)/0.03)] text-muted-foreground">
                    <tr>
                      <th className="px-3 py-1.5 text-left font-medium">Client</th>
                      <th className="px-3 py-1.5 text-right font-medium">CA now</th>
                      <th className="px-3 py-1.5 text-right font-medium">CA after full sequence</th>
                      <th className="px-3 py-1.5 text-right font-medium">Reserve now</th>
                      <th className="px-3 py-1.5 text-right font-medium">Reserve after full sequence</th>
                    </tr>
                  </thead>
                  <tbody>
                    {investors.map((inv) => (
                      <tr key={inv.user_id} className="border-t border-[hsl(var(--glass-border))]">
                        <td className="px-3 py-1.5 font-medium">{inv.name}</td>
                        <td className="px-3 py-1.5 text-right font-mono tabular-nums">{centsToR(inv.residualCents)}</td>
                        <td className="px-3 py-1.5 text-right font-mono tabular-nums">{centsToR(inv.cashAfterCents)}</td>
                        <td className="px-3 py-1.5 text-right font-mono tabular-nums">{centsToR(inv.reserveCents)}</td>
                        <td className="px-3 py-1.5 text-right font-mono tabular-nums">{centsToR(inv.reserveAfterCents)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
      <div className="border-b border-[hsl(var(--glass-border))] px-5 py-4">
        <div className="rounded-xl border border-[hsl(var(--glass-border))] p-4">
          <div className="mb-3 flex items-center gap-1.5 text-xs font-semibold">
            <Info className="h-3.5 w-3.5 text-primary" /> Buy Execution
            <span className="font-normal text-muted-foreground">· {leg.symbol}</span>
          </div>
          <div className="space-y-2">
            <BridgeRow label="Total Shares" value={leg.breakdown.qty.toLocaleString()} />
            <BridgeRow label="Execution Price" value={centsToR(leg.breakdown.priceCents)} />
            <BridgeRow label="Gross Cost" value={centsToR(leg.breakdown.grossCents)} />
            <BridgeRow label="Brokerage" value={centsToR(leg.breakdown.brokerageCents)} deduct />
            <BridgeRow
              label={`Custody Fee (x${leg.breakdown.investorCount})`}
              value={centsToR(leg.breakdown.custodyCents)}
              deduct
            />
            <div className="border-t border-[hsl(var(--glass-border))] pt-2">
              <BridgeRow label="Total Cost" value={centsToR(leg.breakdown.totalCostCents)} bold />
            </div>
          </div>
        </div>
        <div
          className={cn(
            "mt-3 rounded-md px-2.5 py-1.5 text-[11px] font-medium",
            affordable ? "bg-[hsl(var(--up)/0.1)] text-up" : "bg-[hsl(var(--down)/0.1)] text-down",
          )}
        >
          {affordable
            ? `Covered — ${centsToR(availablePoolCents - leg.breakdown.totalCostCents)} left in strategy CA + reserve after this increase.`
            : `Not enough — this costs ${centsToR(leg.breakdown.totalCostCents)} but only ${centsToR(availablePoolCents)} is left in strategy CA + reserve. Go back to compose and reduce the share count for ${leg.symbol}.`}
        </div>
      </div>
      <div className="flex items-center justify-between border-t border-[hsl(var(--glass-border))] bg-[hsl(var(--foreground)/0.018)] px-5 py-4">
        <button
          type="button"
          onClick={onPrev}
          disabled={legIndex === 0}
          className="rounded-lg border border-[hsl(var(--glass-border))] px-4 py-2 text-xs font-medium hover:bg-[hsl(var(--foreground)/0.05)] disabled:cursor-not-allowed disabled:opacity-45"
        >
          ← Back
        </button>
        <button
          type="button"
          onClick={onNext}
          disabled={!affordable}
          title={affordable ? undefined : "This increase doesn't fit inside the remaining strategy CA + reserve"}
          className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground shadow-[0_8px_24px_hsl(var(--primary)/0.18)] transition hover:-translate-y-0.5 disabled:translate-y-0 disabled:cursor-not-allowed disabled:opacity-45"
        >
          {legIndex + 1 < legCount ? "Next leg →" : "Review sequence →"}
        </button>
      </div>
    </div>
  );
}

/**
 * The default (non-split) view: every sell and every standalone increase in
 * this sequence, pooled into one screen — no per-leg Liquidate/Reinvest
 * choice, because with splitIncreaseLegs off there's nothing to decide per
 * leg. Sells fund the pool, increases draw from it; this is just a listing
 * of both sides plus the net, so it's visible before Review rather than
 * only inside the aggregate FeeProceedsBreakdown there. Works for any
 * number of sells and increases, not just a 1:1 pair.
 */
function CombinedStepView({
  sellLegs,
  increaseLegs,
  onNext,
}: {
  sellLegs: Array<Extract<Leg, { kind: "sell" }>>;
  increaseLegs: Array<Extract<Leg, { kind: "increase" }>>;
  onNext: () => void;
}) {
  const totalSellNetCents = sellLegs.reduce((s, l) => s + l.breakdown.netCents, 0);
  const totalBuyCostCents = increaseLegs.reduce((s, l) => s + l.breakdown.totalCostCents, 0);
  const netCents = totalSellNetCents - totalBuyCostCents;

  return (
    <div>
      {sellLegs.length > 0 ? (
        <div className="border-b border-[hsl(var(--glass-border))] px-5 py-4">
          <div className="mb-3 flex items-center gap-1.5 text-xs font-semibold">
            <Info className="h-3.5 w-3.5 text-primary" /> Sell Execution
          </div>
          <div className="space-y-2">
            {sellLegs.map((leg) => (
              <BridgeRow
                key={leg.symbol}
                label={`${leg.symbol} · ${leg.breakdown.qty.toLocaleString()} shares`}
                value={centsToR(leg.breakdown.netCents)}
              />
            ))}
            <div className="border-t border-[hsl(var(--glass-border))] pt-2">
              <BridgeRow label="Total Net Proceeds" value={centsToR(totalSellNetCents)} bold />
            </div>
          </div>
        </div>
      ) : null}
      {increaseLegs.length > 0 ? (
        <div className="border-b border-[hsl(var(--glass-border))] px-5 py-4">
          <div className="mb-3 flex items-center gap-1.5 text-xs font-semibold">
            <Info className="h-3.5 w-3.5 text-primary" /> Buy Execution
          </div>
          <div className="space-y-2">
            {increaseLegs.map((leg) => (
              <BridgeRow
                key={leg.symbol}
                label={`${leg.symbol} · ${leg.breakdown.qty.toLocaleString()} shares`}
                value={centsToR(leg.breakdown.totalCostCents)}
                deduct
              />
            ))}
            <div className="border-t border-[hsl(var(--glass-border))] pt-2">
              <BridgeRow label="Total Cost" value={centsToR(totalBuyCostCents)} bold />
            </div>
          </div>
        </div>
      ) : null}
      <div className="flex items-center justify-between border-b border-[hsl(var(--glass-border))] bg-[hsl(var(--foreground)/0.02)] px-5 py-3">
        <span className="text-xs font-semibold">Net (sells − buys, fees included)</span>
        <span
          className={cn(
            "font-mono text-sm font-semibold tabular-nums",
            netCents >= 0 ? "text-up" : "text-down",
          )}
        >
          {centsToR(netCents)}
        </span>
      </div>
      <div className="flex items-center justify-end border-t border-[hsl(var(--glass-border))] bg-[hsl(var(--foreground)/0.018)] px-5 py-4">
        <button
          type="button"
          onClick={onNext}
          className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground shadow-[0_8px_24px_hsl(var(--primary)/0.18)] transition hover:-translate-y-0.5"
        >
          Review sequence →
        </button>
      </div>
    </div>
  );
}

/**
 * Expanded-row content for one client on the (pre-any-change) Client impact
 * preview: their actual holdings vs. the strategy's persisted model
 * (compliance drift, computed server-side in driftLines — see impact/route.ts),
 * independent of anything staged in compose. "Rebalance single user" is a
 * placeholder for now — scoping the trade-sequence wizard down to one client
 * is a separate, larger piece of work the user asked to defer.
 */
function ClientDriftPanel({ investor, strategyName }: { investor: ImpactInvestor; strategyName: string }) {
  const lines = investor.driftLines ?? [];
  if (lines.length === 0) {
    return <p className="px-5 py-3 text-caption">No holdings to compare against {strategyName} yet.</p>;
  }
  return (
    <div className="border-t border-[hsl(var(--glass-border))] bg-[hsl(var(--foreground)/0.015)] px-5 py-3">
      <div className="overflow-x-auto rounded-lg border border-[hsl(var(--glass-border))]">
        <table className="w-full min-w-[560px] text-[11px]">
          <thead className="bg-[hsl(var(--foreground)/0.03)] text-muted-foreground">
            <tr>
              <th className="px-3 py-1.5 text-left font-medium">Symbol</th>
              <th className="px-3 py-1.5 text-right font-medium">Price</th>
              <th className="px-3 py-1.5 text-right font-medium">Lots</th>
              <th className="px-3 py-1.5 text-right font-medium">Current</th>
              <th className="px-3 py-1.5 text-right font-medium">Model</th>
              <th className="px-3 py-1.5 text-right font-medium">Δ</th>
              <th className="px-3 py-1.5 text-right font-medium">P/L</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((line) => (
              <tr key={line.symbol} className="border-t border-[hsl(var(--glass-border))]">
                <td className="px-3 py-1.5 font-medium">{line.symbol}</td>
                <td className="px-3 py-1.5 text-right font-mono tabular-nums text-muted-foreground">
                  {centsToR(line.priceCents)}
                </td>
                <td className="px-3 py-1.5 text-right font-mono tabular-nums text-muted-foreground">
                  {line.lots > 0
                    ? Number.isInteger(line.lots)
                      ? line.lots
                      : line.lots.toLocaleString("en-ZA", { maximumFractionDigits: 2 })
                    : "—"}
                </td>
                <td className="px-3 py-1.5 text-right font-mono tabular-nums">
                  {line.currentQty.toLocaleString()}
                  <span className="ml-1 text-muted-foreground">({line.currentWeightPct.toFixed(1)}%)</span>
                </td>
                <td className="px-3 py-1.5 text-right font-mono tabular-nums">
                  {line.modelQty.toLocaleString()}
                  <span className="ml-1 text-muted-foreground">({line.modelWeightPct.toFixed(1)}%)</span>
                </td>
                <td
                  className={cn(
                    "px-3 py-1.5 text-right font-mono font-semibold tabular-nums",
                    line.deltaQty > 0 ? "text-up" : line.deltaQty < 0 ? "text-down" : "text-muted-foreground",
                  )}
                >
                  {line.deltaQty > 0 ? "+" : ""}
                  {line.deltaQty}
                </td>
                <td
                  className={cn(
                    "px-3 py-1.5 text-right font-mono font-semibold tabular-nums",
                    line.currentPnlCents > 0 ? "text-up" : line.currentPnlCents < 0 ? "text-down" : "text-muted-foreground",
                  )}
                >
                  {line.currentPnlCents > 0 ? "+" : ""}
                  {centsToR(line.currentPnlCents)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-2.5 flex items-center justify-between">
        <p className="text-[10px] text-muted-foreground">
          Model column compares against {strategyName}'s current persisted composition, not anything staged above.
        </p>
        <button
          type="button"
          disabled
          title="Coming soon — will open a trade sequence scoped to just this client"
          className="inline-flex items-center gap-1.5 rounded-lg border border-[hsl(var(--glass-border))] px-3 py-1.5 text-[11px] font-medium text-muted-foreground opacity-60"
        >
          Rebalance single user
        </button>
      </div>
    </div>
  );
}

function TradeSequencePanel({
  mode,
  enabled,
  loading,
  data,
  strategyName,
  legs,
  reviewLegs,
  combinedSellLegs,
  standaloneIncreaseLegs,
  splitIncreaseLegs,
  onSplitIncreaseLegsChange,
  wizardStage,
  currentLegIndex,
  legChoiceBySymbol,
  legBuyBySymbol,
  legBuySearchBySymbol,
  submitting,
  commitDisabled,
  commitTitle,
  onProceed,
  onCommit,
  onBack,
  onChooseLegMode,
  onSelectLegBuyInstrument,
  onLegSharesOverride,
  onLegBuySearchChange,
  onPrevLeg,
  onNextLeg,
  onBackToLegs,
  proceedsMode,
  buyUniverse,
  buyUniverseLoading,
  buyUniverseResearchGated,
  applyBuffer,
  onApplyBufferChange,
}: {
  mode: "compose" | "execute";
  enabled: boolean;
  loading: boolean;
  data: ImpactResponse | undefined;
  strategyName: string;
  // Interactive per-leg steps — empty unless splitIncreaseLegs is on, since
  // otherwise there's nothing per-leg to decide (see CombinedStepView).
  legs: Leg[];
  // Every sell and every standalone increase, always populated regardless of
  // splitIncreaseLegs — used for the Review screen's sequence list and the
  // combined (non-split) step, neither of which cares whether a leg was
  // stepped through individually.
  reviewLegs: Leg[];
  combinedSellLegs: Array<Extract<Leg, { kind: "sell" }>>;
  // Every direct compose-level increase with no matching sell, regardless of
  // splitIncreaseLegs — always populated, drives the toggle's own visibility
  // and label so the control doesn't vanish once switched on.
  standaloneIncreaseLegs: Array<Extract<Leg, { kind: "increase" }>>;
  splitIncreaseLegs: boolean;
  onSplitIncreaseLegsChange: (value: boolean) => void;
  wizardStage: "leg" | "review";
  currentLegIndex: number;
  legChoiceBySymbol: Record<string, "reinvest" | "liquidate">;
  legBuyBySymbol: Record<string, LegBuyPick | null>;
  legBuySearchBySymbol: Record<string, string>;
  submitting: boolean;
  commitDisabled: boolean;
  commitTitle: string;
  onProceed: () => void;
  onCommit: () => void;
  onBack: () => void;
  onChooseLegMode: (symbol: string, mode: "reinvest" | "liquidate") => void;
  onSelectLegBuyInstrument: (symbol: string, buySymbol: string, name: string, priceCents: number) => void;
  onLegSharesOverride: (symbol: string, shares: number) => void;
  onLegBuySearchChange: (symbol: string, value: string) => void;
  onPrevLeg: () => void;
  onNextLeg: (legCount: number) => void;
  onBackToLegs: () => void;
  proceedsMode: "reinvest" | "liquidate" | null;
  buyUniverse: Array<{ symbol: string; name: string; priceCents: number }>;
  buyUniverseLoading: boolean;
  buyUniverseResearchGated: boolean;
  applyBuffer: boolean;
  onApplyBufferChange: (value: boolean) => void;
}) {
  const investors = data?.investors ?? [];
  const totals = data?.totals ?? null;
  const cashOk = totals?.cashOk ?? true;
  const [residualView, setResidualView] = React.useState(false);
  const [expandedUserId, setExpandedUserId] = React.useState<string | null>(null);
  const scopeLabel =
    data?.scope === "live" ? "LIVE clients" : data?.scope === "uat" ? "UAT clients" : "Scope unavailable";
  const sellSymbols = reviewLegs.map((l) => l.symbol);
  const impactLabel = sellSymbols.length ? sellSymbols.join(" + ") : strategyName;
  const isExecute = mode === "execute";
  const isCombinedMode = !splitIncreaseLegs;
  const currentLeg: Leg | undefined = legs[currentLegIndex];

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
              {wizardStage === "leg" && currentLeg
                ? `Leg ${currentLegIndex + 1} of ${legs.length}`
                : wizardStage === "leg" && isCombinedMode
                  ? "Combined sequence"
                  : proceedsMode === "liquidate"
                    ? "Liquidate to Cash"
                    : proceedsMode === "reinvest"
                      ? "Reinvest / Buy"
                      : "Increase"}
            </div>
            <div className="mt-0.5 text-xs font-medium">
              {wizardStage === "leg" && currentLeg
                ? `Selling ${currentLeg.symbol} — decide this leg's proceeds`
                : wizardStage === "leg" && isCombinedMode
                  ? "Every sell and increase pooled together — no separate legs to decide"
                  : proceedsMode === "liquidate"
                    ? "Sell-only · net proceeds settle into this strategy’s CA"
                  : proceedsMode === "reinvest"
                    ? "Sell + buy · each leg funds its own replacement"
                    : "Increase · funding is checked against strategy CA and reserve"}
            </div>
          </div>
          <div className="text-right">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
              Strategy CA after full sequence
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
      {isExecute && wizardStage === "leg" && currentLeg?.kind === "sell" ? (
        <LegStepView
          leg={currentLeg}
          legIndex={currentLegIndex}
          legCount={legs.length}
          choice={legChoiceBySymbol[currentLeg.symbol]}
          buyPick={legBuyBySymbol[currentLeg.symbol]}
          brokerageRate={data?.feeConfig?.brokerageRate ?? 0}
          custodyFeeCents={data?.feeConfig?.custodyFeeCents ?? 0}
          buySearch={legBuySearchBySymbol[currentLeg.symbol] ?? ""}
          buyUniverse={buyUniverse}
          buyUniverseLoading={buyUniverseLoading}
          buyUniverseResearchGated={buyUniverseResearchGated}
          applyBuffer={applyBuffer}
          onApplyBufferChange={onApplyBufferChange}
          onChooseMode={(m) => onChooseLegMode(currentLeg.symbol, m)}
          onSelectBuyInstrument={(buySymbol, name, priceCents) =>
            onSelectLegBuyInstrument(currentLeg.symbol, buySymbol, name, priceCents)
          }
          onSharesOverride={(shares) => onLegSharesOverride(currentLeg.symbol, shares)}
          onBuySearchChange={(value) => onLegBuySearchChange(currentLeg.symbol, value)}
          onPrev={onPrevLeg}
          onNext={() => onNextLeg(legs.length)}
        />
      ) : null}
      {isExecute && wizardStage === "leg" && currentLeg?.kind === "increase" ? (
        <IncreaseLegStepView
          leg={currentLeg}
          legIndex={currentLegIndex}
          legCount={legs.length}
          availablePoolCents={Math.max(
            0,
            (totals?.residualCents ?? 0) +
              (totals?.reserveCents ?? 0) -
              legs
                .slice(0, currentLegIndex)
                .filter((l): l is Extract<Leg, { kind: "increase" }> => l.kind === "increase")
                .reduce((s, l) => s + l.breakdown.totalCostCents, 0),
          )}
          investors={investors.filter((inv) => inv.lines.some((l) => l.side === "buy" && l.symbol === currentLeg.symbol))}
          onPrev={onPrevLeg}
          onNext={() => onNextLeg(legs.length)}
        />
      ) : null}
      {isExecute && wizardStage === "leg" && isCombinedMode && (combinedSellLegs.length > 0 || standaloneIncreaseLegs.length > 0) ? (
        <CombinedStepView
          sellLegs={combinedSellLegs}
          increaseLegs={standaloneIncreaseLegs}
          onNext={() => onNextLeg(0)}
        />
      ) : null}
      {isExecute && wizardStage === "review" && splitIncreaseLegs && reviewLegs.length > 0 ? (
        <div className="border-b border-[hsl(var(--glass-border))] px-5 py-4 space-y-2">
          <div className="text-xs font-semibold">Sequence — {reviewLegs.length} leg{reviewLegs.length === 1 ? "" : "s"}</div>
          <div className="space-y-1.5">
            {reviewLegs.map((leg, i) => {
              if (leg.kind === "increase") {
                return (
                  <div
                    key={leg.symbol}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[hsl(var(--glass-border))] px-3 py-2 text-xs"
                  >
                    <span>
                      <span className="font-mono text-muted-foreground">{i + 1} of {reviewLegs.length}</span>{" "}
                      <span className="font-semibold">{leg.symbol}</span>{" "}
                      <span className="text-muted-foreground">
                        → increased by {leg.breakdown.qty.toLocaleString()}, funded from CA + reserve
                      </span>
                    </span>
                    <span className="font-mono font-semibold text-down">{centsToR(leg.breakdown.totalCostCents)}</span>
                  </div>
                );
              }
              const choice = legChoiceBySymbol[leg.symbol];
              const buyPick = legBuyBySymbol[leg.symbol];
              return (
                <div
                  key={leg.symbol}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[hsl(var(--glass-border))] px-3 py-2 text-xs"
                >
                  <span>
                    <span className="font-mono text-muted-foreground">{i + 1} of {reviewLegs.length}</span>{" "}
                    <span className="font-semibold">{leg.symbol}</span>{" "}
                    {choice === "liquidate" ? (
                      <span className="text-muted-foreground">→ liquidated to cash</span>
                    ) : choice === "reinvest" && buyPick ? (
                      <span className="text-muted-foreground">
                        → bought {buyPick.shares.toLocaleString()} {buyPick.symbol}
                      </span>
                    ) : isCombinedMode ? (
                      <span className="text-muted-foreground">→ pooled into the combined sequence</span>
                    ) : (
                      <span className="text-down">→ unresolved</span>
                    )}
                  </span>
                  <span className="font-mono font-semibold text-up">{centsToR(leg.breakdown.netCents)}</span>
                </div>
              );
            })}
          </div>
        </div>
      ) : null}
      {isExecute && wizardStage === "review" && data ? (
        <FeeProceedsBreakdown data={data} proceedsMode={proceedsMode} />
      ) : null}
      {(!isExecute || wizardStage === "review") && (!enabled ? (
        <p className="px-5 py-4 text-caption">Select a strategy to preview client impact.</p>
      ) : data?.ok === false ? (
        <div className="mx-5 my-4 flex items-start gap-2 rounded-lg border border-[hsl(var(--down)/0.35)] bg-[hsl(var(--down)/0.08)] px-3.5 py-3 text-xs text-down">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{data.error ?? "The fee-adjusted impact preview could not be calculated."}</span>
        </div>
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
              <span className="inline-flex items-center gap-1">
                Total cost{" "}
                <span className="font-mono font-semibold text-down">
                  {centsToR((totals?.buyCents ?? 0) + (totals?.buyFeesCents ?? 0))}
                </span>
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
                {investors.map((inv) => {
                  const isExpanded = expandedUserId === inv.user_id;
                  return (
                  <React.Fragment key={inv.user_id}>
                    <tr
                      onClick={() => setExpandedUserId((id) => (id === inv.user_id ? null : inv.user_id))}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          setExpandedUserId((id) => (id === inv.user_id ? null : inv.user_id));
                        }
                      }}
                      // biome-ignore lint/a11y/useSemanticElements: a <button> can't be a valid child of <tbody>/<tr>; role+tabIndex+onKeyDown on the row is the standard pattern for a clickable table row.
                      role="button"
                      tabIndex={0}
                      aria-expanded={isExpanded}
                      className={cn(
                        "cursor-pointer border-b border-[hsl(var(--glass-border))] transition-colors",
                        inv.shortfall
                          ? "bg-[hsl(var(--down)/0.07)]"
                          : "bg-amber-500/[0.035] hover:bg-amber-500/[0.065]",
                      )}
                    >
                      <td className="px-5 py-3">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <ChevronDown
                            className={cn(
                              "h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform",
                              isExpanded && "rotate-180",
                            )}
                          />
                          <span className="font-medium">{inv.name}</span>
                          {!residualView && inv.lines.map((line) => (
                            <span
                              key={line.symbol}
                              className={cn(
                                "rounded-md border px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide",
                                line.side === "buy"
                                  ? "border-[hsl(var(--up)/0.3)] bg-[hsl(var(--up)/0.08)] text-up"
                                  : line.side === "sell"
                                    ? "border-[hsl(var(--down)/0.3)] bg-[hsl(var(--down)/0.08)] text-down"
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
                    <tr>
                      <td colSpan={6} className="p-0">
                        <div
                          className={cn(
                            "grid transition-[grid-template-rows] duration-300 ease-out",
                            isExpanded ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
                          )}
                        >
                          <div className="overflow-hidden">
                            <ClientDriftPanel investor={inv} strategyName={strategyName} />
                          </div>
                        </div>
                      </td>
                    </tr>
                  </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
          )}
          {!isExecute && standaloneIncreaseLegs.length > 0 ? (
            <div className="flex items-start gap-3 border-t border-[hsl(var(--glass-border))] bg-[hsl(var(--foreground)/0.018)] px-5 py-3 text-xs">
              <button
                type="button"
                role="switch"
                aria-checked={splitIncreaseLegs}
                onClick={() => onSplitIncreaseLegsChange(!splitIncreaseLegs)}
                className="relative mt-0.5 inline-flex h-5 w-9 shrink-0 appearance-none items-center rounded-full border-0 bg-transparent p-0 outline-none"
              >
                <span
                  className={cn(
                    "absolute inset-0 rounded-full transition-colors",
                    splitIncreaseLegs ? "bg-primary" : "bg-[hsl(var(--foreground)/0.15)]",
                  )}
                />
                <span
                  className={cn(
                    "relative h-4 w-4 rounded-full bg-white shadow-sm transition-transform",
                    splitIncreaseLegs ? "translate-x-[18px]" : "translate-x-0.5",
                  )}
                />
              </button>
              <span>
                <span className="font-medium">
                  Split {standaloneIncreaseLegs.map((l) => l.symbol).join(", ")} into{" "}
                  {standaloneIncreaseLegs.length === 1 ? "its own leg" : "their own legs"}
                </span>
                <span className="block text-[10px] text-muted-foreground">
                  Off (default): stays paired into the combined sequence, funded from strategy CA + reserve, no
                  separate step. On: each increase gets its own wizard step and its own affordability check. Safe
                  to flip back off at any point before you commit — it just changes how these legs are grouped.
                </span>
              </span>
            </div>
          ) : null}
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[hsl(var(--glass-border))] bg-[hsl(var(--foreground)/0.018)] px-5 py-4">
            <div>
              <div className={cn("text-xs font-semibold", commitDisabled && "text-down")}>
                {isExecute ? "Ready to commit this trade sequence?" : "Review the sequence before it goes to the IC"}
              </div>
              <div className={cn("mt-0.5 text-[10px]", commitDisabled ? "font-medium text-down" : "text-muted-foreground")}>
                {commitDisabled
                  ? commitTitle
                  : isExecute
                    ? "Creates the controlled IC proposal with this client-impact snapshot. No market order is sent yet."
                    : "Continue to pick each leg's buy instrument and review the full fee bridge before this is sent to the IC."}
              </div>
            </div>
            <div className="flex items-center gap-2">
              {isExecute ? (
                <button
                  type="button"
                  onClick={onBackToLegs}
                  className="rounded-lg border border-[hsl(var(--glass-border))] px-4 py-2 text-xs font-medium hover:bg-[hsl(var(--foreground)/0.05)]"
                >
                  ← Edit legs
                </button>
              ) : null}
              <button
                type="button"
                onClick={isExecute ? onCommit : onProceed}
                disabled={commitDisabled}
                title={commitTitle}
                className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground shadow-[0_8px_24px_hsl(var(--primary)/0.18)] transition hover:-translate-y-0.5 disabled:translate-y-0 disabled:cursor-not-allowed disabled:opacity-45"
              >
                <Send className="h-3.5 w-3.5" />
                {isExecute ? (submitting ? "Committing…" : "Commit trade sequence") : "Continue to trade sequence →"}
              </button>
            </div>
          </div>
        </>
      ))}
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
  const [open, setOpen] = React.useState(false);

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
    <GlassSection
      title="Proposals — at IC or executed"
      subtitle={`${requests.length} proposal${requests.length === 1 ? "" : "s"}`}
      endpoint="GET /api/rebalance/requests"
      dataSource="supabase"
      db="institutional"
      right={
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="inline-flex items-center gap-1.5 rounded-md border border-[hsl(var(--glass-border))] px-2.5 py-1 text-[11px] font-medium hover:bg-[hsl(var(--foreground)/0.05)]"
        >
          {open ? "Collapse" : "Expand"}
          <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-180")} />
        </button>
      }
    >
      {open ? (
        q.data?.notice && <p className="mb-3 text-xs text-amber-500">{q.data.notice}</p>
      ) : null}
      {!open ? null : requests.length === 0 && !q.isLoading ? (
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
