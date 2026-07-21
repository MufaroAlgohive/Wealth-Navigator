"use client";

/**
 * <GuardrailForceCorrectionDialog/>
 *
 * Shared force-correction primitive for the OEMS order system. Opens when a
 * preflight verdict blocks an order entry — a naked-short, an insufficient-
 * cash bust, an unverified sell, or any of the bulk-path limit-guard
 * violations. Used by:
 *
 *   - `/admin/order-book` `UatOrderTicket`          (single-order, code path)
 *   - `/admin/order-book` `UatTestRunner`           (bulk, list-of-violations mode)
 *   - `/oems/blotter`    `NewOrderDialog`           (single-order, blotter path)
 *   - Future: research-lab, paper-model rebalance, admin blotter.
 *
 * The single source of truth for the preflight contract is
 * `src/lib/orders/`; this dialog consumes that shape directly so adding a
 * new order-entry consumer is a one-line call away.
 *
 * See plan §3 (Shared force-correction primitive).
 */

import * as React from "react";
import { AlertTriangle, ArrowDownToLine, ShieldAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { GlassBadge } from "@/components/oems/primitives/glass";
import { cn } from "@/lib/cn";
import type { BulkViolation, PreflightResult, SubmitResult } from "@/lib/orders/types";

export type AttemptedOrder = {
  symbol: string;
  side: "buy" | "sell";
  qty: number;
  /** Price in CENTS (the core contract unit). */
  price_cents?: number | null;
};

export interface SingleModeProps {
  mode?: "single";
  attempted: AttemptedOrder;
  /** Re-runs the BFF route / `submitOrder` with the user's corrected values. */
  onResubmit: (next: { qty: number; price_cents?: number | null }) => Promise<SubmitResult>;
}

export interface BulkModeProps {
  mode: "bulk";
  attempted: AttemptedOrder;
  bulkViolations: BulkViolation[];
  /** Resubmits the entire holdings list — the BFF re-runs the limit guard. */
  onResubmit: () => Promise<SubmitResult>;
}

export type GuardrailForceCorrectionDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  preflight: PreflightResult;
} & (SingleModeProps | BulkModeProps);

