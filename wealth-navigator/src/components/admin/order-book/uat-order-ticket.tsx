"use client";
import * as React from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DataSourceBadge } from "@/components/oems/primitives/data-source-badge";
import { GuardrailForceCorrectionDialog } from "@/components/oems/primitives/guardrail-force-correction-dialog";
import type { PreflightResult, SubmitResult } from "@/lib/orders";
import { cn } from "@/lib/cn";

/**
 * Shared manual/UAT order ticket. In UAT mode it posts only to the guarded
 * UAT_ADHOC_ORDER lane, where orders are parked and locally self-filled.
 *
 * 2026-07-20 refactor: the route now runs a preflight BEFORE writing the
 * audit row, so a blocked verdict (naked-short, insufficient cash) never
 * creates a phantom `working` row. On a 422 response we open the shared
 * `<GuardrailForceCorrectionDialog/>` primitive so the trader stays on
 * the entry screen and can correct qty/price + resubmit without leaving
 * the page. Toast errors are reserved for transport failures (worker
 * offline, network, 500) where the modal isn't appropriate.
 */

interface SecurityOpt {
  symbol: string;
  name: string;
  lastRands: number | null;
}
interface ClientOpt {
  user_id: string;
  name: string;
  email: string | null;
  mint_number: string | null;
  is_test: boolean;
  available_cash_rands: number | null;
  holds_qty: number | null;
}
interface PlaceResult {
  ok: boolean;
  mode?: string;
  iressOrderNumber?: string | null;
  status?: string;
  error?: string;
  notice?: string;
  orderId?: string;
  code?: string;
  preflight?: PreflightResult;
}

const R = (n: number) => new Intl.NumberFormat("en-ZA", { style: "currency", currency: "ZAR", minimumFractionDigits: 2 }).format(n || 0);

const GUARDRAIL_BLOCK_CODES = new Set([
  "naked_short_blocked",
  "insufficient_cash",
  "sell_guard_unavailable",
  "buy_guard_unavailable",
  "limit_guard_violation",
  "limit_guard_unverified_sell",
]);

