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
 *          | State | LIVE? (UAT only).
 *
 * Slip / Day-1 P&L = limit − actual fill (in cents). GREEN when fill < client
 * limit (positive slippage for a buy). Updates automatically as quotes tick.
 *
 * Phase UAT: when `uatMode=true` (Vercel + worker both), subscribes to
 * `/api/admin/orderbook/stream` for live fill deltas. Updates the matching
 * audit row in place and shows a pulsing "LIVE" badge for orders tracked
 * via SSE. Stops polling while the tab is hidden.
 */

import { Loader2, Radio } from "lucide-react";
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

interface UatStatus {
  ok: boolean;
  uat_mode: boolean;
  worker_configured: boolean;
  worker_uat_mode: boolean | null;
}

interface UatDelta {
  order_audit_id: string | null;
  iress_order_number: string;
  state: string;
  filled: number;
  avg_fill_price_cents: number | null;
  symbol: string;
  side: string;
  qty: number;
  book_id: string | null;
  timestamp: string;
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

function stateUppercaseToDb(state: string): ExecutionRow["state"] {
  const u = state.toUpperCase();
  if (u === "WORKING" || u === "PARTIAL" || u === "FILLED" || u === "CANCELLED" || u === "REJECTED") {
    return u;
  }
  return "WORKING";
}

function timeSince(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  const delta = Date.now() - t;
  if (delta < 0) return "just now";
  if (delta < 60_000) return `${Math.floor(delta / 1000)}s ago`;
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  return `${Math.floor(delta / 3_600_000)}h ago`;
}

/**
 * Tiny SSE client that re-opens the stream on `retry:` or on error.
 * Returns the last delta timestamp so the UI can show "live updates paused".
 */
function useUatStream(
  uatEnabled: boolean,
  onDelta: (d: UatDelta) => void,
): {
  connected: boolean;
  lastEventAt: string | null;
} {
  const [connected, setConnected] = React.useState(false);
  const [lastEventAt, setLastEventAt] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!uatEnabled) return undefined;
    if (typeof EventSource === "undefined") return undefined;
    let es: EventSource | null = null;
    let closed = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    const open = (): void => {
      if (closed) return;
      es = new EventSource("/api/admin/orderbook/stream", { withCredentials: false });
      es.addEventListener("status", () => {
        setConnected(true);
      });
      es.addEventListener("delta", (evt) => {
        setConnected(true);
        setLastEventAt(new Date().toISOString());
        try {
          const data = JSON.parse((evt as MessageEvent).data) as UatDelta;
          onDelta(data);
        } catch {
          /* ignore malformed */
        }
      });
      es.onerror = () => {
        setConnected(false);
        if (es) {
          es.close();
          es = null;
        }
        if (!closed) {
          // SSE auto-reconnects on transient errors, but if the connection
          // is fully torn down (worker down, route 503) we re-open on a
          // backoff so a misbehaving worker can't loop the BFF.
          reconnectTimer = setTimeout(open, 5_000);
        }
      };
    };
    open();
    return () => {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (es) es.close();
    };
  }, [uatEnabled, onDelta]);

  return { connected, lastEventAt };
}