function fmtRands(cents: number | null | undefined): string {
  if (cents == null || !Number.isFinite(cents)) return "MKT";
  const rands = cents / 100;
  return new Intl.NumberFormat("en-ZA", {
    style: "currency",
    currency: "ZAR",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(rands);
}

function summaryLine(attempted: AttemptedOrder, preflight: PreflightResult): string {
  if (preflight.verdict === "blocked_naked_short" && preflight.sell) {
    const { held, inflight_sells, available } = preflight.sell;
    return `You tried to ${attempted.side.toUpperCase()} ${attempted.qty.toLocaleString()} ${attempted.symbol}, but you only hold ${held.toLocaleString()} (${inflight_sells.toLocaleString()} reserved by other working sells — ${available.toLocaleString()} available).`;
  }
  if (preflight.verdict === "blocked_insufficient_cash" && preflight.cash) {
    const { cash, inflight_buys, available } = preflight.cash;
    const px = attempted.price_cents ?? null;
    const value =
      px != null
        ? `${(px / 100).toFixed(2)} × ${attempted.qty} = R${((px / 100) * attempted.qty).toFixed(2)}`
        : `${attempted.qty.toLocaleString()} ${attempted.symbol} @ MKT`;
    const av = available != null ? `R${available.toFixed(2)} available` : `cash unknown`;
    const inf = inflight_buys > 0 ? ` (R${inflight_buys.toFixed(2)} reserved by other working buys)` : "";
    return `You tried to BUY ${value}, but ${av}${inf}.`;
  }
  if (preflight.verdict === "blocked_unverifiable") {
    return `Could not verify holdings or cash for ${attempted.side.toUpperCase()} ${attempted.qty.toLocaleString()} ${attempted.symbol}. ${preflight.message}`;
  }
  return preflight.message;
}

function verdictBadgeLabel(code: PreflightResult["code"]): string {
  switch (code) {
    case "naked_short_blocked":
      return "Naked short blocked";
    case "insufficient_cash":
      return "Insufficient cash";
    case "sell_guard_unavailable":
      return "Holdings unverified";
    case "buy_guard_unavailable":
      return "Cash unverified";
    case "limit_guard_violation":
      return "Limit guard violation";
    case "limit_guard_unverified_sell":
      return "Sell not verifiable";
    case "pass":
      return "Pass";
    default:
      return code;
  }
}

export function GuardrailForceCorrectionDialog(
  props: GuardrailForceCorrectionDialogProps,
): React.ReactElement {
  const { open, onOpenChange, preflight } = props;
  const attempted = props.attempted;
  const isBulk = props.mode === "bulk";

  const [qty, setQty] = React.useState<string>(String(attempted.qty));
  const [priceRands, setPriceRands] = React.useState<string>(
    attempted.price_cents != null ? (attempted.price_cents / 100).toString() : "",
  );
  const [busy, setBusy] = React.useState(false);
  const [chainError, setChainError] = React.useState<string | null>(null);
  const [chainCode, setChainCode] = React.useState<PreflightResult["code"] | null>(null);

  // Reset internal state every time the modal re-opens or the attempted
  // values change. Important so a chained correction doesn't show stale
  // qty/price from the previous round.
  React.useEffect(() => {
    if (!open) return;
    setQty(String(attempted.qty));
    setPriceRands(attempted.price_cents != null ? (attempted.price_cents / 100).toString() : "");
    setChainError(null);
    setChainCode(null);
    setBusy(false);
  }, [open, attempted.qty, attempted.price_cents]);

  const qtyN = Number(qty);
  const priceN = Number(priceRands);
  const priceCents = Number.isFinite(priceN) && priceN > 0 ? Math.round(priceN * 100) : null;
  const canResubmit = Number.isFinite(qtyN) && qtyN > 0 && !busy;

  const runResubmit = async (override?: { qty?: number; price_cents?: number | null }) => {
    setBusy(true);
    setChainError(null);
    setChainCode(null);
    try {
      const result =
        props.mode === "bulk"
          ? await props.onResubmit()
          : await (props as SingleModeProps).onResubmit({
              qty: override?.qty ?? Math.floor(qtyN),
              price_cents: override?.price_cents ?? priceCents,
            });
      if (result.ok) {
        onOpenChange(false);
        return;
      }
      // Chain: another blocked verdict or a worker post-insert reject —
      // keep the modal open with the new reason so the trader can correct
      // again or close manually.
      setChainError(
        result.error ??
          result.preflight.message ??
          "Order was rejected. Adjust and resubmit, or close this dialog.",
      );
      setChainCode((result.worker_code as PreflightResult["code"] | undefined) ?? result.preflight.code);
      if (!result.order_audit_id) {
        // No row was written (blocked preflight); safe to keep the modal
        // open and try again.
      }
    } catch (e) {
      setChainError(e instanceof Error ? e.message : "Submit failed");
    } finally {
      setBusy(false);
    }
  };

  const available =
    preflight.verdict === "blocked_naked_short" && preflight.sell ? preflight.sell.available : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <div className="flex items-start justify-between gap-3">
            <div className="space-y-1">
              <DialogTitle className="flex items-center gap-2">
                <ShieldAlert className="h-4 w-4 text-warning" />
                Order failed pre-trade check
              </DialogTitle>
              <DialogDescription>
                The order was not sent to the broker. Correct the inputs below and resubmit — no audit row was
                written.
              </DialogDescription>
            </div>
            <GlassBadge tone="primary">
              <AlertTriangle className="h-3 w-3" />
              {verdictBadgeLabel(chainCode ?? preflight.code)}
            </GlassBadge>
          </div>
        </DialogHeader>

        {/* Reason panel — verbatim worker message + a glanceable summary */}
        <div className="space-y-2 rounded-lg border border-warning/30 bg-warning/5 p-3 text-sm">
          <p className="text-xs font-semibold uppercase tracking-wider text-warning">Why</p>
          <p className="font-mono text-xs text-foreground/90">{preflight.message}</p>
          <p className="text-foreground/80">{summaryLine(attempted, preflight)}</p>
        </div>

        {/* Bulk mode renders the violation table; single mode renders the form. */}
        {isBulk ? (
          <BulkViolationTable violations={(props as BulkModeProps).bulkViolations} />
        ) : (
          <SingleCorrectionForm
            attempted={attempted as AttemptedOrder}
            qty={qty}
            setQty={setQty}
            priceRands={priceRands}
            setPriceRands={setPriceRands}
            available={available}
            onClampToAvailable={() => setQty(String(available ?? qty))}
          />
        )}

        {chainError && (
          <div className="rounded-md border border-destructive/30 bg-destructive/5 p-2.5 text-xs">
            <p className="font-semibold text-destructive">Resubmit also failed</p>
            <p className="mt-0.5 text-foreground/90">{chainError}</p>
          </div>
        )}

        <DialogFooter className="gap-2">
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => void runResubmit()}
            disabled={!canResubmit}
            className="gap-1.5"
          >
            <ArrowDownToLine className="h-3.5 w-3.5" />
            {busy ? "Resubmitting…" : isBulk ? "Resubmit edited book" : "Resubmit order"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SingleCorrectionForm({
  attempted,
  qty,
  setQty,
  priceRands,
  setPriceRands,
  available,
  onClampToAvailable,
}: {
  attempted: AttemptedOrder;
  qty: string;
  setQty: (s: string) => void;
  priceRands: string;
  setPriceRands: (s: string) => void;
  available: number | null;
  onClampToAvailable: () => void;
}): React.ReactElement {
  return (
    <div className="grid grid-cols-2 gap-3">
      <div className="space-y-1">
        <Label
          htmlFor="gfcd-symbol"
          className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground"
        >
          Symbol
        </Label>
        <Input id="gfcd-symbol" value={attempted.symbol} readOnly className="h-8 font-mono bg-muted/30" />
      </div>
      <div className="space-y-1">
        <Label
          htmlFor="gfcd-side"
          className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground"
        >
          Side
        </Label>
        <Input
          id="gfcd-side"
          value={attempted.side.toUpperCase()}
          readOnly
          className="h-8 font-mono bg-muted/30"
        />
      </div>
      <div className="space-y-1">
        <Label
          htmlFor="gfcd-qty"
          className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground"
        >
          Quantity
        </Label>
        <div className="flex gap-1.5">
          <Input
            id="gfcd-qty"
            type="number"
            min={1}
            step={1}
            value={qty}
            onChange={(e) => setQty(e.target.value)}
            className="h-8 font-mono"
          />
          {available != null && available > 0 && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onClampToAvailable}
              className="h-8 shrink-0 text-[11px]"
              title={`Rewrite quantity to ${available} (max available-to-sell)`}
            >
              Clamp to {available}
            </Button>
          )}
        </div>
      </div>
      <div className="space-y-1">
        <Label
          htmlFor="gfcd-price"
          className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground"
        >
          Price (R) <span className="text-muted-foreground/60">(blank = market)</span>
        </Label>
        <Input
          id="gfcd-price"
          type="number"
          min={0}
          step="0.01"
          value={priceRands}
          onChange={(e) => setPriceRands(e.target.value)}
          placeholder="market"
          className="h-8 font-mono"
        />
      </div>
    </div>
  );
}

function BulkViolationTable({
  violations,
}: {
  violations: BulkViolation[];
}): React.ReactElement {
  if (violations.length === 0) return <></>;
  return (
    <div className="rounded-lg border border-border">
      <div className="flex items-center justify-between border-b border-border px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        <span>Holdings that breached the guard</span>
        <span>
          {violations.length} violation{violations.length === 1 ? "" : "s"}
        </span>
      </div>
      <ul className="max-h-56 divide-y divide-border overflow-y-auto">
        {violations.map((v) => (
          <li
            key={v.holding_id}
            className="grid grid-cols-[auto_1fr_auto] items-start gap-3 px-3 py-2 text-xs"
          >
            <span
              className={cn(
                "rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase",
                v.side === "sell" ? "bg-destructive/15 text-destructive" : "bg-success/15 text-success",
              )}
            >
              {v.side}
            </span>
            <div className="min-w-0">
              <p className="font-mono font-semibold">{v.symbol}</p>
              <p className="mt-0.5 text-muted-foreground">{v.reason}</p>
              {Object.keys(v.detail).length > 0 && (
                <dl className="mt-1 grid grid-cols-[auto_auto] gap-x-2 text-[10.5px] font-mono text-muted-foreground">
                  {Object.entries(v.detail).map(([k, val]) => (
                    <React.Fragment key={k}>
                      <dt>{k}</dt>
                      <dd className="tabular-nums">{String(val ?? "—")}</dd>
                    </React.Fragment>
                  ))}
                </dl>
              )}
            </div>
            <span className="font-mono tabular-nums">{v.qty.toLocaleString()}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// Re-export the price formatter so consumers can format values the same
// way the modal does (used by the blotter dialog's submitted-values toast).
export { fmtRands as formatRandsCents };