export function UatOrderTicket({
  onPlaced,
  mode = "manual",
}: {
  onPlaced?: () => void;
  mode?: "manual" | "uat";
}) {
  const [securities, setSecurities] = React.useState<SecurityOpt[]>([]);
  const [clients, setClients] = React.useState<ClientOpt[]>([]);
  const [clientId, setClientId] = React.useState("");
  const [side, setSide] = React.useState<"buy" | "sell">("buy");
  const [symbol, setSymbol] = React.useState("");
  const [qty, setQty] = React.useState("");
  const [price, setPrice] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [result, setResult] = React.useState<PlaceResult | null>(null);
  const [modalOpen, setModalOpen] = React.useState(false);
  const [modalPreflight, setModalPreflight] = React.useState<PreflightResult | null>(null);

  React.useEffect(() => {
    let alive = true;
    void fetch("/api/equities")
      .then((r) => (r.ok ? r.json() : { securities: [] }))
      .then((d: { securities?: Array<{ symbol?: string; name?: string; last_price?: number | null }> }) => {
        if (!alive) return;
        const opts = (d.securities ?? [])
          .filter((s) => s.symbol)
          .map((s) => ({
            symbol: String(s.symbol),
            name: s.name ?? "",
            lastRands: s.last_price != null ? Number(s.last_price) / 100 : null,
          }));
        setSecurities(opts);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  /* Client list, re-fetched when the ticker changes so `holds_qty` reflects the
     security actually being traded. That is what makes a SELL ticket honest:
     the dealer sees "holds 0" before typing a quantity rather than after a 422
     at release time. */
  React.useEffect(() => {
    let alive = true;
    const qs = symbol.trim() ? `?symbol=${encodeURIComponent(symbol.trim().toUpperCase())}` : "";
    void fetch(`/api/admin/orderbook/clients${qs}`)
      .then((r) => (r.ok ? r.json() : { clients: [] }))
      .then((d: { clients?: ClientOpt[] }) => {
        if (!alive) return;
        setClients(mode === "uat" ? (d.clients ?? []).filter((client) => client.is_test) : (d.clients ?? []));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [mode, symbol]);

  const matched = React.useMemo(() => {
    const u = symbol.trim().toUpperCase();
    return securities.find((s) => s.symbol.toUpperCase() === u) ?? null;
  }, [symbol, securities]);

  const client = React.useMemo(
    () => clients.find((c) => c.user_id === clientId) ?? null,
    [clients, clientId],
  );

  const qtyN = Number(qty);
  const priceN = Number(price);
  const value = Number.isFinite(qtyN) && qtyN > 0 && Number.isFinite(priceN) && priceN > 0 ? qtyN * priceN : null;
  // A client is REQUIRED. The order is placed on their behalf and checked
  // against their wallet and holdings; there is no sensible desk default.
  const canSubmit =
    clientId.length > 0 && symbol.trim().length > 0 && Number.isFinite(qtyN) && qtyN > 0 && !busy;

  /* Advisory affordability, shown live on the ticket. The BINDING check is the
     worker's pre-trade guard at Send-to-Market against live balances — this is
     the same arithmetic surfaced early so the dealer is not surprised. */
  const overCash =
    side === "buy" &&
    client?.available_cash_rands != null &&
    value != null &&
    value > client.available_cash_rands;
  const overHolding =
    side === "sell" &&
    client?.holds_qty != null &&
    Number.isFinite(qtyN) &&
    qtyN > client.holds_qty;

  const postPlace = async (body: Record<string, unknown>): Promise<PlaceResult> => {
    const r = await fetch(mode === "uat" ? "/api/admin/orderbook/uat-order" : "/api/admin/orderbook/manual-order", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return (await r.json()) as PlaceResult;
  };

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setResult(null);
    try {
      const d = await postPlace({
        user_id: clientId,
        symbol: symbol.trim().toUpperCase(),
        side,
        qty: Math.floor(qtyN),
        price: priceN > 0 ? priceN : null,
      });
      setResult(d);
      if (d.ok) {
        toast.success(
          mode === "uat"
            ? `UAT order parked for self-fill (${d.status ?? "parked"}).`
            : "Order recorded (audit-only, worker not configured)",
        );
        onPlaced?.();
      } else if (d.code && GUARDRAIL_BLOCK_CODES.has(d.code) && d.preflight) {
        // Open the shared force-correction modal — trader stays on the
        // entry screen, can correct qty/price and resubmit.
        setModalPreflight(d.preflight);
        setModalOpen(true);
      } else {
        toast.error(`Order rejected: ${d.error ?? "unknown error"}`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : "request failed";
      setResult({ ok: false, error: msg });
      toast.error(`Failed to place order: ${msg}`);
    } finally {
      setBusy(false);
    }
  };

  /**
   * Resubmit handler wired to the modal's "Resubmit order" button.
   * Converts the modal's Rands/qty back into the route contract and
   * re-runs `postPlace`. On chained failure, we update the modal's
   * preflight payload via `setModalPreflight` (the modal's internal
   * `chainError` already handles the inline message).
   */
  const resubmitFromModal = async (next: {
    qty: number;
    price_cents?: number | null;
  }): Promise<SubmitResult> => {
    const d = await postPlace({
      user_id: clientId,
      symbol: symbol.trim().toUpperCase(),
      side,
      qty: next.qty,
      price: next.price_cents != null ? next.price_cents / 100 : null,
    });
    // Mirror the PlaceResult shape into SubmitResult so the modal's
    // success / chain-error logic works. `preflight` is always present
    // on a 422, and on a worker post-insert reject it's `null`/empty.
    if (d.ok) {
      setResult(d);
      toast.success(
        mode === "uat"
          ? `UAT order parked for self-fill (${d.status ?? "parked"}).`
          : "Order recorded (audit-only, worker not configured)",
      );
      onPlaced?.();
      return {
        ok: true,
        order_audit_id: d.orderId,
        status: d.status,
        preflight: d.preflight ?? { ok: true, verdict: "pass", code: "pass", message: "ok" },
      };
    }
    if (d.code && GUARDRAIL_BLOCK_CODES.has(d.code) && d.preflight) {
      // Update the modal's preflight so the next chained attempt renders
      // the new verdict + summary.
      setModalPreflight(d.preflight);
    }
    setResult(d);
    return {
      ok: false,
      order_audit_id: d.orderId,
      preflight:
        d.preflight ?? {
          ok: false,
          verdict: "blocked_unverifiable",
          code: "sell_guard_unavailable",
          message: d.error ?? "Order rejected",
        },
      error: d.error,
      worker_code: d.code,
    };
  };

  const attempted = React.useMemo(() => {
    const priceCents =
      Number.isFinite(priceN) && priceN > 0 ? Math.round(priceN * 100) : null;
    return {
      symbol: symbol.trim().toUpperCase() || "—",
      side,
      qty: Number.isFinite(qtyN) && qtyN > 0 ? Math.floor(qtyN) : 0,
      price_cents: priceCents,
    };
  }, [symbol, side, qtyN, priceN]);

  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold">{mode === "uat" ? "UAT self-fill order" : "Manual client order"}</h3>
        <span className="text-[10px] text-muted-foreground">
          {mode === "uat"
            ? "Test clients only · permanently blocked from IRESS and LONGMARK"
            : "Parks only · nothing reaches the broker until Send to Market"}
        </span>
      </div>

      {/* Client — REQUIRED. The broker never sees this; LONGMARK holds no client
          accounts, only the MINT account. The attribution stays in our audit row
          so the pre-trade guard can check THIS client's cash and holdings. */}
      <div className="mb-3">
        <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Client
        </label>
        <select
          value={clientId}
          onChange={(e) => setClientId(e.target.value)}
          className="h-8 w-full rounded-md border border-border bg-background px-2 text-xs"
        >
          <option value="">{mode === "uat" ? "Select a test client…" : "Select a client…"}</option>
          {clients.map((c) => (
            <option key={c.user_id} value={c.user_id}>
              {c.name}
              {c.mint_number ? ` · ${c.mint_number}` : ""}
              {c.available_cash_rands != null ? ` · ${R(c.available_cash_rands)} available` : ""}
              {c.is_test ? " · TEST" : ""}
            </option>
          ))}
        </select>
        {client && (
          <span className="mt-1 block text-[10px] text-muted-foreground">
            {client.available_cash_rands != null
              ? `Available cash ${R(client.available_cash_rands)}`
              : "No wallet row — cash cannot be verified"}
            {client.holds_qty != null && symbol.trim() && (
              <> · holds {client.holds_qty.toLocaleString("en-ZA")} {symbol.trim().toUpperCase()}</>
            )}
          </span>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        {/* Side */}
        <div className="col-span-2 sm:col-span-1">
          <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Side</label>
          <div className="inline-flex w-full overflow-hidden rounded-md border border-border p-0.5">
            {(["buy", "sell"] as const).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setSide(s)}
                className={cn(
                  "flex-1 rounded px-2 py-1 text-xs font-semibold uppercase transition-colors",
                  side === s
                    ? s === "buy"
                      ? "bg-success/20 text-success"
                      : "bg-destructive/20 text-destructive"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {s}
              </button>
            ))}
          </div>
        </div>

        {/* Ticker */}
        <div className="col-span-2 sm:col-span-2">
          <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Ticker</label>
          <Input
            list="uat-ticker-list"
            value={symbol}
            onChange={(e) => setSymbol(e.target.value)}
            placeholder="e.g. NPN.JO"
            className="h-8"
          />
          <datalist id="uat-ticker-list">
            {securities.slice(0, 500).map((s) => (
              <option key={s.symbol} value={s.symbol}>
                {s.name}
              </option>
            ))}
          </datalist>
          {matched && (
            <span className="mt-0.5 block text-[10px] text-muted-foreground">
              {matched.name}
              {matched.lastRands != null && (
                <>
                  {" · last "}
                  <button
                    type="button"
                    className="underline underline-offset-2 hover:text-foreground"
                    onClick={() => setPrice(String(matched.lastRands))}
                  >
                    {R(matched.lastRands)}
                  </button>
                  <DataSourceBadge source="hybrid" db="retail" className="ml-1 align-middle" />
                </>
              )}
            </span>
          )}
        </div>

        {/* Qty */}
        <div>
          <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Quantity</label>
          <Input type="number" min={1} step={1} value={qty} onChange={(e) => setQty(e.target.value)} placeholder="0" className="h-8" />
        </div>

        {/* Price */}
        <div>
          <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Price (R) <span className="normal-case text-muted-foreground/60">(blank = market)</span>
          </label>
          <Input type="number" min={0} step="0.01" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="market" className="h-8" />
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <div className="text-xs text-muted-foreground">
          Order value:{" "}
          <span className="font-mono font-semibold text-foreground">{value != null ? R(value) : "—"}</span>
          {price.trim() === "" && <span className="ml-2 text-[10px]">(market order, value settles at fill)</span>}
        </div>
        <Button size="sm" onClick={submit} disabled={!canSubmit}>
          {busy ? "Parking…" : mode === "uat" ? `Create UAT ${side.toUpperCase()}` : `Park ${side.toUpperCase()} order`}
        </Button>
      </div>

      {/* Advisory only — the binding check runs at Send to Market against live
          balances. Shown as a warning rather than a hard block so the dealer can
          still park an order they intend to fund; the guard will refuse the
          release if the money still isn't there. */}
      {(overCash || overHolding) && (
        <div className="mt-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-[11px] text-warning-foreground">
          {overCash && client?.available_cash_rands != null && (
            <>
              This order is {R((value ?? 0) - client.available_cash_rands)} more than{" "}
              {client.name} has available ({R(client.available_cash_rands)}).
              {mode === "uat" ? " It remains a local UAT simulation." : " It will park, but Send to Market will refuse it unless the wallet is funded first."}
            </>
          )}
          {overHolding && client?.holds_qty != null && (
            <>
              {client.name} holds {client.holds_qty.toLocaleString("en-ZA")}{" "}
              {symbol.trim().toUpperCase()} — selling {Math.floor(qtyN).toLocaleString("en-ZA")}{" "}
              would be a short. {mode === "uat" ? "This remains a local UAT simulation." : "Send to Market will refuse it."}
            </>
          )}
        </div>
      )}

      {result && !modalOpen && (
        <div
          className={cn(
            "mt-3 rounded-lg border px-3 py-2 text-xs",
            result.ok ? "border-success/40 bg-success/10 text-foreground" : "border-destructive/40 bg-destructive/10 text-foreground",
          )}
        >
          {result.ok ? (
            <span>
              {mode === "uat" ? (
                <>
                  UAT order <span className="font-mono font-semibold">{result.orderId ?? ""}</span> is{" "}
                  <span className="font-semibold">{result.status ?? "parked"}</span>. Use Fill (UAT) in the table below.
                </>
              ) : (
                <>Recorded (audit-only): {result.notice ?? "worker not configured"}.</>
              )}
            </span>
          ) : (
            <span>Rejected: {result.error ?? "unknown error"}</span>
          )}
        </div>
      )}

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
    </div>
  );
}
