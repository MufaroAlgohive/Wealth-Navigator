"use client";

import { useEffect, useMemo, useState } from "react";
import { MinusCircle, PlusCircle, Search } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { GlassBadge } from "@/components/oems/primitives/glass";
import { cn } from "@/lib/cn";
import { formatZARExact } from "@/lib/format";
import {
  filterStockCandidates,
  previewProposalImpact,
  securitiesMapFromEquities,
} from "@/lib/research-lab/proposals";
import type { HoldingRow, ProposalAction, SessionProposal } from "@/lib/research-lab/types";
import {
  CompactWeightPreview,
  ProposalImpactPreview,
} from "@/components/research-lab/proposal-impact-preview";

type WizardStep = "select" | "thesis" | "quantity" | "review";

export interface ProposalWorkflowOpen {
  action: ProposalAction;
  ticker?: string;
  name?: string;
}

interface EquityRef {
  symbol: string;
  name: string | null;
  sector: string | null;
  industry?: string | null;
  last_price: number | null;
  pe?: number | null;
  eps?: number | null;
  dividend_yield?: number | null;
  beta?: number | null;
  market_cap?: number | null;
  ytd_performance?: number | null;
  price_source?: "iress" | "yahoo";
}

interface ProposalWorkflowDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initial: ProposalWorkflowOpen | null;
  currentHoldings: HoldingRow[];
  basketMin: number;
  equities: EquityRef[];
  existingProposals: SessionProposal[];
  onConfirm: (proposal: SessionProposal) => void;
}

const STEP_LABELS: Record<WizardStep, string> = {
  select: "Select stock",
  thesis: "Investment thesis",
  quantity: "Share quantity",
  review: "Impact preview",
};