export function ExecutionView({ bookId }: { bookId: string }) {
  // Pull execution rows. Refresh whenever the book id changes.
  const executions = usePolling<ExecutionPayload>(
    `/api/admin/orderbook/execution?book_id=${encodeURIComponent(bookId)}`,
    { interval: 30_000, deps: [bookId] },
  );

  // Local override layer so SSE deltas update instantly without waiting for
  // the 30s poll. Keyed by audit row id.
  const [liveOverrides, setLiveOverrides] = React.useState<Record<string, ExecutionRow>>({});
  const [lastEventAt, setLastEventAt] = React.useState<string | null>(null);
  const [uatEnabled, setUatEnabled] = React.useState(false);

  // Probe UAT mode once on mount. When UAT is off we skip the SSE
  // subscription entirely (avoids 503 noise in production).
  React.useEffect(() => {
    let cancelled = false;
    fetch("/api/admin/orderbook/uat-status", { cache: "no-store" })
      .then((r) => r.json() as Promise<UatStatus>)
      .then((body) => {
        if (!cancelled) {
          setUatEnabled(body.ok && body.uat_mode && body.worker_configured && body.worker_uat_mode === true);
        }
      })
      .catch(() => {
        if (!cancelled) setUatEnabled(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const applyDelta = React.useCallback((d: UatDelta) => {
    setLastEventAt(new Date().toISOString());
    if (!d.order_audit_id) return;
    setLiveOverrides((prev) => {
      const existing = prev[d.order_audit_id as string];
      const qty = d.qty > 0 ? d.qty : (existing?.qty ?? 0);
      const filled = d.filled;
      const filledPct = qty > 0 ? Math.min(100, (filled / qty) * 100) : 0;
      const avgFill =
        d.avg_fill_price_cents != null ? d.avg_fill_price_cents / 100 : (existing?.avg_fill_price ?? null);
      const auditId = d.order_audit_id as string;
      const newRow: ExecutionRow = {
        id: auditId,
        order_id: d.iress_order_number || existing?.order_id || auditId,
        ts: d.timestamp,
        strategy: existing?.strategy ?? d.book_id ?? null,
        side: (d.side ?? existing?.side ?? "BUY").toUpperCase(),
        symbol: d.symbol || existing?.symbol || "—",
        isin: existing?.isin ?? null,
        qty,
        filled,
        filled_pct: Number(filledPct.toFixed(1)),
        limit_price: existing?.limit_price ?? null,
        avg_fill_price: avgFill,
        vwap: avgFill ?? existing?.vwap ?? null,
        slippage_cents:
          existing?.limit_price != null && avgFill != null
            ? Math.round((existing.limit_price - avgFill) * 100)
            : null,
        day1_pnl_cents:
          existing?.limit_price != null && avgFill != null
            ? Math.round((existing.limit_price - avgFill) * 100) * filled
            : null,
        venue: existing?.venue ?? "JSE",
        tif: existing?.tif ?? "DAY",
        sent_by: existing?.sent_by ?? null,
        state: stateUppercaseToDb(d.state),
        broker: existing?.broker ?? "LONGMARK CARE",
      };
      return { ...prev, [d.order_audit_id as string]: newRow };
    });
  }, []);

  const stream = useUatStream(uatEnabled, applyDelta);

  // Merge polled rows with live overrides. Live overrides win on the
  // matching id so the UI reflects SSE updates without waiting for the
  // next poll cycle.
  const polledRows = executions.data?.rows ?? [];
  const rows = React.useMemo(() => {
    if (Object.keys(liveOverrides).length === 0) return polledRows;
    const merged = polledRows.map((r) => liveOverrides[r.id] ?? r);
    // Add any live-only rows the poll hasn't surfaced yet.
    const polledIds = new Set(polledRows.map((r) => r.id));
    const extra = Object.values(liveOverrides).filter((r) => !polledIds.has(r.id));
    return [...extra, ...merged];
  }, [polledRows, liveOverrides]);

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

  // Track which audit rows have ever received an SSE delta so we can show
  // a "LIVE" badge next to them.
  const liveIds = React.useMemo(() => new Set(Object.keys(liveOverrides)), [liveOverrides]);

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
          {uatEnabled ? (
            <span
              className={cn(
                "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider",
                stream.connected ? "bg-success/15 text-success" : "bg-muted text-muted-foreground",
              )}
              title={
                stream.connected
                  ? `Live fill deltas via SSE. Last event ${lastEventAt ? timeSince(lastEventAt) : "—"}`
                  : "SSE disconnected — fill deltas paused. The 30s poll still updates fills."
              }
            >
              <Radio className={cn("h-3 w-3", stream.connected && "animate-pulse")} />
              {stream.connected ? "LIVE" : "OFFLINE"}
            </span>
          ) : null}
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
                "Tracking",
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
                <td colSpan={16} className="px-3 py-10 text-center text-[12px] text-muted-foreground">
                  Loading executions…
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={16} className="px-3 py-10 text-center text-[12px] text-muted-foreground">
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
                const tracked = liveIds.has(r.id);
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
                    <td className="px-3 py-1.5 whitespace-nowrap">
                      {tracked ? (
                        <span
                          className="inline-flex items-center gap-1 rounded-full bg-success/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-success"
                          title={`Last fill ${r.ts ? timeSince(r.ts) : "—"}`}
                        >
                          <Radio className="h-2.5 w-2.5 animate-pulse" />
                          live
                        </span>
                      ) : (
                        <span className="text-[10px] uppercase tracking-wider text-muted-foreground">—</span>
                      )}
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
