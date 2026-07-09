"use client";

/**
 * ExecutionView — per-ISIN execution ledger for a single order book.
 *
 * Phase B3 (Mint OEM Finalisation). Renders one row per ISIN under the book
 * (NOT per holding line) and polls `/api/quotes` every 30s so the live
 * `last` ticks against the static limit so the desk can spot slippage the
 * moment the market moves.
 *
 * Columns: Order ID | Timestamp | Strategy | Side | Symbol | Qty | % Filled
 *          | Limit | Last | VWAP | Slip / Day-1 P&L | Venue | TIF | Sent by
 *          | State.
 *
 * Slip / Day-1 P&L = limit − actual fill (in cents). GREEN when fill < client
 * limit (positive slippage for a buy). Updates automatically as quotes tick.
 *
 * Stops polling while the tab is hidden (A8.3 carry-over — `usePolling`'s
 * `onlyWhenVisible` defaults to true).
 */

import { Loader2 } from "lucide-react";
import * as React from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { usePolling } from "@/lib/hooks/use-polling";

export interface ExecutionRow {
  id: string;
  order_id: string;
  ts: string;
  strategy: string | null;
  side: string;
  symbol: string;
  isin: string | null;
  qty: number;
  filled: number;
  filled_pct: number;
  limit_price: number | null;
  avg_fill_price: number | null;
  vwap: number | null;
  slippage_cents: number | null;
  day1_pnl_cents: number | null;
  venue: string;
  tif: string;
  sent_by: string | null;
  state: "WORKING" | "PARTIAL" | "FILLED" | "CANCELLED" | "REJECTED" | string;
  broker: string | null;
}

interface ExecutionPayload {
  ok: boolean;
  rows?: ExecutionRow[];
  count?: number;
  notice?: string;
}

interface QuotesPayload {
  quotes?: Array<{ symbol: string; last_price: number | null; source?: string }>;
}

const RANDS = new Intl.NumberFormat("en-ZA", {
  style: "currency",
  currency: "ZAR",
  minimumFractionDigits: 2,
});
const fmtMoney = (n: number | null | undefined): string =>
  n == null || !Number.isFinite(n) ? "—" : RANDS.format(n);
const fmtQty = (n: number | null | undefined): string =>
  n == null || !Number.isFinite(n) ? "—" : n.toLocaleString("en-ZA");
const fmtPct = (n: number | null | undefined): string =>
  n == null || !Number.isFinite(n) ? "—" : `${n.toFixed(1)}%`;

const STATE_VARIANT: Record<
  string,
  "default" | "secondary" | "destructive" | "success" | "warning" | "outline"
> = {
  WORKING: "warning",
  PARTIAL: "warning",
  FILLED: "success",
  CANCELLED: "secondary",
  REJECTED: "destructive",
};

function fmtTs(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return `${d.toLocaleDateString("en-ZA", { day: "2-digit", month: "short" })} ${d.toLocaleTimeString("en-ZA", { hour: "2-digit", minute: "2-digit" })}`;
}

function slipColor(slipCents: number | null): string {
  if (slipCents == null) return "text-muted-foreground";
  if (slipCents > 0) return "text-success"; // fill < client limit → GREEN
  if (slipCents < 0) return "text-destructive";
  return "text-muted-foreground";
}

