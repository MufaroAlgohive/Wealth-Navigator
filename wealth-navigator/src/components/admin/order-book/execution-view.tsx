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
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/cn";
import { usePolling } from "@/lib/hooks/use-polling";

export interface ExecutionRow {
  id: string;
  order_id: string;
  // 2026-07-13: OEMS client identifier (profile email or user_id). The Cancel
  // button uses broker_account (the IRESS AccountCode) when forwarding to
  // /api/admin/orderbook/cancel.
  client_account: string;
  broker_account: string | null;
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
  // 11-state lifecycle (2026-07-14): see src/types/iress.ts::OrderState. The
  // audit `status` column carries `pending_ack` / `acknowledged` in addition
  // to the older 5 values, plus the new intermediate `cancel_pending` /
  // `amend_pending` tokens that surface the desk's instruction BEFORE the
  // desk broker has acked it, plus the terminal `failed` state for
  // post-routing transport / venue failures (Andre, 2026-07-14). The BFF
  // /api/admin/orderbook/execution route upper-cases them for this typed
  // surface.
  state:
    | "PENDING_ACK"
    | "ACKNOWLEDGED"
    | "WORKING"
    | "PARTIAL"
    | "FILLED"
    | "CANCELLED"
    | "CANCEL_PENDING"
    | "AMEND_PENDING"
    | "EXPIRED"
    | "REJECTED"
    | "FAILED"
    | string;
  broker: string | null;
  // IRESS Hermes OrderState (2026-07-13). Surfaced via tooltip on the State
  // badge so the operator can read "Traded 200 @ 17700, then 200 @ 17900"
  // without leaving the UI. Older audit rows + BFF-written `working` rows
  // may not carry these — the UI falls back to the lifecycle state.
  // 2026-07-14: typed to OrderBrokerState ("ACTIVE" | "INACTIVE" | "UNKNOWN")
  // and surfaced as a green/grey chip next to the State column — operators
  // need to see "still on the book" vs "parked" at a glance.
  broker_state?: "ACTIVE" | "INACTIVE" | "UNKNOWN" | null;
  action_status?: string | null;
  internal_order_status?: string | null;
  state_description?: string | null;
  remaining_volume?: number | null;
  remaining_value_cents?: number | null;
  order_value_cents?: number | null;
  // 2026-07-13 — Transcript gap #1 (23:40): IRESS ErrorNumber +
  // ErrorDescription. The worker stamps these under
  // `result_payload.uatErrorNumber` / `result_payload.uatErrorDescription`
  // when OrderCreate3 returns a non-zero ErrorNumber. We render them as a
  // tiny destructive badge next to the state when present — the operator
  // can read the actual reason without opening Supabase.
  iress_error_number?: number | null;
  iress_error_description?: string | null;
  // 2026-07-13 — Transcript gap #2 (26:21): "last action" — Andre
  // specifically called this out as a key field for "real-time order
  // state understanding". Rendered as a separate column.
  last_action?: string | null;
  last_action_at?: string | null;
  // 2026-07-15: producer of the audit row (`OB_SEND_TO_MARKET_UAT` from
  // the BFF vs `iress-worker` from the worker poll). UI uses this in
  // the lifecycle timeline to surface which producer wrote each row.
  source?: string | null;
  // 2026-07-15: PricingInstructions the order was sent under — "limit"
  // or "market". Surfaces as a LMT/MKT chip in the Limit column so the
  // desk can see at a glance whether a price amend is applicable.
  // IRESS OrderAmend2 silently no-ops Price changes on MARKET orders
  // because PricingInstructions cannot be amended in-place (Andre + Juan,
  // 2026-07-15 transcript 09:19-09:42).
  order_type?: "limit" | "market" | null;
  // 2026-07-14: pre-trade limit guard contract from the BFF
  // /api/admin/orderbook/send-to-market. `limits_enforced=true` means
  // the dispatch passed the no-naked-short + cash-bust guard against
  // the desk's IRESS AccountCode. False/null means either the order
  // predates the guard or the BFF could not run the guard (no account
  // row, bad status, etc.) — render an honest "Not guarded" chip with
  // the skip reason on hover.
  limits_enforced?: boolean | null;
  limits_checked_at?: string | null;
  limits_account_code?: string | null;
  limits_skip_reason?: string | null;
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
  // 2026-07-13 — Transcript gap (26:21): one-liner for the Action
  // column so the UI updates without an extra DB read.
  last_action?: string | null;
  last_action_at?: string | null;
  // 2026-07-13 — Transcript gap (23:40): IRESS error fields so a
  // rejection surfaces its actual reason.
  iressErrorNumber?: number | null;
  iressErrorDescription?: string | null;
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
  // 11-state lifecycle (2026-07-14). pending_ack + acknowledged render as
  // outline (the broker is mid-handshake). cancel_pending / amend_pending
  // are the trader's instructions that have not yet been acknowledged by
  // the desk broker — render as outline (neutral, in-flight). Working +
  // partial as warning (live in market). Filled = success. Cancelled /
  // expired as secondary (terminal, neutral). Rejected + Failed as
  // destructive (terminal, negative). Andre + Juan, transcript gap
  // "active or inactive" indicator (2026-07-14, 27:27-27:53).
  PENDING_ACK: "outline",
  ACKNOWLEDGED: "outline",
  CANCEL_PENDING: "outline",
  AMEND_PENDING: "outline",
  WORKING: "warning",
  PARTIAL: "warning",
  FILLED: "success",
  CANCELLED: "secondary",
  EXPIRED: "secondary",
  REJECTED: "destructive",
  FAILED: "destructive",
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

/**
 * Translate an incoming lifecycle token (from SSE / audit BFF) to the typed
 * `state` enum. Accepts both the upper-case form ("PARTIAL") and the lower-
 * case audit-token form ("partial") for backwards compatibility with older
 * SSE producers. Unknown tokens pass through verbatim so the UI badge can
 * surface "what is this?" rather than silently collapsing to WORKING.
 */
function stateUppercaseToDb(state: string): ExecutionRow["state"] {
  const u = state.toUpperCase();
  const known = new Set([
    "PENDING_ACK",
    "ACKNOWLEDGED",
    "WORKING",
    "PARTIAL",
    "FILLED",
    "CANCELLED",
    "CANCEL_PENDING",
    "AMEND_PENDING",
    "EXPIRED",
    "REJECTED",
    "FAILED",
  ]);
  return known.has(u) ? (u as ExecutionRow["state"]) : (u as ExecutionRow["state"]);
}

/**
 * Build the State-badge tooltip. When the audit row carries Hermes lifecycle
 * detail (stateDescription, actionStatus, internalOrderStatus, …) we render
 * them so the operator can see exactly where the order is on Hermes without
 * tailing worker logs. Falls back to a one-liner when only the downmapped
 * lifecycle state is available.
 */
function stateTooltip(row: ExecutionRow): string {
  const lines: string[] = [];
  if (row.action_status) lines.push(`Hermes ActionStatus: ${row.action_status}`);
  if (row.internal_order_status) lines.push(`Hermes InternalOrderStatus: ${row.internal_order_status}`);
  if (row.broker_state) lines.push(`Hermes OrderState: ${row.broker_state}`);
  if (row.state_description) lines.push(`Hermes: ${row.state_description}`);
  if (
    row.remaining_volume != null &&
    row.qty > 0 &&
    row.remaining_volume > 0
  ) {
    lines.push(
      `Remaining: ${row.remaining_volume.toLocaleString("en-ZA")} of ${row.qty.toLocaleString("en-ZA")} shares`,
    );
  }
  if (lines.length === 0) {
    return "State from audit row (no Hermes detail captured yet)";
  }
  return lines.join("\n");
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
      // Hermes lifecycle detail from the SSE payload (added 2026-07-13). The
      // worker now publishes these on every UAT poll cycle alongside the
      // downmapped state so the operator can see "pending_ack" /
      // "acknowledged" / partial fills with their Hermes action status.
      // The BFF /uat/execution-stream SSE passthrough forwards the fields
      // verbatim; older deltas don't have them and the UI falls back to the
      // existing row.
      const rawDelta = d as unknown as {
        brokerState?: string | null;
        actionStatus?: string | null;
        internalOrderStatus?: string | null;
        stateDescription?: string | null;
        remainingVolume?: number | null;
        remainingValueCents?: number | null;
        orderValueCents?: number | null;
      };
      const auditId = d.order_audit_id as string;
      const newRow: ExecutionRow = {
        id: auditId,
        order_id: d.iress_order_number || existing?.order_id || auditId,
        client_account: existing?.client_account ?? "",
        broker_account: existing?.broker_account ?? null,
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
        broker: existing?.broker ?? "JSE",
        // 2026-07-14: fold the SSE `brokerState` down to the typed
        // OrderBrokerState union — same fold as the worker mapper +
        // BFF. Unknown values surface as null (the UI then renders no
        // chip, which is the correct "haven't observed yet" state).
        broker_state:
          rawDelta.brokerState === "ACTIVE" || rawDelta.brokerState === "INACTIVE"
            ? (rawDelta.brokerState as "ACTIVE" | "INACTIVE")
            : existing?.broker_state ?? null,
        action_status: rawDelta.actionStatus ?? existing?.action_status ?? null,
        internal_order_status:
          rawDelta.internalOrderStatus ?? existing?.internal_order_status ?? null,
        state_description: rawDelta.stateDescription ?? existing?.state_description ?? null,
        remaining_volume: rawDelta.remainingVolume ?? existing?.remaining_volume ?? null,
        remaining_value_cents:
          rawDelta.remainingValueCents ?? existing?.remaining_value_cents ?? null,
        order_value_cents: rawDelta.orderValueCents ?? existing?.order_value_cents ?? null,
        // 2026-07-13 — Transcript gap #1 + #2 (23:40 / 26:21). The
        // SSE delta carries `last_action` / `last_action_at` so the
        // UI's new Action column updates immediately when the worker
        // publishes an event-driven transition (ack / partial /
        // cancelled). We also forward the IRESS error fields when
        // the worker publishes a rejection delta.
        iress_error_number: existing?.iress_error_number ?? null,
        iress_error_description: existing?.iress_error_description ?? null,
        last_action: d.last_action ?? existing?.last_action ?? null,
        last_action_at: d.last_action_at ?? existing?.last_action_at ?? null,
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

  // Key the quote map by BOTH the raw symbol and its bare (.JO-stripped) form.
  // The row symbols carry the `.JO` suffix (e.g. "SOL.JO") but /api/quotes may
  // return either form depending on the provider — keying both ways makes the
  // Last-price lookup robust to that mismatch (which was showing "—" for every
  // row even when a live price existed).
  const lastBySymbol = React.useMemo(() => {
    const m = new Map<string, number>();
    for (const q of quotes.data?.quotes ?? []) {
      if (!q.symbol || q.last_price == null || !Number.isFinite(q.last_price)) continue;
      const raw = q.symbol.toUpperCase();
      m.set(raw, q.last_price);
      m.set(raw.replace(/\.(JO|JSE)$/i, ""), q.last_price);
    }
    return m;
  }, [quotes.data]);
  const lookupLast = React.useCallback(
    (symbol: string): number | null => {
      const raw = (symbol ?? "").toUpperCase();
      return lastBySymbol.get(raw) ?? lastBySymbol.get(raw.replace(/\.(JO|JSE)$/i, "")) ?? null;
    },
    [lastBySymbol],
  );

  // 2026-07-15: group rows by `order_id` (the IRESS OrderNumber). The
  // ExecutionView shows audit rows from two producers — the BFF-seeded
  // UAT row (stamped BEFORE the worker call, status="pending_ack") and
  // the worker-poll row (stamped after the broker ack, with limit /
  // filled / avgPx). When the OrderNumber is the same on both, they
  // collapse into a single parent row + a chevron that expands the
  // timeline of lifecycle events (every audit row that touched that
  // order). Parent = the row with the most signal (filled > 0, or has
  // limit_price, or has brokerState ACTIVE). Children = everything else.
  interface GroupedRow {
    parent: ExecutionRow;
    children: ExecutionRow[];
  }
  const groupedRows = React.useMemo<GroupedRow[]>(() => {
    const byKey = new Map<string, ExecutionRow[]>();
    for (const r of rows) {
      const key = (r.order_id || r.id || "—").trim() || "—";
      const arr = byKey.get(key);
      if (arr) arr.push(r);
      else byKey.set(key, [r]);
    }
    const out: GroupedRow[] = [];
    for (const arr of byKey.values()) {
      // Pick parent: prefer the row with a real fill OR a limit price OR
      // a known brokerState. Tie-break by most-recent updated_at / ts.
      const score = (x: ExecutionRow): number =>
        (x.filled > 0 ? 100 : 0) +
        (x.limit_price != null ? 10 : 0) +
        (x.broker_state === "ACTIVE" ? 5 : x.broker_state === "INACTIVE" ? 1 : 0) +
        (x.avg_fill_price != null ? 4 : 0);
      const sorted = [...arr].sort((a, b) => {
        const ds = score(b) - score(a);
        if (ds !== 0) return ds;
        return Date.parse(b.ts || "") - Date.parse(a.ts || "");
      });
      const [parent, ...children] = sorted;
      // `sorted` always has at least one row (we created the array from
      // arr.length > 0). Non-null assert so TS strict sees it as such.
      out.push({ parent: parent!, children });
    }
    // Order groups by the parent's most-recent timestamp DESC.
    out.sort((a, b) => Date.parse(b.parent.ts || "") - Date.parse(a.parent.ts || ""));
    return out;
  }, [rows]);

  // Expansion state — order_id → expanded. Default: collapsed (the
  // parent shows the lifecycle count badge; click to expand). Auto-expand
  // when a NEW SSE delta lands so the operator sees the lifecycle event
  // as it happens (Andre, 2026-07-13).
  const [expanded, setExpanded] = React.useState<Record<string, boolean>>({});
  const prevLiveCountRef = React.useRef<number>(0);
  React.useEffect(() => {
    const currentCount = Object.keys(liveOverrides).length;
    if (currentCount > prevLiveCountRef.current) {
      // A new SSE delta arrived — auto-expand the affected order so the
      // operator sees the lifecycle event without manual interaction.
      setExpanded((prev) => {
        const next = { ...prev };
        for (const o of Object.values(liveOverrides)) {
          const key = (o.order_id || o.id || "").trim();
          if (key) next[key] = true;
        }
        return next;
      });
    }
    prevLiveCountRef.current = currentCount;
  }, [liveOverrides]);

  const totalEvents = React.useMemo(
    () => groupedRows.reduce((s, g) => s + 1 + g.children.length, 0),
    [groupedRows],
  );

  // Per-row cancel state (2026-07-13). When the desk clicks Cancel on a
  // row, we POST /api/admin/orderbook/cancel which forwards to the worker's
  // /orders/cancel (OrderDelete). The handler optimistically flips the
  // row to CANCELLED in `liveOverrides` so the UI updates instantly; the
  // SSE delta from the worker confirms the transition on the next push.
  const [cancelInFlight, setCancelInFlight] = React.useState<Record<string, boolean>>({});
  const [cancelError, setCancelError] = React.useState<Record<string, string>>({});
  const handleCancel = React.useCallback(
    async (row: ExecutionRow) => {
      // Prefer the IRESS AccountCode (broker_account — payload.uatAccountCode
      // for UAT). Fall back to client_account for production rows where the
      // worker uses IRESS_ACCOUNT_CODE from env. The worker's /orders/cancel
      // logs the actual account it uses so the operator can see if our
      // guess was wrong.
      const accountGuess =
        (typeof row.broker_account === "string" && row.broker_account.length > 0
          ? row.broker_account
          : null) ??
        (typeof row.client_account === "string" && row.client_account.length > 0
          ? row.client_account
          : "56378"); // UAT default — the worker logs the actual account used
      const iressOrderNumber = row.order_id;
      if (!iressOrderNumber) return;
      const auditId = row.id;
      setCancelInFlight((p) => ({ ...p, [auditId]: true }));
      setCancelError((p) => ({ ...p, [auditId]: "" }));
      // Optimistic UI update — flip the local override to CANCEL_PENDING
      // so the desk sees "cancel sent" before the broker acks. The worker
      // SSE delta (or next 30s poll) carries the state transition to
      // CANCELLED once IRESS acknowledges the OrderDelete.
      setLiveOverrides((p) => ({
        ...p,
        [auditId]: {
          ...(p[auditId] ?? row),
          state: "CANCEL_PENDING",
        },
      }));
      try {
        const res = await fetch("/api/admin/orderbook/cancel", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ account: accountGuess, order_number: iressOrderNumber }),
        });
        if (!res.ok && res.status >= 500) {
          setCancelError((p) => ({
            ...p,
            [auditId]: `Cancel endpoint returned ${res.status}`,
          }));
        } else {
          const body = (await res.json().catch(() => ({}))) as {
            ok?: boolean;
            error?: string;
            message?: string;
          };
          if (body && body.ok === false) {
            setCancelError((p) => ({
              ...p,
              [auditId]: body.message ?? body.error ?? "Cancel failed",
            }));
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setCancelError((p) => ({ ...p, [auditId]: msg }));
      } finally {
        setCancelInFlight((p) => ({ ...p, [auditId]: false }));
      }
    },
    [],
  );

  // A row is "cancellable" when it's in flight at the broker — i.e. not
  // already FILLED / CANCELLED / REJECTED / EXPIRED / FAILED. We surface a
  // disabled button on terminal rows so the desk gets clear feedback. FAILED
  // (2026-07-14) is also terminal — there's nothing on the book to cancel.
  //
  // 2026-07-15 (Andre + Juan, 06:35-07:46): Hermes rules — when an order
  // is in PENDING_ACK, the message we sent has left our session and is
  // owned by the destination. We can't cancel or amend it from here. So
  // we exclude PENDING_ACK from the cancellable set; the operator must
  // wait for the broker ack before any instruction lands. The action
  // column renders a small "⌛ wait for broker ack" hint instead.
  const isCancellable = (state: string): boolean =>
    state === "WORKING" ||
    state === "PARTIAL" ||
    state === "ACKNOWLEDGED" ||
    state === "created" ||
    state === "amended";

  // Amend is the same set as cancel, plus the lifecycle never allows
  // amending an AMEND_PENDING row (avoid racing two broker instructions
  // on the same OrderNumber). Operators must wait for the ack.
  const isAmendable = (state: string): boolean =>
    isCancellable(state) && state !== "AMEND_PENDING";

  // 2026-07-15: PENDING_ACK rows are read-only — Show a hint placeholder
  // in the actions column so the desk knows the row is queued at the
  // destination rather than muted.
  const isAwaitingBrokerAck = (state: string): boolean => state === "PENDING_ACK";

  // 2026-07-14: amend row state. When the desk clicks "Amend" on a row,
  // we expand an inline form (price / qty / TIF) directly under the row.
  // The form local state lives in `amendForm` keyed by audit row id so
  // multiple rows can have their own open form simultaneously.
  const [amendOpen, setAmendOpen] = React.useState<Record<string, boolean>>({});
  const [amendForm, setAmendForm] = React.useState<
    Record<string, { priceRands: string; volume: string; tif: "DAY" | "GTC" | "IOC" | "FOK" }>
  >({});
  const [amendInFlight, setAmendInFlight] = React.useState<Record<string, boolean>>({});
  const [amendError, setAmendError] = React.useState<Record<string, string>>({});

  const openAmend = React.useCallback((row: ExecutionRow) => {
    const auditId = row.id;
    setAmendOpen((p) => ({ ...p, [auditId]: true }));
    setAmendForm((p) => ({
      ...p,
      [auditId]: {
        // Pre-fill from the current row so the operator only changes
        // what they need to. Limit is stored as Rands on the row.
        priceRands: row.limit_price != null ? String(row.limit_price) : "",
        volume: String(row.qty || ""),
        tif: (row.tif === "DAY" || row.tif === "GTC" || row.tif === "IOC" || row.tif === "FOK")
          ? row.tif
          : "DAY",
      },
    }));
    setAmendError((p) => ({ ...p, [auditId]: "" }));
  }, []);

  const closeAmend = React.useCallback((auditId: string) => {
    setAmendOpen((p) => ({ ...p, [auditId]: false }));
    setAmendError((p) => ({ ...p, [auditId]: "" }));
  }, []);

  const submitAmend = React.useCallback(
    async (row: ExecutionRow) => {
      const auditId = row.id;
      const form = amendForm[auditId];
      if (!form) return;
      const accountGuess =
        (typeof row.broker_account === "string" && row.broker_account.length > 0
          ? row.broker_account
          : null) ??
        (typeof row.client_account === "string" && row.client_account.length > 0
          ? row.client_account
          : "56378");
      const iressOrderNumber = row.order_id;
      if (!iressOrderNumber) return;
      // Build the amend payload. Skip fields that match the existing
      // row (don't ask the broker to "amend" to the same value).
      const px = form.priceRands.trim() === "" ? null : Number(form.priceRands);
      const vol = form.volume.trim() === "" ? null : Number(form.volume);
      const body: Record<string, unknown> = { account: accountGuess, order_number: iressOrderNumber };
      if (px != null && Number.isFinite(px) && (row.limit_price == null || Math.abs(px - row.limit_price) > 0.0001)) {
        body.price = px;
      }
      if (vol != null && Number.isFinite(vol) && vol > 0 && vol !== row.qty) {
        body.volume = vol;
      }
      if (form.tif !== row.tif) {
        body.tif = form.tif;
      }
      if (!("price" in body) && !("volume" in body) && !("tif" in body)) {
        setAmendError((p) => ({
          ...p,
          [auditId]: "Nothing to amend — at least one of price / volume / TIF must change.",
        }));
        return;
      }
      setAmendInFlight((p) => ({ ...p, [auditId]: true }));
      setAmendError((p) => ({ ...p, [auditId]: "" }));
      // 2026-07-15: pre-flight guard for MARKET orders. OrderAmend2
      // cannot change PricingInstructions — sending `price` on a MARKET
      // row would silently no-op at Hermes (Andre + Juan, 09:19-09:42).
      // We block locally so the form shows the constraint without a
      // round-trip; the BFF enforces the same guard with 422.
      if (row.order_type === "market" && px != null && Number.isFinite(px)) {
        setAmendError((p) => ({
          ...p,
          [auditId]:
            "MARKET orders cannot have their price amended via OrderAmend2 — cancel and re-create the order to set a limit price. Volume / TIF will still amend.",
        }));
        setAmendInFlight((p) => ({ ...p, [auditId]: false }));
        return;
      }
      // Optimistic UI — flip the local override to AMEND_PENDING so the
      // desk sees the instruction before the broker acks. The worker SSE
      // delta confirms (and carries the new fields on the next push).
      setLiveOverrides((p) => ({
        ...p,
        [auditId]: {
          ...(p[auditId] ?? row),
          state: "AMEND_PENDING",
          ...(px != null && Number.isFinite(px) ? { limit_price: px } : {}),
          ...(vol != null && Number.isFinite(vol) ? { qty: vol } : {}),
        },
      }));
      try {
        const res = await fetch("/api/admin/orderbook/amend", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok && res.status >= 500) {
          setAmendError((p) => ({
            ...p,
            [auditId]: `Amend endpoint returned ${res.status}`,
          }));
        } else {
          const data = (await res.json().catch(() => ({}))) as {
            ok?: boolean;
            error?: string;
            message?: string;
          };
          if (data && data.ok === false) {
            setAmendError((p) => ({
              ...p,
              [auditId]: data.message ?? data.error ?? "Amend failed",
            }));
          } else {
            // Close the form on success — the row now shows AMEND_PENDING
            // and the operator waits for the broker ack.
            closeAmend(auditId);
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setAmendError((p) => ({ ...p, [auditId]: msg }));
      } finally {
        setAmendInFlight((p) => ({ ...p, [auditId]: false }));
      }
    },
    [amendForm, closeAmend],
  );

  const showLoading = executions.loading && groupedRows.length === 0;
  const hasNotice = !!executions.data?.notice;

  return (
    <div className="w-full min-w-0 max-w-full rounded-xl border border-border bg-card/40 overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2.5">
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Per-ISIN execution
          </span>
          <Badge variant="outline" className="font-mono">
            {groupedRows.length}
          </Badge>
          {totalEvents !== groupedRows.length ? (
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
              ({totalEvents} events)
            </span>
          ) : null}
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

      <div className="w-full overflow-x-auto">
        <table className="w-full min-w-[960px] border-collapse">
          <thead>
            <tr className="border-b border-border bg-card/60 text-left">
              {[
                "",
                "Order ID",
                "Timestamp",
                "Side",
                "Symbol",
                "Qty",
                "Order Value",
                "% Filled",
                "Limit",
                "Avg Price",
                "Last",
                "Slip / Day-1 P&L",
                "TIF",
                "State",
                "Actions",
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
            ) : groupedRows.length === 0 ? (
              <tr>
                <td colSpan={15} className="px-3 py-10 text-center text-[12px] text-muted-foreground">
                  No execution rows for this book yet — click <em>Send to Market</em> to dispatch.
                </td>
              </tr>
            ) : (
              groupedRows.map((g) => {
                const r = g.parent;
                const liveLast = lookupLast(r.symbol);
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
                const groupKey = (r.order_id || r.id || "").trim();
                const isExpanded = !!expanded[groupKey];
                const toggle = () =>
                  setExpanded((p) => ({ ...p, [groupKey]: !p[groupKey] }));
                const childCount = g.children.length;
                return (
                  <React.Fragment key={`grp:${groupKey}`}>
                  <tr
                    className={cn(
                      "border-b border-border/40 hover:bg-accent/10",
                      childCount > 0 && "bg-accent/5",
                    )}
                  >
                    <td className="px-2 py-1.5 whitespace-nowrap">
                      <button
                        type="button"
                        onClick={toggle}
                        className={cn(
                          "inline-flex h-5 w-5 items-center justify-center rounded border border-border/60 bg-background/40 text-[10px] text-muted-foreground hover:bg-accent",
                          childCount === 0 && "opacity-30 cursor-default",
                        )}
                        disabled={childCount === 0}
                        aria-label={isExpanded ? "Collapse timeline" : "Expand timeline"}
                        title={
                          childCount === 0
                            ? "No lifecycle events to expand"
                            : isExpanded
                              ? "Collapse lifecycle timeline"
                              : `Expand ${childCount} lifecycle event${childCount === 1 ? "" : "s"}`
                        }
                      >
                        {isExpanded ? "▾" : "▸"}
                      </button>
                    </td>
                    <td className="px-3 py-1.5 font-mono text-[11px] text-foreground whitespace-nowrap">
                      <div className="flex items-center gap-1.5">
                        <span>{r.order_id}</span>
                        {childCount > 0 ? (
                          <span
                            className="inline-flex items-center rounded-full bg-accent px-1.5 py-0 text-[9px] font-semibold uppercase tracking-wider text-accent-foreground"
                            title={`${childCount} lifecycle event${childCount === 1 ? "" : "s"} on this OrderNumber — click the chevron to expand`}
                          >
                            +{childCount}
                          </span>
                        ) : null}
                      </div>
                    </td>
                    <td className="px-3 py-1.5 text-[11px] text-muted-foreground whitespace-nowrap">
                      {fmtTs(r.ts)}
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
                    <td className="px-3 py-1.5 text-[12px] font-medium text-foreground whitespace-nowrap">
                      {(() => {
                        // Prefer the limit, then the actual fill, then the live
                        // last price — so MARKET orders (no limit, unfilled)
                        // still show an estimated notional instead of "—".
                        const px =
                          r.limit_price ??
                          (r.filled > 0 ? r.avg_fill_price : null) ??
                          (typeof liveLast === "number" ? liveLast : null);
                        return px != null && Number.isFinite(px) ? fmtMoney(px * r.qty) : "—";
                      })()}
                    </td>
                    <td className="px-3 py-1.5 text-[12px] text-foreground whitespace-nowrap">
                      {fmtPct(r.filled_pct)}
                    </td>
                    <td className="px-3 py-1.5 text-[12px] text-foreground whitespace-nowrap">
                      <div className="flex flex-col items-start gap-0.5">
                        <span>{fmtMoney(r.limit_price)}</span>
                        {r.order_type ? (
                          <span
                            className={cn(
                              "inline-flex items-center rounded px-1 py-0 text-[9px] font-semibold uppercase tracking-wider",
                              r.order_type === "limit"
                                ? "bg-primary/10 text-primary"
                                : "bg-warning/15 text-warning",
                            )}
                            title={
                              r.order_type === "limit"
                                ? "LIMIT order — IRESS OrderAmend2 can update price / volume / TIF / triggerPrice."
                                : "MARKET order — IRESS OrderAmend2 cannot change PricingInstructions (LIMIT↔MARKET). Price amendments on this row will silently no-op; cancel + re-create to switch."
                            }
                          >
                            {r.order_type === "limit" ? "LMT" : "MKT"}
                          </span>
                        ) : null}
                      </div>
                    </td>
                    <td className="px-3 py-1.5 text-[12px] text-foreground whitespace-nowrap">
                      {r.filled > 0 && r.avg_fill_price ? fmtMoney(r.avg_fill_price) : "—"}
                    </td>
                    <td className="px-3 py-1.5 text-[12px] text-foreground whitespace-nowrap">
                      {typeof liveLast === "number" && Number.isFinite(liveLast) ? fmtMoney(liveLast) : "—"}
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
                      {r.tif}
                    </td>
                    <td className="px-3 py-1.5 whitespace-nowrap">
                      <div className="flex flex-col items-start gap-0.5">
                        <span
                          title={stateTooltip(r)}
                          className="inline-flex"
                        >
                          <Badge variant={STATE_VARIANT[r.state] ?? "outline"}>{r.state}</Badge>
                        </span>
                        {/* 2026-07-14: surface the IRESS broker-side
                            active / inactive flag (Hermes OrderState) as a
                            tiny secondary chip. Distinct from the lifecycle
                            state — a fully-filled order is INACTIVE but
                            "FILLED". Operators asked for an "active or
                            inactive" indicator so they can spot orders the
                            broker has parked vs ones still live. UNKNOWN
                            surfaces for BFF-seeded rows pre-poll. */}
                        {r.broker_state && r.broker_state !== "UNKNOWN" ? (
                          <span
                            className={cn(
                              "inline-flex items-center rounded-full px-1.5 py-0 text-[9px] font-semibold uppercase tracking-wider",
                              r.broker_state === "ACTIVE"
                                ? "bg-success/15 text-success"
                                : "bg-muted text-muted-foreground",
                            )}
                            title={`Hermes OrderState: ${r.broker_state}`}
                          >
                            {r.broker_state === "ACTIVE" ? "● active" : "○ inactive"}
                          </span>
                        ) : null}
                        {/* 2026-07-14: pre-trade limit-guard stamp from the
                            BFF send-to-market. The IRESS broker does NOT
                            block naked shorts (Andre, 28:22-34:32) — this
                            chip tells the desk whether the no-naked-short
                            + cash-bust guard ran for this dispatch. */}
                        {r.limits_enforced === true ? (
                          <span
                            className="inline-flex items-center rounded-full bg-primary/10 px-1.5 py-0 text-[9px] font-semibold uppercase tracking-wider text-primary"
                            title={`Limit guard PASSED at ${r.limits_checked_at ?? "—"} for account ${r.limits_account_code ?? "—"}. Available cash + position + in-flight orders were checked.`}
                          >
                            ✓ guarded
                          </span>
                        ) : r.limits_enforced === false ? (
                          <span
                            className="inline-flex items-center rounded-full bg-warning/15 px-1.5 py-0 text-[9px] font-semibold uppercase tracking-wider text-warning"
                            title={`Limit guard did NOT run for this order — ${r.limits_skip_reason ?? "no reason recorded"}. Order dispatched to broker without cash / naked-short check.`}
                          >
                            ⚠ not guarded
                          </span>
                        ) : null}
                        {/* 2026-07-14: a FAILED order's only useful detail
                            is the broker error. Render the IRESS
                            ErrorNumber + ErrorDescription inline so the
                            operator doesn't need to expand the row to
                            know why it failed (Andre, transcript 25:08-
                            27:53 — the "destinations unavailable" test). */}
                        {r.state === "FAILED" && r.iress_error_number != null ? (
                          <span
                            className="text-[9px] text-destructive/90"
                            title={r.iress_error_description ?? undefined}
                          >
                            IRESS {r.iress_error_number}
                            {r.iress_error_description ? `: ${r.iress_error_description}` : null}
                          </span>
                        ) : null}
                      </div>
                    </td>
                    <td className="px-3 py-1.5 whitespace-nowrap">
                      {isCancellable(r.state) ? (
                        <div className="flex flex-col gap-1">
                          <div className="flex gap-1">
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={!!cancelInFlight[r.id]}
                              onClick={() => void handleCancel(r)}
                              className="h-7 px-2 text-[10px] uppercase tracking-wider text-destructive hover:bg-destructive/10"
                              title={`Cancel order ${r.order_id} on IRESS (OrderDelete via worker).`}
                            >
                              {cancelInFlight[r.id] ? (
                                <>
                                  <Loader2 className="mr-1 h-2.5 w-2.5 animate-spin" />
                                  cancelling…
                                </>
                              ) : (
                                "Cancel"
                              )}
                            </Button>
                            {isAmendable(r.state) ? (
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => openAmend(r)}
                                className="h-7 px-2 text-[10px] uppercase tracking-wider text-primary hover:bg-primary/10"
                                title={`Amend order ${r.order_id} on IRESS (OrderAmend2 via worker). Only Volume / Price / TimeInForce / TriggerPrice can be amended — LIMIT↔MARKET is not amendable, cancel + re-create instead.`}
                              >
                                Amend
                              </Button>
                            ) : null}
                          </div>
                          {cancelError[r.id] ? (
                            <span className="text-[9px] text-destructive" title={cancelError[r.id] ?? undefined}>
                              {cancelError[r.id]}
                            </span>
                          ) : null}
                        </div>
                      ) : isAwaitingBrokerAck(r.state) ? (
                        <div className="flex flex-col gap-0.5">
                          <span
                            className="inline-flex items-center gap-1 rounded-md border border-warning/30 bg-warning/5 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-warning"
                            title="OrderCreate3 has left our session and is owned by the destination. Cancel / Amend are disabled until the broker acknowledges the order."
                          >
                            <Loader2 className="h-2.5 w-2.5 animate-spin" />
                            awaiting broker ack
                          </span>
                          <span className="text-[9px] text-muted-foreground">
                            Actions locked until Hermes acknowledges
                          </span>
                        </div>
                      ) : (
                        <span className="text-[10px] uppercase tracking-wider text-muted-foreground">—</span>
                      )}
                    </td>
                  </tr>
                  {isExpanded && childCount > 0 ? (
                    <tr
                      key={`${groupKey}-lifecycle`}
                      className="border-b border-border/40 bg-accent/10"
                    >
                      <td colSpan={15} className="px-3 py-2">
                        <div className="flex flex-col gap-1.5">
                          <div className="flex items-center gap-2">
                            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                              Lifecycle timeline — {r.order_id}
                            </span>
                            <span className="text-[10px] text-muted-foreground">
                              {childCount} event{childCount === 1 ? "" : "s"} after the parent ({r.action_status ?? r.last_action ?? "open"})
                            </span>
                          </div>
                          <table className="w-full border-collapse">
                            <thead>
                              <tr className="text-left text-[9px] uppercase tracking-wider text-muted-foreground">
                                <th className="px-2 py-1 font-semibold whitespace-nowrap">Timestamp</th>
                                <th className="px-2 py-1 font-semibold whitespace-nowrap">Strategy</th>
                                <th className="px-2 py-1 font-semibold whitespace-nowrap">Side</th>
                                <th className="px-2 py-1 font-semibold whitespace-nowrap">Symbol</th>
                                <th className="px-2 py-1 font-semibold whitespace-nowrap">Qty</th>
                                <th className="px-2 py-1 font-semibold whitespace-nowrap">Limit</th>
                                <th className="px-2 py-1 font-semibold whitespace-nowrap">Avg Px</th>
                                <th className="px-2 py-1 font-semibold whitespace-nowrap">% Filled</th>
                                <th className="px-2 py-1 font-semibold whitespace-nowrap">State</th>
                                <th className="px-2 py-1 font-semibold whitespace-nowrap">Action</th>
                                <th className="px-2 py-1 font-semibold whitespace-nowrap">Sent by</th>
                                <th className="px-2 py-1 font-semibold whitespace-nowrap">Source</th>
                              </tr>
                            </thead>
                            <tbody>
                              {g.children.map((c) => {
                                const cFilled = c.filled ?? 0;
                                const cOrdVol = c.qty ?? 0;
                                const cPct =
                                  cOrdVol > 0
                                    ? `${((cFilled / cOrdVol) * 100).toFixed(cFilled > 0 ? 1 : 0)}%`
                                    : "—";
                                return (
                                  <tr
                                    key={c.id}
                                    className="border-t border-border/30 hover:bg-accent/10"
                                  >
                                    <td className="px-2 py-1 font-mono text-[10px] text-muted-foreground whitespace-nowrap">
                                      {fmtTs(c.ts)}
                                    </td>
                                    <td className="px-2 py-1 text-[10px] whitespace-nowrap">{c.strategy ?? "—"}</td>
                                    <td className="px-2 py-1 whitespace-nowrap">
                                      <Badge variant={c.side === "SELL" ? "destructive" : "success"} className="text-[9px]">
                                        {c.side}
                                      </Badge>
                                    </td>
                                    <td className="px-2 py-1 text-[10px] font-semibold whitespace-nowrap">{c.symbol}</td>
                                    <td className="px-2 py-1 text-[10px] whitespace-nowrap">{c.qty ?? "—"}</td>
                                    <td className="px-2 py-1 text-[10px] whitespace-nowrap">
                                      {c.limit_price != null ? fmtMoney(c.limit_price) : "—"}
                                    </td>
                                    <td className="px-2 py-1 text-[10px] whitespace-nowrap">
                                      {c.avg_fill_price != null ? fmtMoney(c.avg_fill_price) : "—"}
                                    </td>
                                    <td className="px-2 py-1 text-[10px] whitespace-nowrap">{cPct}</td>
                                    <td className="px-2 py-1 whitespace-nowrap">
                                      <Badge variant={STATE_VARIANT[c.state] ?? "outline"} className="text-[9px]">
                                        {c.state}
                                      </Badge>
                                    </td>
                                    <td
                                      className="px-2 py-1 text-[10px] text-muted-foreground whitespace-nowrap"
                                      title={c.action_status || c.last_action || undefined}
                                    >
                                      {c.action_status ?? c.last_action ?? "—"}
                                    </td>
                                    <td className="px-2 py-1 text-[10px] text-muted-foreground whitespace-nowrap">
                                      {c.sent_by ?? "—"}
                                    </td>
                                    <td className="px-2 py-1 text-[10px] text-muted-foreground whitespace-nowrap">
                                      {c.source ?? "—"}
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      </td>
                    </tr>
                  ) : null}
                  {amendOpen[r.id] ? (
                    <tr key={`${r.id}-amend`} className="border-b border-border/40 bg-muted/30">
                      <td colSpan={15} className="px-3 py-2">
                        <div className="flex flex-col gap-1">
                          <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                            Amend order {r.order_id} — OrderAmend2 via worker
                          </span>
                          <div className="flex flex-wrap items-end gap-2">
                            <label className="flex flex-col gap-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                              Price (R)
                              <Input
                                type="number"
                                step="0.01"
                                min="0"
                                disabled={r.order_type === "market"}
                                className={cn(
                                  "h-7 w-24 text-[11px]",
                                  r.order_type === "market" && "cursor-not-allowed opacity-60",
                                )}
                                value={amendForm[r.id]?.priceRands ?? ""}
                                onChange={(e) =>
                                  setAmendForm((p) => ({
                                    ...p,
                                    [r.id]: {
                                      priceRands: e.target.value,
                                      volume: p[r.id]?.volume ?? "",
                                      tif: p[r.id]?.tif ?? "DAY",
                                    },
                                  }))
                                }
                                placeholder={
                                  r.order_type === "market"
                                    ? "MKT — not amendable"
                                    : r.limit_price != null
                                      ? String(r.limit_price)
                                      : "—"
                                }
                                title={
                                  r.order_type === "market"
                                    ? "Price cannot be amended on a MARKET order via OrderAmend2 (PricingInstructions is fixed). Cancel + re-create to set a limit price."
                                    : "New limit price in Rands. Sent to OrderAmend2 as Price (partial update)."
                                }
                              />
                            </label>
                            <label className="flex flex-col gap-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                              Volume
                              <Input
                                type="number"
                                step="1"
                                min="1"
                                className="h-7 w-20 text-[11px]"
                                value={amendForm[r.id]?.volume ?? ""}
                                onChange={(e) =>
                                  setAmendForm((p) => ({
                                    ...p,
                                    [r.id]: {
                                      priceRands: p[r.id]?.priceRands ?? "",
                                      volume: e.target.value,
                                      tif: p[r.id]?.tif ?? "DAY",
                                    },
                                  }))
                                }
                              />
                            </label>
                            <label className="flex flex-col gap-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                              TIF
                              <select
                                className="h-7 rounded-md border border-input bg-background px-2 text-[11px]"
                                value={amendForm[r.id]?.tif ?? "DAY"}
                                onChange={(e) =>
                                  setAmendForm((p) => ({
                                    ...p,
                                    [r.id]: {
                                      priceRands: p[r.id]?.priceRands ?? "",
                                      volume: p[r.id]?.volume ?? "",
                                      tif: e.target.value as "DAY" | "GTC" | "IOC" | "FOK",
                                    },
                                  }))
                                }
                              >
                                <option value="DAY">DAY</option>
                                <option value="GTC">GTC</option>
                                <option value="IOC">IOC</option>
                                <option value="FOK">FOK</option>
                              </select>
                            </label>
                            <Button
                              size="sm"
                              disabled={!!amendInFlight[r.id]}
                              onClick={() => void submitAmend(r)}
                              className="h-7"
                              title="Submit OrderAmend2 to IRESS via the worker."
                            >
                              {amendInFlight[r.id] ? (
                                <>
                                  <Loader2 className="mr-1 h-2.5 w-2.5 animate-spin" />
                                  sending…
                                </>
                              ) : (
                                "Submit amend"
                              )}
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => closeAmend(r.id)}
                              className="h-7"
                              disabled={!!amendInFlight[r.id]}
                            >
                              Cancel
                            </Button>
                          </div>
                          {amendError[r.id] ? (
                            <span className="text-[10px] text-destructive" title={amendError[r.id] ?? undefined}>
                              {amendError[r.id]}
                            </span>
                          ) : r.order_type === "market" ? (
                            <span
                              className="text-[10px] text-warning"
                              title="IRESS OrderAmend2 cannot change PricingInstructions. Sending a `price` on a MARKET order returns 422 from /api/admin/orderbook/amend — cancel + re-create to switch. Volume / TIF amendments still apply."
                            >
                              MARKET order — price amendments are blocked at the broker. Volume / TIF will amend; for a limit price, cancel and re-create. State flips to AMEND_PENDING on submit, then back to WORKING/PARTIAL on broker ack — partial fills preserved.
                            </span>
                          ) : (
                            <span className="text-[10px] text-muted-foreground">
                              Only changed fields are sent to the broker (OrderAmend2 is partial). State flips to AMEND_PENDING on submit, then back to WORKING/PARTIAL on broker ack — partial fills preserved.
                            </span>
                          )}
                        </div>
                      </td>
                    </tr>
                  ) : null}
                </React.Fragment>
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
