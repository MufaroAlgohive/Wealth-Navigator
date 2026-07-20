"use client";

// New order dialog with pre-trade compliance checks (Mission C2 / P0).
//
// 2026-07-20 refactor: the dialog used to call
// `orderCreate3WithRecovery` directly from the in-process Iress mock
// client, which (a) bypassed every guard and (b) wrote no audit row
// (provenance entry was hard-coded "MOCK"). It now routes through
// `/api/orders/preflight` (read-only worker gate) then
// `/api/orders/submit` (BFF that uses the shared `submitOrder()` core
// helper). On a blocked verdict the shared
// `<GuardrailForceCorrectionDialog/>` opens so the trader stays on the
// entry screen and can correct qty/price and resubmit without leaving
// the page. The pre-trade checklist (halt / buying-power / mandate) is
// preserved as advisory hints above the Send button.
//
// The IRESS doc flags pre-trade compliance as P0:
//   "A live order can be rejected by IOS+ after the trader thinks it's
//    been accepted."
//
// We surface three checks above the Send button:
//   1. Halt / suspension  — fed by the live tick stream
//   2. Buying power       — qty * price vs account.cash (via
//      `useAccountCash`; real IPS portfolio in real-data mode, mock
//      fixture in demo mode)
//   3. Mandate / concentration — symbol in strategy universe
//
// The pure `preTradeCheck` helper lives in `lib/iress/strategy.ts` so the
// logic is unit-testable. The dialog only contributes the
// marketState (from `useTick`) and the account view-model.

import React, { useEffect, useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Plus, X, Check, AlertTriangle, Info } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { GuardrailForceCorrectionDialog } from "@/components/oems/primitives/guardrail-force-correction-dialog";
import { useIress } from "@/lib/iress/provider";
import { formatZARExact } from "@/lib/format";
import { useTick } from "@/lib/store/tick-stream-provider";
import { preTradeCheck, getMarketState, type PreTradeResult } from "@/lib/iress/strategy";
import { useAccountCash } from "@/lib/hooks/use-account-cash";
import type { PreflightResult, SubmitResult } from "@/lib/orders";
import { cn } from "@/lib/cn";