export function ProposalWorkflowDialog({
  open,
  onOpenChange,
  initial,
  currentHoldings,
  basketMin,
  equities,
  existingProposals,
  onConfirm,
}: ProposalWorkflowDialogProps) {
  const action = initial?.action ?? "add";
  const [step, setStep] = useState<WizardStep>("select");
  const [query, setQuery] = useState("");
  const [ticker, setTicker] = useState("");
  const [name, setName] = useState("");
  const [thesis, setThesis] = useState("");
  const [saleTrigger, setSaleTrigger] = useState("");
  const [shares, setShares] = useState("");

  const secMap = useMemo(() => securitiesMapFromEquities(equities), [equities]);

  const holdingTickers = useMemo(
    () => new Set(currentHoldings.map((h) => h.ticker)),
    [currentHoldings],
  );

  useEffect(() => {
    if (!open || !initial) return;
    const preselected = initial.ticker;
    if (preselected) {
      setTicker(preselected);
      setName(initial.name ?? preselected);
      setStep("thesis");
    } else {
      setStep("select");
    }
    setQuery("");
    setThesis("");
    setSaleTrigger("");
    setShares("");
  }, [open, initial]);

  const candidates = useMemo(() => {
    if (action === "remove") {
      const q = query.trim().toUpperCase();
      return currentHoldings
        .filter(
          (h) =>
            !q ||
            h.ticker.includes(q) ||
            h.name.toUpperCase().includes(q),
        )
        .slice(0, 8)
        .map((h) => ({ ticker: h.ticker, name: h.name }));
    }
    return filterStockCandidates(equities, query, { limit: 8 });
  }, [action, query, equities, currentHoldings]);

  const sharesNum = Math.max(0, Math.floor(Number(shares) || 0));
  const selectedHolding = currentHoldings.find((h) => h.ticker === ticker) ?? null;
  const maxRemoveShares = selectedHolding?.shares ?? 0;

  const impact = useMemo(() => {
    if (!ticker || sharesNum <= 0) return null;
    return previewProposalImpact(
      currentHoldings,
      { action, ticker, name, shares: sharesNum },
      basketMin,
      secMap,
      existingProposals,
    );
  }, [action, ticker, name, sharesNum, currentHoldings, basketMin, secMap, existingProposals]);

  const priceRands = useMemo(() => {
    const fromHolding = selectedHolding?.price;
    if (fromHolding && fromHolding > 0) return fromHolding;
    const sec = secMap.get(ticker);
    if (sec?.last_price && sec.last_price > 0) return sec.last_price / 100;
    return 0;
  }, [selectedHolding, secMap, ticker]);

  const steps: WizardStep[] =
    initial?.ticker != null ? ["thesis", "quantity", "review"] : ["select", "thesis", "quantity", "review"];

  const stepIndex = steps.indexOf(step);

  function close() {
    onOpenChange(false);
  }

  function pickStock(t: string, n: string) {
    setTicker(t);
    setName(n);
    setStep("thesis");
    setQuery("");
  }

  function canAdvance(): boolean {
    if (step === "select") return Boolean(ticker);
    if (step === "thesis") {
      if (!thesis.trim()) return false;
      if (action === "remove" && !saleTrigger.trim()) return false;
      return true;
    }
    if (step === "quantity") {
      if (sharesNum <= 0) return false;
      if (action === "remove" && sharesNum > maxRemoveShares) return false;
      return true;
    }
    return true;
  }

  function goNext() {
    const i = steps.indexOf(step);
    if (i < steps.length - 1) setStep(steps[i + 1]!);
  }

  function goBack() {
    const i = steps.indexOf(step);
    if (i > 0) setStep(steps[i - 1]!);
  }

  function handleConfirm() {
    if (!ticker || sharesNum <= 0 || !thesis.trim()) return;
    if (action === "remove" && !saleTrigger.trim()) return;

    const proposal: SessionProposal = {
      id: crypto.randomUUID(),
      action,
      ticker,
      name,
      shares: sharesNum,
      thesis: thesis.trim(),
      saleTrigger: action === "remove" ? saleTrigger.trim() : undefined,
      status: "submitted",
      createdAt: new Date().toISOString(),
    };
    onConfirm(proposal);
    close();
  }

  const title = action === "add" ? "Propose stock addition" : "Propose stock removal";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="glass-panel max-h-[90vh] max-w-xl overflow-y-auto border-[hsl(var(--glass-border))] bg-[hsl(var(--card))] shadow-[0_24px_80px_hsl(var(--primary)/0.12)] sm:max-w-2xl">
        <DialogHeader>
          <div className="flex items-center gap-2">
            {action === "add" ? (
              <PlusCircle className="h-5 w-5 text-primary" />
            ) : (
              <MinusCircle className="h-5 w-5 text-down" />
            )}
            <DialogTitle>{title}</DialogTitle>
          </div>
          <DialogDescription>
            Step {stepIndex + 1} of {steps.length} · {STEP_LABELS[step]}
          </DialogDescription>
          <div className="flex gap-1 pt-2">
            {steps.map((s, i) => (
              <div
                key={s}
                className={cn(
                  "h-1 flex-1 rounded-full transition-colors",
                  i <= stepIndex ? "bg-primary" : "bg-[hsl(var(--foreground)/0.08)]",
                )}
              />
            ))}
          </div>
        </DialogHeader>

        {step === "select" && (
          <div className="space-y-4">
            <div className="relative">
              <Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder={action === "add" ? "Search JSE universe…" : "Filter current holdings…"}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="glass-inset h-11 border-0 pl-10 shadow-none"
                autoFocus
              />
            </div>
            <ul className="glass-inset max-h-56 divide-y divide-[hsl(var(--glass-border))] overflow-y-auto">
              {candidates.length === 0 ? (
                <li className="px-4 py-6 text-center text-sm text-muted-foreground">
                  {action === "add"
                    ? "Type a ticker or company name to search."
                    : "No matching holdings in the current basket."}
                </li>
              ) : (
                candidates.map((c) => (
                  <li key={c.ticker}>
                    <button
                      type="button"
                      className={cn(
                        "flex w-full items-center justify-between px-4 py-3 text-left text-sm transition-colors hover:bg-[hsl(var(--primary)/0.06)]",
                        ticker === c.ticker && "bg-[hsl(var(--primary)/0.08)]",
                      )}
                      onClick={() => pickStock(c.ticker, c.name)}
                    >
                      <span>
                        <span className="font-semibold text-primary">{c.ticker}</span>
                        <span className="ml-2 text-muted-foreground">{c.name}</span>
                      </span>
                      {action === "remove" && (
                        <span className="font-mono text-xs text-muted-foreground">
                          {currentHoldings.find((h) => h.ticker === c.ticker)?.shares ?? 0} sh
                        </span>
                      )}
                    </button>
                  </li>
                ))
              )}
            </ul>
            {action === "add" && ticker && holdingTickers.has(ticker) && (
              <p className="text-caption text-warning">
                {ticker} is already in the basket — this proposal will increase the position.
              </p>
            )}
          </div>
        )}

        {step === "thesis" && (
          <div className="space-y-4">
            <GlassBadge tone={action === "add" ? "primary" : "neutral"}>
              {ticker} · {name}
            </GlassBadge>
            <div className="space-y-2">
              <Label htmlFor="proposal-thesis">
                {action === "add"
                  ? "Why are you adding this stock?"
                  : "Why are you removing this stock?"}
              </Label>
              <textarea
                id="proposal-thesis"
                value={thesis}
                onChange={(e) => setThesis(e.target.value)}
                placeholder={
                  action === "add"
                    ? "Describe the investment thesis — yield, valuation, sector view…"
                    : "Explain why this holding no longer fits the strategy…"
                }
                rows={4}
                className="glass-inset w-full resize-none rounded-xl border-0 bg-transparent px-3 py-2.5 text-sm shadow-none outline-none ring-1 ring-[hsl(var(--glass-border))] focus-visible:ring-primary"
                autoFocus
              />
            </div>
            {action === "remove" && (
              <div className="space-y-2">
                <Label htmlFor="proposal-sale-trigger">What would be the trigger for a sale?</Label>
                <textarea
                  id="proposal-sale-trigger"
                  value={saleTrigger}
                  onChange={(e) => setSaleTrigger(e.target.value)}
                  placeholder="e.g. Dividend cut, P/E above 18x, sector downgrade…"
                  rows={3}
                  className="glass-inset w-full resize-none rounded-xl border-0 bg-transparent px-3 py-2.5 text-sm shadow-none outline-none ring-1 ring-[hsl(var(--glass-border))] focus-visible:ring-primary"
                />
              </div>
            )}
          </div>
        )}

        {step === "quantity" && (
          <div className="space-y-4">
            <GlassBadge>{ticker} · {formatZARExact(priceRands)} per share</GlassBadge>
            <div className="space-y-2">
              <Label htmlFor="proposal-shares">How many shares?</Label>
              <Input
                id="proposal-shares"
                type="number"
                min={1}
                max={action === "remove" ? maxRemoveShares : undefined}
                value={shares}
                onChange={(e) => setShares(e.target.value)}
                placeholder={action === "remove" ? `Max ${maxRemoveShares}` : "Enter share count"}
                className="glass-inset h-11 border-0 font-mono shadow-none"
                autoFocus
              />
              {action === "remove" && maxRemoveShares > 0 && (
                <p className="text-caption">
                  Current position: {maxRemoveShares} shares ·{" "}
                  {selectedHolding ? formatZARExact(selectedHolding.value) : "—"}
                </p>
              )}
              {priceRands <= 0 && (
                <p className="text-caption text-warning">
                  No live price for {ticker} — weight preview uses basket minimum only.
                </p>
              )}
            </div>
            {impact && sharesNum > 0 && (
              <div className="glass-inset space-y-2 p-4">
                <p className="text-caption">Estimated impact</p>
                <div className="flex flex-wrap gap-4">
                  <div>
                    <p className="text-caption">Trade value</p>
                    <p className="font-mono text-sm font-semibold tabular-nums">
                      {formatZARExact(sharesNum * priceRands)}
                    </p>
                  </div>
                  <div>
                    <p className="text-caption">Resulting basket weight</p>
                    <p className="font-mono text-sm font-semibold text-primary tabular-nums">
                      {impact.after?.basketWeight.toFixed(2) ?? "0.00"}%
                    </p>
                  </div>
                  <div>
                    <p className="text-caption">Weight change</p>
                    <p
                      className={cn(
                        "font-mono text-sm font-semibold tabular-nums",
                        impact.weightDelta > 0 && "text-up",
                        impact.weightDelta < 0 && "text-down",
                      )}
                    >
                      {impact.weightDelta >= 0 ? "+" : ""}
                      {impact.weightDelta.toFixed(2)} pp
                    </p>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {step === "review" && impact && (
          <div className="space-y-4">
            <ProposalImpactPreview
              action={action}
              ticker={ticker}
              name={name}
              shares={sharesNum}
              before={impact.before}
              after={impact.after}
              totals={impact.totals}
              weightDelta={impact.weightDelta}
            />
            <CompactWeightPreview holdings={impact.holdings} highlightTicker={ticker} />
            <div className="glass-inset space-y-2 p-4 text-sm">
              <p className="text-caption font-medium">Thesis</p>
              <p className="leading-relaxed text-foreground/90">{thesis}</p>
              {action === "remove" && saleTrigger && (
                <>
                  <p className="pt-2 text-caption font-medium">Sale trigger</p>
                  <p className="leading-relaxed text-foreground/90">{saleTrigger}</p>
                </>
              )}
            </div>
            <p className="text-caption">
              Submitting queues this change for committee review. Persistence to strategies_c requires the
              research_workflow BFF (not yet live).
            </p>
          </div>
        )}

        <DialogFooter className="gap-2 sm:gap-0">
          {stepIndex > 0 ? (
            <Button type="button" variant="ghost" onClick={goBack}>
              Back
            </Button>
          ) : (
            <Button type="button" variant="ghost" onClick={close}>
              Cancel
            </Button>
          )}
          {step !== "review" ? (
            <Button type="button" onClick={goNext} disabled={!canAdvance()}>
              Continue
            </Button>
          ) : (
            <Button type="button" onClick={handleConfirm} disabled={!canAdvance() || !impact}>
              Submit proposal
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