export function ExecutionView({ bookId }: { bookId: string }) {
  // Pull execution rows. Refresh whenever the book id changes.
  const executions = usePolling<ExecutionPayload>(
    `/api/admin/orderbook/execution?book_id=${encodeURIComponent(bookId)}`,
    { interval: 30_000, deps: [bookId] },
  );

  const rows = executions.data?.rows ?? [];
  const symbols = React.useMemo(() => rows.map((r) => r.symbol).filter(Boolean), [rows]);

  // Live tick: poll `/api/quotes` for the symbols on screen every 30s. We
  // intentionally fire this ONLY when there's at least one symbol so a
  // closed book doesn't hit the BFF for nothing.
  const quotesUrl = symbols.length
    ? `/api/quotes?symbols=${encodeURIComponent(symbols.join(","))}&exchange=JSE`
    : null;
  const quotes = usePolling<QuotesPayload>(quotesUrl ?? "about:blank", {
    interval: 30_000,
    deps: [symbols.join(",")],
    query: { enabled: symbols.length > 0 },
  });

  const lastBySymbol = React.useMemo(() => {
    const m = new Map<string, number | null>();
    for (const q of quotes.data?.quotes ?? []) {
      if (q.symbol) m.set(q.symbol, q.last_price);
    }
    return m;
  }, [quotes.data]);

  const showLoading = executions.loading && rows.length === 0;
  const hasNotice = !!executions.data?.notice;

  return (
    <div className="rounded-xl border border-border bg-card/40">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2.5">
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Per-ISIN execution
          </span>
          <Badge variant="outline" className="font-mono">
            {executions.data?.count ?? rows.length}
          </Badge>
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground">book {bookId}</span>
        </div>
        <div className="flex items-center gap-2">
          {executions.loading && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
          {quotes.loading && (
            <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wider text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" />
              ticking…
            </span>
          )}
          <Button variant="ghost" size="sm" onClick={() => void executions.refresh()}>
            Refresh
          </Button>
        </div>
      </div>

      {hasNotice && (
        <div className="border-b border-warning/30 bg-warning/5 px-4 py-2 text-[11px] text-warning">
          {executions.data?.notice}
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full border-collapse">
          <thead>
            <tr className="border-b border-border bg-card/60 text-left">
              {[
                "Order ID",
                "Time",
                "Strategy",
                "Side",
                "Symbol",
                "Qty",
                "% Filled",
                "Limit",
                "Last",
                "VWAP",
                "Slip / Day-1 P&L",
                "Venue",
                "TIF",
                "Sent by",
                "State",
              ].map((h) => (
                <th
                  key={h}
                  className="px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground whitespace-nowrap"
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {showLoading ? (
              <tr>
                <td colSpan={15} className="px-3 py-10 text-center text-[12px] text-muted-foreground">
                  Loading executions…
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={15} className="px-3 py-10 text-center text-[12px] text-muted-foreground">
                  No execution rows for this book yet — click <em>Send to Market</em> to dispatch.
                </td>
              </tr>
            ) : (
              rows.map((r) => {
                const liveLast = lastBySymbol.get(r.symbol);
                const effectiveLast =
                  typeof liveLast === "number" && Number.isFinite(liveLast) ? liveLast : r.avg_fill_price;
                const liveSlipCents =
                  r.limit_price != null && typeof effectiveLast === "number" && Number.isFinite(effectiveLast)
                    ? Math.round((r.limit_price - effectiveLast) * 100)
                    : r.slippage_cents;
                const slipDisplay =
                  liveSlipCents == null
                    ? "—"
                    : `${liveSlipCents > 0 ? "+" : ""}${(liveSlipCents / 100).toFixed(2)}`;
                return (
                  <tr key={r.id} className="border-b border-border/40 hover:bg-accent/10">
                    <td className="px-3 py-1.5 font-mono text-[11px] text-foreground whitespace-nowrap">
                      {r.order_id}
                    </td>
                    <td className="px-3 py-1.5 text-[11px] text-muted-foreground whitespace-nowrap">
                      {fmtTs(r.ts)}
                    </td>
                    <td className="px-3 py-1.5 text-[11px] text-foreground whitespace-nowrap">
                      {r.strategy ?? "—"}
                    </td>
                    <td className="px-3 py-1.5 whitespace-nowrap">
                      <Badge variant={r.side === "SELL" ? "destructive" : "success"}>{r.side}</Badge>
                    </td>
                    <td className="px-3 py-1.5 text-[12px] font-semibold text-foreground whitespace-nowrap">
                      {r.symbol}
                    </td>
                    <td className="px-3 py-1.5 text-[12px] text-foreground whitespace-nowrap">
                      {fmtQty(r.qty)}
                    </td>
                    <td className="px-3 py-1.5 text-[12px] text-foreground whitespace-nowrap">
                      {fmtPct(r.filled_pct)}
                    </td>
                    <td className="px-3 py-1.5 text-[12px] text-foreground whitespace-nowrap">
                      {fmtMoney(r.limit_price)}
                    </td>
                    <td className="px-3 py-1.5 text-[12px] text-foreground whitespace-nowrap">
                      {typeof liveLast === "number" && Number.isFinite(liveLast) ? fmtMoney(liveLast) : "—"}
                    </td>
                    <td className="px-3 py-1.5 text-[12px] text-foreground whitespace-nowrap">
                      {fmtMoney(r.vwap)}
                    </td>
                    <td
                      className={cn(
                        "px-3 py-1.5 text-[12px] font-semibold whitespace-nowrap",
                        slipColor(liveSlipCents),
                      )}
                    >
                      {slipDisplay}
                    </td>
                    <td className="px-3 py-1.5 text-[11px] text-muted-foreground whitespace-nowrap">
                      {r.venue}
                    </td>
                    <td className="px-3 py-1.5 text-[11px] text-muted-foreground whitespace-nowrap">
                      {r.tif}
                    </td>
                    <td className="px-3 py-1.5 text-[11px] text-muted-foreground whitespace-nowrap">
                      {r.sent_by ?? "—"}
                    </td>
                    <td className="px-3 py-1.5 whitespace-nowrap">
                      <Badge variant={STATE_VARIANT[r.state] ?? "outline"}>{r.state}</Badge>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default ExecutionView;
