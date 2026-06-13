"use client";

// New order dialog with pre-trade compliance checks (Mission C2 / P0).
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

import { useEffect, useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Plus, X, Check, AlertTriangle, Info } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useIress } from "@/lib/iress/provider";
import { formatZARExact } from "@/lib/format";
import { useTick } from "@/lib/store/tick-stream-provider";
import { preTradeCheck, getMarketState, type PreTradeResult } from "@/lib/iress/strategy";
import { orderCreate3WithRecovery } from "@/lib/iress/order-recovery";
import { useAccountCash } from "@/lib/hooks/use-account-cash";
import { cn } from "@/lib/cn";

export function NewOrderDialog({ onCreated }: { onCreated: () => void }) {
  const { client } = useIress();
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

  const create = useMutation({
    mutationFn: async () => {
      // Place the order through the recovery helper — on a transient
      // transport fault (HTTP 500, timeout, TCP RST) it re-queries IRESS
      // via `OrderNoGetByOrderTag` to learn whether the broker already
      // accepted the tag. This is the documented V4 idempotency path.
      const result = await orderCreate3WithRecovery({
        client,
        request: {
          ServiceSessionKey: "MOCK-S",
          OrderTag: orderTag,
          Order: {
            AccountCode: account,
            SecurityCode: symbol.toUpperCase(),
            Exchange: destination === "OTC" ? "JSE" : destination,
            BuySell: side === "BUY" ? 1 : 2,
            OrderType: limit === "" ? "MKT" : "LMT",
            Volume: qty,
            Price: limit === "" ? undefined : Number(limit),
            Destination: destination,
            TimeInForce: tif,
          },
        },
      });
      return result;
    },
    onSuccess: (r) => {
      const recoveredNote = r.recovered
        ? r.brokerAcceptedOnRecovery
          ? " · recovered via OrderNoGetByOrderTag"
          : " · recovery path used"
        : "";
      toast.success(`Order ${r.response.OrderNumber} sent to ${destination}${recoveredNote}`, {
        description: `${side} ${qty.toLocaleString()} ${symbol.toUpperCase()} @ ${limit === "" ? "MKT" : `R${limit}`}`,
      });
      setOpen(false);
      onCreated();
    },
    onError: (e: Error) => toast.error("Order rejected", { description: e.message }),
  });

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
        <Button size="sm" className="h-7 text-xs gap-1.5"><Plus className="h-3 w-3" /> New order</Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New order</DialogTitle>
          <DialogDescription>IRESS · OrderCreate3 · idempotent via OrderTag</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <Field id="new-order-symbol" label="Symbol">
            <Input id="new-order-symbol" value={symbol} onChange={(e) => setSymbol(e.target.value.toUpperCase())} className="h-8 font-mono" />
          </Field>
          <Field id="new-order-side" label="Side">
            <Select value={side} onValueChange={(v) => setSide(v as "BUY" | "SELL")}>
              <SelectTrigger id="new-order-side" aria-label="Side" className="h-8"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="BUY">BUY</SelectItem>
                <SelectItem value="SELL">SELL</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field id="new-order-qty" label="Quantity">
            <Input id="new-order-qty" type="number" value={qty} onChange={(e) => setQty(Number(e.target.value))} className="h-8 font-mono" />
          </Field>
          <Field id="new-order-limit" label="Limit price">
            <Input id="new-order-limit" type="number" value={limit} onChange={(e) => setLimit(e.target.value === "" ? "" : Number(e.target.value))} placeholder="MKT" className="h-8 font-mono" />
          </Field>
          <Field id="new-order-tif" label="Time in force">
            <Select value={tif} onValueChange={(v) => setTif(v as typeof tif)}>
              <SelectTrigger id="new-order-tif" aria-label="Time in force" className="h-8"><SelectValue /></SelectTrigger>
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
              <SelectTrigger id="new-order-destination" aria-label="Destination venue" className="h-8"><SelectValue /></SelectTrigger>
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
            <Input id="new-order-account" value={account} onChange={(e) => setAccount(e.target.value)} className="h-8 font-mono" />
          </Field>
        </div>

        {/* Pre-trade checks (Mission C2) */}
        <div
          id="new-order-block-reason"
          className="rounded-md border border-border/60 bg-surface-2/40 p-2.5"
        >
          <div className="mb-1.5 flex items-center justify-between">
            <p className="text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground">Pre-trade checks</p>
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
          Estimated notional: <span className="font-mono font-semibold text-foreground">{formatZARExact(preTrade.notional)}</span>
        </p>

        {/* Idempotency key — visible to the trader so a re-submit is provably a no-op */}
        <details className="rounded-md border border-border/60 bg-surface-2/20 px-2.5 py-1.5 text-[10.5px]">
          <summary className="cursor-pointer select-none font-semibold uppercase tracking-wider text-muted-foreground">Details</summary>
          <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 font-mono">
            <dt className="text-muted-foreground">OrderTag</dt>
            <dd className="break-all">{orderTag || "—"}</dd>
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
          <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
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
      </DialogContent>
    </Dialog>
  );
}

function Field({ id, label, children, className }: { id: string; label: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("space-y-1", className)}>
      <Label htmlFor={id} className="text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground">
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
    state === "ok" ? <Check className="h-3 w-3" /> :
    state === "fail" ? <X className="h-3 w-3" /> :
    <Info className="h-3 w-3" />;
  const color =
    state === "ok" ? "text-success" :
    state === "fail" ? "text-destructive" :
    "text-muted-foreground";
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
          <TooltipTrigger asChild><span className="block">{row}</span></TooltipTrigger>
          <TooltipContent>{tip}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }
  return row;
}