export function NewOrderDialog({ onCreated }: { onCreated: () => void }) {
  const { client: _client } = useIress();
  const [open, setOpen] = useState(false);
  const [side, setSide] = useState<"BUY" | "SELL">("BUY");
  const [symbol, setSymbol] = useState("NPN");
  const [qty, setQty] = useState(1_000);
  const [limit, setLimit] = useState<number | "">(4_180);
  const [tif, setTif] = useState<"DAY" | "IOC" | "FOK" | "GTC">("DAY");
  const [destination, setDestination] = useState("JSE");
  const [account, setAccount] = useState("MINT-LIVE-001");

  // OrderTag is generated once per dialog open so the trader can see the
  // idempotency key before submit (and so a re-submit uses the same tag).
  const [orderTag, setOrderTag] = useState<string>("");

  useEffect(() => {
    if (open) {
      setOrderTag(`ord-${crypto.randomUUID().slice(0, 8)}`);
    }
  }, [open]);

  // Live tick for the chosen symbol — feeds the Halt/Suspension check.
  // The store only knows instruments seeded in `initialQuotes()`; for
  // unknown symbols we fall back to the static `marketStateBySymbol`
  // fixture (e.g. ZZZZZ → HALT, XX → SUSPEND).
  const tick = useTick(symbol.toUpperCase());
  const marketState = useMemo(() => {
    const ts = tick.ts ? (tick as { marketState?: string }).marketState : undefined;
    if (ts) return String(ts).toUpperCase();
    return getMarketState(symbol.toUpperCase());
  }, [tick, symbol]);

  // Account cash (ZAR) for the pre-trade buying-power check. In
  // real-data mode the hook reads from the IPS portfolio mirror
  // (`oems_account_c` via /api/portfolio); in mock mode it falls back
  // to the seed fixture for the demo. The hook returns 0 with source
  // "unavailable" when the account is missing from the mirror — that
  // is what keeps the Send button disabled until the worker syncs
  // the row.
  const accountCash = useAccountCash(account);

  const preTrade: PreTradeResult = useMemo(() => {
    const px = limit === "" ? 0 : Number(limit);
    return preTradeCheck(
      { symbol: symbol.toUpperCase(), side, qty, price: px },
      { cash: accountCash.available },
      marketState,
    );
  }, [symbol, side, qty, limit, account, marketState, accountCash.available]);

  const blocked = preTrade.halt !== "ok" || preTrade.bp !== "ok" || preTrade.mandate === "outside";

  // Force-correction modal state. Opens on a 422 response from the BFF
  // with a `blocked_*` code, OR when the worker post-insert rejects. The
  // modal consumes the same `PreflightResult` shape every other order
  // entry surface uses.
  const [modalOpen, setModalOpen] = useState(false);
  const [modalPreflight, setModalPreflight] = useState<PreflightResult | null>(null);
  const [modalOrderTag, setModalOrderTag] = useState<string>("");

  const GUARDRAIL_BLOCK_CODES = new Set([
    "naked_short_blocked",
    "insufficient_cash",
    "sell_guard_unavailable",
    "buy_guard_unavailable",
    "limit_guard_violation",
    "limit_guard_unverified_sell",
  ]);

  const callBff = async (path: string, body: Record<string, unknown>) => {
    const r = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { ok: r.ok, status: r.status, body: (await r.json()) as SubmitResult };
  };

  const create = useMutation({
    mutationFn: async () => {
      // 2026-07-20: route through the BFF so the worker's preflight gate
      // runs BEFORE any audit row is written. The core `submitOrder()` is
      // the same helper every other entry point uses (UAT ad-hoc, bulk
      // send-to-market) — adds the typed `broker_account_code`, picks up
      // `IRESS_WORKER_DRY_RUN`, and stamps `rejected` on post-insert
      // worker reject so the UI flips off WORKING immediately.
      const px = limit === "" ? null : Number(limit);
      const priceCents = px != null && px > 0 ? Math.round(px * 100) : null;
      return callBff("/api/orders/submit", {
        account_code: account,
        symbol: symbol.toUpperCase(),
        side: side === "BUY" ? "buy" : "sell",
        qty,
        price_cents: priceCents,
        source: "BLOTTER_NEW_ORDER",
        // We don't pass OrderTag here — the BFF mints its own internally
        // (see `submitOrder`). The dialog's OrderTag stays as a visible
        // UI affordance for the trader's reference only.
      });
    },
    onSuccess: (r) => {
      if (r.ok && r.body.ok) {
        toast.success(
          r.body.iress_order_number
            ? `Order ${r.body.iress_order_number} sent to ${destination}`
            : `Order recorded (audit-only, worker not configured)`,
          {
            description: `${side} ${qty.toLocaleString()} ${symbol.toUpperCase()} @ ${limit === "" ? "MKT" : `R${limit}`}`,
          },
        );
        setOpen(false);
        onCreated();
        return;
      }
      // Blocked preflight (no audit row) OR worker post-insert reject.
      // Open the modal in either case — the trader can resubmit a
      // corrected qty/price, or close the dialog.
      if (r.body.preflight) {
        const pf = r.body.preflight;
        const code = r.body.worker_code ?? pf.code;
        if (code && GUARDRAIL_BLOCK_CODES.has(code)) {
          setModalPreflight(pf);
          setModalOrderTag(`ord-${crypto.randomUUID().slice(0, 8)}`);
          setModalOpen(true);
          return;
        }
      }
      // Transport / generic failure — fall back to a toast so the trader
      // isn't left staring at a silent dialog.
      toast.error("Order rejected", {
        description: r.body.error ?? r.body.preflight?.message ?? "unknown error",
      });
    },
    onError: (e: Error) => toast.error("Order rejected", { description: e.message }),
  });

  // Modal-driven resubmit. Re-runs /api/orders/submit with the corrected
  // inputs from the modal's editable form.
  const resubmitFromModal = async (next: {
    qty: number;
    price_cents?: number | null;
  }): Promise<SubmitResult> => {
    const r = await callBff("/api/orders/submit", {
      account_code: account,
      symbol: symbol.toUpperCase(),
      side: side === "BUY" ? "buy" : "sell",
      qty: next.qty,
      price_cents: next.price_cents,
      source: "BLOTTER_NEW_ORDER",
    });
    if (r.ok && r.body.ok) {
      toast.success(
        r.body.iress_order_number
          ? `Order ${r.body.iress_order_number} sent to ${destination}`
          : `Order recorded (audit-only, worker not configured)`,
        {
          description: `${side} ${next.qty.toLocaleString()} ${symbol.toUpperCase()} @ ${next.price_cents != null ? `R${(next.price_cents / 100).toFixed(2)}` : "MKT"}`,
        },
      );
      setOpen(false);
      onCreated();
      return r.body;
    }
    // Keep the modal open with the latest preflight / chain error.
    if (r.body.preflight) {
      setModalPreflight(r.body.preflight);
    }
    return r.body;
  };

  const attempted = React.useMemo(() => {
    const pxCents = limit === "" ? null : Math.round(Number(limit) * 100);
    return {
      symbol: symbol.toUpperCase(),
      side: side === "BUY" ? ("buy" as const) : ("sell" as const),
      qty,
      price_cents: pxCents,
    };
  }, [symbol, side, qty, limit]);

  const sendBtn = (
    <Button
      onClick={() => create.mutate()}
      disabled={create.isPending || !symbol || !qty || blocked}
      aria-label={`Send order to ${destination}`}
      aria-describedby={blocked ? "new-order-block-reason" : undefined}
      className="gap-1.5"
    >
      {create.isPending ? "Sending…" : "Send to " + destination}
    </Button>
  );

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" className="h-7 text-xs gap-1.5">
          <Plus className="h-3 w-3" /> New order
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New order</DialogTitle>
          <DialogDescription>Create a new order</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <Field id="new-order-symbol" label="Symbol">
            <Input
              id="new-order-symbol"
              value={symbol}
              onChange={(e) => setSymbol(e.target.value.toUpperCase())}
              className="h-8 font-mono"
            />
          </Field>
          <Field id="new-order-side" label="Side">
            <Select value={side} onValueChange={(v) => setSide(v as "BUY" | "SELL")}>
              <SelectTrigger id="new-order-side" aria-label="Side" className="h-8">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="BUY">BUY</SelectItem>
                <SelectItem value="SELL">SELL</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field id="new-order-qty" label="Quantity">
            <Input
              id="new-order-qty"
              type="number"
              value={qty}
              onChange={(e) => setQty(Number(e.target.value))}
              className="h-8 font-mono"
            />
          </Field>
          <Field id="new-order-limit" label="Limit price">
            <Input
              id="new-order-limit"
              type="number"
              value={limit}
              onChange={(e) => setLimit(e.target.value === "" ? "" : Number(e.target.value))}
              placeholder="MKT"
              className="h-8 font-mono"
            />
          </Field>
          <Field id="new-order-tif" label="Time in force">
            <Select value={tif} onValueChange={(v) => setTif(v as typeof tif)}>
              <SelectTrigger id="new-order-tif" aria-label="Time in force" className="h-8">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="DAY">DAY</SelectItem>
                <SelectItem value="IOC">IOC</SelectItem>
                <SelectItem value="FOK">FOK</SelectItem>
                <SelectItem value="GTC">GTC</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field id="new-order-destination" label="Destination">
            <Select value={destination} onValueChange={setDestination}>
              <SelectTrigger id="new-order-destination" aria-label="Destination venue" className="h-8">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="JSE">JSE</SelectItem>
                <SelectItem value="NASDAQ">NASDAQ</SelectItem>
                <SelectItem value="NYSE">NYSE</SelectItem>
                <SelectItem value="LSE">LSE</SelectItem>
                <SelectItem value="OTC">OTC (MM)</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field id="new-order-account" label="Account" className="col-span-2">
            <Input
              id="new-order-account"
              value={account}
              onChange={(e) => setAccount(e.target.value)}
              className="h-8 font-mono"
            />
          </Field>
        </div>

        {/* Pre-trade checks (Mission C2) */}
        <div id="new-order-block-reason" className="rounded-md border border-border/60 bg-surface-2/40 p-2.5">
          <div className="mb-1.5 flex items-center justify-between">
            <p className="text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground">
              Pre-trade checks
            </p>
            <span className="font-mono text-[9.5px] text-muted-foreground">IRESS · IOS+</span>
          </div>
          <div className="space-y-1">
            <PreTradeRow
              label="Halt / suspension"
              state={preTrade.halt === "ok" ? "ok" : "fail"}
              detail={
                preTrade.halt === "ok"
                  ? marketState
                  : preTrade.halt === "halt"
                    ? `HALT — ${symbol.toUpperCase()}`
                    : `SUSPENDED — ${symbol.toUpperCase()}`
              }
            />
            <PreTradeRow
              label="Buying power"
              state={preTrade.bp === "ok" ? "ok" : "fail"}
              detail={preTrade.bp === "ok" ? "OK" : "Exceeds account cash"}
            />
            <PreTradeRow
              label="Mandate / concentration"
              state={preTrade.mandate === "ok" ? "ok" : preTrade.mandate === "n/a" ? "na" : "fail"}
              detail={
                preTrade.mandate === "ok"
                  ? "OK"
                  : preTrade.mandate === "n/a"
                    ? "N/A"
                    : "Symbol outside mandate"
              }
              tip={preTrade.mandate === "n/a" ? "no strategy attached" : undefined}
            />
          </div>
        </div>

        {/* Estimated notional */}
        <p className="text-[11px] text-muted-foreground">
          Estimated notional:{" "}
          <span className="font-mono font-semibold text-foreground">{formatZARExact(preTrade.notional)}</span>
        </p>

        {/* Idempotency key — visible to the trader so a re-submit is provably a no-op */}
        <details className="rounded-md border border-border/60 bg-surface-2/20 px-2.5 py-1.5 text-[10.5px]">
          <summary className="cursor-pointer select-none font-semibold uppercase tracking-wider text-muted-foreground">
            Details
          </summary>
          <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 font-mono">
            <dt className="text-muted-foreground">OrderTag</dt>
            <dd className="break-all">{orderTag || modalOrderTag || "—"}</dd>
            <dt className="text-muted-foreground">Account</dt>
            <dd>{account}</dd>
            <dt className="text-muted-foreground">Cash source</dt>
            <dd>
              {accountCash.source === "supabase"
                ? "IPS portfolio"
                : accountCash.source === "mock-fallback"
                  ? "mock fixture (demo)"
                  : "unknown (no IPS row)"}
            </dd>
            <dt className="text-muted-foreground">Symbol</dt>
            <dd>{symbol.toUpperCase()}</dd>
            <dt className="text-muted-foreground">Market state</dt>
            <dd>{marketState}</dd>
          </dl>
        </details>

        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          {blocked && preTrade.reason ? (
            <TooltipProvider delayDuration={150}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span tabIndex={0}>{sendBtn}</span>
                </TooltipTrigger>
                <TooltipContent className="max-w-[280px]">
                  <p className="font-semibold">Pre-trade check failed</p>
                  <p className="mt-0.5 text-muted-foreground">{preTrade.reason}</p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          ) : (
            sendBtn
          )}
        </DialogFooter>

        {modalPreflight && (
          <GuardrailForceCorrectionDialog
            open={modalOpen}
            onOpenChange={(o) => {
              setModalOpen(o);
              if (!o) setModalPreflight(null);
            }}
            preflight={modalPreflight}
            mode="single"
            attempted={attempted}
            onResubmit={resubmitFromModal}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function Field({
  id,
  label,
  children,
  className,
}: { id: string; label: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("space-y-1", className)}>
      <Label
        htmlFor={id}
        className="text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground"
      >
        {label}
      </Label>
      {children}
    </div>
  );
}

function PreTradeRow({
  label,
  state,
  detail,
  tip,
}: {
  label: string;
  state: "ok" | "fail" | "na";
  detail: string;
  tip?: string;
}) {
  const icon =
    state === "ok" ? (
      <Check className="h-3 w-3" />
    ) : state === "fail" ? (
      <X className="h-3 w-3" />
    ) : (
      <Info className="h-3 w-3" />
    );
  const color =
    state === "ok" ? "text-success" : state === "fail" ? "text-destructive" : "text-muted-foreground";
  const row = (
    <div className="flex items-center justify-between gap-2 text-[11px]">
      <span className="flex items-center gap-1.5 text-muted-foreground">
        {state === "fail" && <AlertTriangle className="h-3 w-3 text-warning" />}
        {label}
      </span>
      <span className={cn("flex items-center gap-1 font-mono", color)}>
        {icon}
        {detail}
      </span>
    </div>
  );
  if (tip) {
    return (
      <TooltipProvider delayDuration={150}>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="block">{row}</span>
          </TooltipTrigger>
          <TooltipContent>{tip}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }
  return row;
}
