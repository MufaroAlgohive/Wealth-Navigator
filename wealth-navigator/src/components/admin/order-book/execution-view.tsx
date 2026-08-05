"use client";

/**
 * ExecutionView — the OEM order-book's single unified panel (UAT scope).
 *
 * 2026-07-22: consolidated from two previously-separate panels — this used
 * to be a flat, one-row-per-order blotter for a SINGLE book id, with a
 * SEPARATE CRM-style strategy/security/investor drill-down panel
 * (UatBasketBook/BasketDetail/SecurityRow/InvestorFilterTable) living below
 * it. Per direction, this panel is now the ONE surviving panel: it takes
 * MULTIPLE book ids, merges + reconciles them exactly as before, and adds a
 * strategy → security-aggregate / strategy → investor-aggregate two-axis
 * drill-down on top (mirroring the CRM's orderbook.html behavior) WITHOUT
 * changing the existing per-order row's columns/actions/lifecycle-timeline —
 * those are reused completely unchanged as the leaf content of the new
 * "Holdings under {Strategy}" tree.
 *
 * Real-time layer (SSE + poll reconciliation + optimistic Cancel/Amend) is
 * UNCHANGED and now the ONLY implementation of this — the old
 * use-order-actions.ts / SecurityRow's laggier (2s-poll-only) Cancel/Amend
 * has been retired now that every row shown anywhere in this panel goes
 * through the same liveOverrides/survivingOverrides pipeline.
 *
 * Columns (per-order leaf row, unchanged): Order ID | Timestamp | Side |
 * Symbol | Qty | Order Value | % Filled | Limit | Avg Price | Last |
 * Slip / Day-1 P&L | TIF | State | Actions.
 *
 * Slip / Day-1 P&L = limit − actual fill (in cents). GREEN when fill < client
 * limit (positive slippage for a buy). Updates automatically as quotes tick.
 *
 * When `uatMode=true` (Vercel + worker both), subscribes to
 * `/api/admin/orderbook/stream` for live fill deltas. Stops polling while
 * the tab is hidden.
 */

import { ChevronRight, Loader2, Pencil, Radio, SendHorizontal } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DataSourceBadge } from "@/components/oems/primitives/data-source-badge";
import { cn } from "@/lib/cn";
import { usePolling } from "@/lib/hooks/use-polling";
import { SEND_TO_MARKET_LOCKED, SEND_TO_MARKET_LOCKED_MESSAGE } from "@/lib/orders/send-to-market-lock";
import { allowsMarketRelease, allowsUatSelfFill } from "@/lib/oems/orderbook-lane-actions";
import { isAmendable, isAwaitingBrokerAck, isCancellable } from "./format";
import { InvestorFilterTable, type InvestorAgg } from "./investor-filter-table";

export interface ExecutionRow {
  id: string;
  // 2026-07-23: CRM-style order-book number (see release-to-market/route.ts,
  // which stamps this onto every row released together in one "Send to
  // Market" click) — null until the row has been released at least once.
  order_book_seq: number | null;
  order_id: string;
  // 2026-07-13: OEMS client identifier (profile email or user_id). The Cancel
  // button uses broker_account (the IRESS AccountCode) when forwarding to
  // /api/admin/orderbook/cancel.
  client_account: string;
  broker_account: string | null;
  ts: string;
  /** Broker-observation time (audit updated_at) for optimistic-override reconciliation. */
  updated_at?: string;
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
  // surface. `PARKED` (2026-07-22): a mint client-order row awaiting release
  // via /api/admin/orderbook/release-to-market — zero broker contact yet.
  state:
    | "PARKED"
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

interface OrderBooksPayload {
  ok: boolean;
  books?: OrderBookSummary[];
  notice?: string;
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
  // PARKED (2026-07-22): outline — same neutral "not yet sent" tone as
  // PENDING_ACK, matching iress-status-pill.tsx's mapping.
  PARKED: "outline",
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

/** Terminal lifecycle states — once the poll observes one, the optimistic override is dropped. */
const TERMINAL_STATES = new Set(["FILLED", "CANCELLED", "REJECTED", "EXPIRED", "FAILED"]);
/** Broker-observation time of a row, for reconciling optimistic overrides against the poll. */
const obsTime = (r: ExecutionRow): number => Date.parse(r.updated_at ?? r.ts) || 0;

/**
 * Translate an incoming lifecycle token (from SSE / audit BFF) to the typed
 * `state` enum. Accepts both the upper-case form ("PARTIAL") and the lower-
 * case audit-token form ("partial") for backwards compatibility with older
 * SSE producers. Unknown tokens pass through verbatim so the UI badge can
 * surface "what is this?" rather than silently collapsing to WORKING.
 */
function stateUppercaseToDb(state: string): ExecutionRow["state"] {
  return state.toUpperCase() as ExecutionRow["state"];
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
  if (row.remaining_volume != null && row.qty > 0 && row.remaining_volume > 0) {
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

interface GroupedRow {
  parent: ExecutionRow;
  children: ExecutionRow[];
}

/**
 * Group the fully-reconciled row set by `strategy` (falling back to the
 * originating book id when strategy is null — the mint client-order / ad-hoc
 * ticket rows have no real strategy today, so `payload.strategy` is stamped
 * with the book id itself; a future basket buy would stamp the real
 * strategy name here instead, and this same grouping picks it up for free).
 * Pure view over `groupedRows` — never re-runs SSE/poll reconciliation.
 */
export interface StrategyBlock {
  strategy: string;
  groups: GroupedRow[];
}

/** Direct gift claims need one disclosure level: gift order -> asset orders. */
export function isGiftOrderBlock(strategy: string): boolean {
  return /^GIFT-[A-Z0-9_-]+$/i.test(strategy.trim());
}

export function groupOrdersByStrategy(groupedRows: GroupedRow[]): StrategyBlock[] {
  const m = new Map<string, GroupedRow[]>();
  for (const g of groupedRows) {
    const key = g.parent.strategy || "Unassigned";
    const arr = m.get(key);
    if (arr) arr.push(g);
    else m.set(key, [g]);
  }
  return [...m.entries()]
    .map(([strategy, groups]) => ({ strategy, groups }))
    .sort((a, b) => {
      const latest = (blk: GroupedRow[]) =>
        blk.reduce((max, g) => Math.max(max, Date.parse(g.parent.ts || "") || 0), 0);
      return latest(b.groups) - latest(a.groups);
    });
}

/** One member order of a released book. All prices are RANDS — the BFF
 *  (`/api/admin/orderbook/order-books`) converts the CENTS it reads out of
 *  `oems_order_audit` exactly once, on the way out. */
export interface OrderBookMember {
  id: string;
  order_id: string | null;
  client_account: string | null;
  symbol: string | null;
  side: string;
  qty: number;
  filled: number;
  status: string;
  order_type: "limit" | "market";
  limit_price_rands: number | null;
  avg_fill_price_rands: number | null;
  value_rands: number | null;
  venue: string | null;
  broker: string | null;
  last_action: string | null;
  filled_at: string | null;
  iress_error: string | null;
  crm_details?: {
    is_strategy: boolean;
    strategy_name: string | null;
    holdings: Array<{
      id: string;
      source_ids: string[];
      instrument: string;
      ticker: string;
      side: string;
      qty: number;
      avg_fill_rands: number | null;
      expected_fill_rands: number | null;
      market_value_rands: number | null;
      pnl_rands: number | null;
    }>;
    investors: Array<{
      id: string;
      source_ids: string[];
      name: string;
      account_id: string | null;
      family_relationship: string | null;
      holdings_count: number;
      market_value_rands: number | null;
    }>;
    allocations: Array<{
      id: string;
      name: string;
      account_id: string | null;
      reference: string | null;
      qty: number;
      market_value_rands: number | null;
      timestamp: string | null;
      instruction_type: string | null;
      settlement_ref: string | null;
    }>;
  };
}

export interface OrderBookSummary {
  archive_id?: string;
  origin?: "oem" | "crm";
  sequence: number;
  title?: string;
  released_at: string;
  released_by: string | null;
  total_count: number;
  filled_count: number;
  fully_filled: boolean;
  /** Present from 2026-07-27 so the archive panel can show what executed.
   *  Optional because an older cached response won't carry it. */
  members?: OrderBookMember[];
  filled_value_rands?: number | null;
  /** Distinct order sources across this book's members — lets the archive be
   *  split by app vs manual/UAT. Optional for older cached responses. */
  sources?: string[];
  /** "Move to Closed Book" state — shared across admins. null = still in
   *  Active/Manual Order Books. Optional for pre-migration responses. */
  closed_at?: string | null;
  closed_by?: string | null;
  email_status?: "sent" | "failed" | null;
  email_error?: string | null;
  email_sent_at?: string | null;
}

/**
 * The "Orderbook :NN" badge number — mirrors CRM's own
 * `getNextFilledOrderbookSequence()` semantics. If any book is still in
 * progress (not fully filled), that's the live/current book — show its own
 * number. Otherwise every known book has been fully filled (or none exist
 * yet), so the live number is one past the highest fully-filled sequence.
 */
export function computeLiveBookSequence(books: OrderBookSummary[]): number {
  const inProgress = books.filter((b) => !b.fully_filled);
  if (inProgress.length > 0) {
    return inProgress.reduce((max, b) => Math.max(max, b.sequence), 0);
  }
  const maxFilled = books.reduce((max, b) => Math.max(max, b.sequence), 0);
  return maxFilled + 1;
}

/**
 * Once a book is fully filled, its member orders are promoted into
 * "Active Order Books" (active-order-books.tsx) and drop out of the live
 * strategy-grouped table — matching the CRM screenshot's "0 records" live
 * ledger once nothing is in flight. Rows with no order_book_seq yet (still
 * parked, never released) always pass through untouched.
 */
export function filterOutPromotedBooks(rows: GroupedRow[], books: OrderBookSummary[]): GroupedRow[] {
  const fullyFilledSeqs = new Set(books.filter((b) => b.fully_filled).map((b) => b.sequence));
  if (fullyFilledSeqs.size === 0) return rows;
  return rows.filter((g) => g.parent.order_book_seq == null || !fullyFilledSeqs.has(g.parent.order_book_seq));
}

/**
 * 2026-07-23: only a REAL multi-security strategy (a basket buy, where
 * `strategy` is a genuine name distinct from the fixed `RAW_BOOK_IDS`
 * sentinels) gets the full "Strategy row -> Holdings tree + Investors
 * list" two-axis drill-down. A book like UAT-ADHOC/CLIENT-BUY isn't a
 * basket — `payload.strategy` on those rows is just stamped with the
 * originating book id (see parkOrder/submitOrder) — so wrapping 22
 * unrelated single-security orders behind one "UAT-ADHOC · 22 orders"
 * summary row hid real per-order data the desk needs to see without an
 * extra click. For these, skip the wrapper AND the security/investor
 * bucketing entirely: render each order directly as its own top-level
 * row, interleaved with any real strategy rows by most-recent activity —
 * matching how CRM's own outer ledger shows a plain (non-basket) order
 * directly, reserving the "Strategy" aggregate treatment for baskets.
 */
export type OrderBookDisplayItem =
  | { type: "order"; group: GroupedRow; ts: number }
  | { type: "strategy"; block: StrategyBlock; ts: number };

export function buildOrderBookDisplayItems(
  strategyBlocks: StrategyBlock[],
  rawBookIds: string[],
): OrderBookDisplayItem[] {
  const rawSet = new Set(rawBookIds);
  const items: OrderBookDisplayItem[] = [];
  for (const block of strategyBlocks) {
    if (rawSet.has(block.strategy) || block.strategy === "Unassigned") {
      for (const g of block.groups) {
        items.push({ type: "order", group: g, ts: Date.parse(g.parent.ts || "") || 0 });
      }
    } else {
      const ts = block.groups.reduce((max, g) => Math.max(max, Date.parse(g.parent.ts || "") || 0), 0);
      items.push({ type: "strategy", block, ts });
    }
  }
  return items.sort((a, b) => b.ts - a.ts);
}

interface SecurityBlock {
  key: string;
  symbol: string;
  side: string;
  qty: number;
  avgFillWeighted: number | null;
  groups: GroupedRow[];
}

/** "Holdings under {Strategy}" axis — aggregate a strategy block's orders by symbol. */
function buildSecurityBlocks(groups: GroupedRow[]): SecurityBlock[] {
  const m = new Map<string, SecurityBlock>();
  for (const g of groups) {
    const r = g.parent;
    const key = `${r.symbol}|${r.isin ?? ""}`;
    let b = m.get(key);
    if (!b) {
      b = { key, symbol: r.symbol, side: r.side, qty: 0, avgFillWeighted: null, groups: [] };
      m.set(key, b);
    }
    b.qty += r.qty;
    b.groups.push(g);
  }
  for (const b of m.values()) {
    const filled = b.groups.filter((g) => g.parent.avg_fill_price != null && g.parent.filled > 0);
    const totalFilled = filled.reduce((s, g) => s + g.parent.filled, 0);
    b.avgFillWeighted =
      totalFilled > 0
        ? filled.reduce((s, g) => s + (g.parent.avg_fill_price as number) * g.parent.filled, 0) / totalFilled
        : null;
  }
  return [...m.values()].sort((a, b) => b.qty - a.qty);
}

/**
 * "Investors in {Strategy}" axis — aggregate a strategy block's orders by
 * client. Mirrors the CRM's investor list (click a row to filter the
 * Holdings tree above to just that client — see the `onSelect` wiring in
 * the main render). `email` is not tracked separately for these
 * audit-row-only orders, so it mirrors `client` (the audit row's own
 * `client_account`).
 */
function buildInvestorAgg(groups: GroupedRow[], lookupLast: (symbol: string) => number | null): InvestorAgg[] {
  const m = new Map<string, InvestorAgg>();
  for (const g of groups) {
    const r = g.parent;
    const key = r.client_account && r.client_account.trim().length > 0 ? r.client_account : "—";
    const last = lookupLast(r.symbol);
    const px = typeof last === "number" && Number.isFinite(last) ? last : (r.avg_fill_price ?? r.limit_price ?? 0);
    const marketValue = px * r.qty;
    const existing = m.get(key);
    if (existing) {
      existing.marketValue += marketValue;
      existing.holdingsCount += 1;
    } else {
      m.set(key, { key, email: key, client: key, marketValue, holdingsCount: 1 });
    }
  }
  return [...m.values()].sort((a, b) => b.marketValue - a.marketValue);
}

const COLS = 16;

/** Shared Cancel/Amend action surface, threaded from ExecutionView down into GroupRow. */
interface OrderActions {
  cancelInFlight: Record<string, boolean>;
  cancelError: Record<string, string>;
  handleCancel: (row: ExecutionRow) => void;
  fillInFlight: Record<string, boolean>;
  fillError: Record<string, string>;
  handleFillUat: (row: ExecutionRow) => void;
  uatScope: boolean;
  amendOpen: Record<string, boolean>;
  amendForm: Record<string, { priceRands: string; volume: string; tif: "DAY" | "GTC" | "IOC" | "FOK" }>;
  setAmendForm: React.Dispatch<
    React.SetStateAction<Record<string, { priceRands: string; volume: string; tif: "DAY" | "GTC" | "IOC" | "FOK" }>>
  >;
  amendInFlight: Record<string, boolean>;
  amendError: Record<string, string>;
  openAmend: (row: ExecutionRow) => void;
  closeAmend: (auditId: string) => void;
  submitAmend: (row: ExecutionRow) => void;
}

/**
 * One logical order (an `order_id`-deduped `GroupedRow`) — the exact same
 * row rendering ExecutionView always had, now the leaf content of the
 * "Holdings under {Strategy}" tree instead of the table's top-level content.
 * Unchanged columns/actions/lifecycle-timeline/amend-form.
 */
function GroupRow({
  g,
  lookupLast,
  expanded,
  toggleExpanded,
  actions,
}: {
  g: GroupedRow;
  lookupLast: (symbol: string) => number | null;
  expanded: Record<string, boolean>;
  toggleExpanded: (key: string) => void;
  actions: OrderActions;
}) {
  const r = g.parent;
  const liveLast = lookupLast(r.symbol);
  const effectiveLast = typeof liveLast === "number" && Number.isFinite(liveLast) ? liveLast : r.avg_fill_price;
  const liveSlipCents =
    r.limit_price != null && typeof effectiveLast === "number" && Number.isFinite(effectiveLast)
      ? Math.round((r.limit_price - effectiveLast) * 100)
      : r.slippage_cents;
  const slipDisplay = liveSlipCents == null ? "—" : `${liveSlipCents > 0 ? "+" : ""}${(liveSlipCents / 100).toFixed(2)}`;
  const groupKey = (r.order_id || r.id || "").trim();
  const isExpanded = !!expanded[groupKey];
  const toggle = () => toggleExpanded(groupKey);
  const childCount = g.children.length;
  const {
    cancelInFlight,
    cancelError,
    handleCancel,
    fillInFlight,
    fillError,
    handleFillUat,
    uatScope,
    amendOpen,
    amendForm,
    setAmendForm,
    amendInFlight,
    amendError,
    openAmend,
    closeAmend,
    submitAmend,
  } = actions;

  return (
    <React.Fragment key={`grp:${groupKey}`}>
      <tr className={cn("border-b border-border/40 hover:bg-accent/10", childCount > 0 && "bg-accent/5")}>
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
        <td className="px-3 py-1.5 text-[11px] text-muted-foreground whitespace-nowrap">{fmtTs(r.ts)}</td>
        <td className="px-3 py-1.5 whitespace-nowrap">
          <Badge variant={r.side === "SELL" ? "destructive" : "success"}>{r.side}</Badge>
        </td>
        <td className="px-3 py-1.5 text-[12px] font-semibold text-foreground whitespace-nowrap">{r.symbol}</td>
        <td className="px-3 py-1.5 text-[11px] text-muted-foreground whitespace-nowrap">{r.client_account || "—"}</td>
        <td className="px-3 py-1.5 text-[12px] text-foreground whitespace-nowrap">{fmtQty(r.qty)}</td>
        <td className="px-3 py-1.5 text-[12px] font-medium text-foreground whitespace-nowrap">
          {(() => {
            // Prefer the limit, then the actual fill, then the live
            // last price — so MARKET orders (no limit, unfilled)
            // still show an estimated notional instead of "—".
            const px =
              r.limit_price ?? (r.filled > 0 ? r.avg_fill_price : null) ?? (typeof liveLast === "number" ? liveLast : null);
            return px != null && Number.isFinite(px) ? fmtMoney(px * r.qty) : "—";
          })()}
        </td>
        <td className="px-3 py-1.5 text-[12px] text-foreground whitespace-nowrap">{fmtPct(r.filled_pct)}</td>
        <td className="px-3 py-1.5 text-[12px] text-foreground whitespace-nowrap">
          <div className="flex flex-col items-start gap-0.5">
            <span>{fmtMoney(r.limit_price)}</span>
            {r.order_type ? (
              <span
                className={cn(
                  "inline-flex items-center rounded px-1 py-0 text-[9px] font-semibold uppercase tracking-wider",
                  r.order_type === "limit" ? "bg-primary/10 text-primary" : "bg-warning/15 text-warning",
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
        <td className={cn("px-3 py-1.5 text-[12px] font-semibold whitespace-nowrap", slipColor(liveSlipCents))}>
          {slipDisplay}
        </td>
        <td className="px-3 py-1.5 text-[11px] text-muted-foreground whitespace-nowrap">{r.tif}</td>
        <td className="px-3 py-1.5 whitespace-nowrap">
          <div className="flex flex-col items-start gap-0.5">
            <span title={stateTooltip(r)} className="inline-flex">
              <Badge variant={STATE_VARIANT[r.state] ?? "outline"}>{r.state}</Badge>
            </span>
            {/* 2026-07-14: surface the IRESS broker-side active / inactive
                flag (Hermes OrderState) as a tiny secondary chip. Distinct
                from the lifecycle state — a fully-filled order is INACTIVE
                but "FILLED". */}
            {r.broker_state && r.broker_state !== "UNKNOWN" ? (
              <span
                className={cn(
                  "inline-flex items-center rounded-full px-1.5 py-0 text-[9px] font-semibold uppercase tracking-wider",
                  r.broker_state === "ACTIVE" ? "bg-success/15 text-success" : "bg-muted text-muted-foreground",
                )}
                title={`Hermes OrderState: ${r.broker_state}`}
              >
                {r.broker_state === "ACTIVE" ? "● active" : "○ inactive"}
              </span>
            ) : null}
            {/* 2026-07-14: pre-trade limit-guard stamp from the BFF
                send-to-market. The IRESS broker does NOT block naked
                shorts (Andre, 28:22-34:32). */}
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
            {r.state === "FAILED" && r.iress_error_number != null ? (
              <span className="text-[9px] text-destructive/90" title={r.iress_error_description ?? undefined}>
                IRESS {r.iress_error_number}
                {r.iress_error_description ? `: ${r.iress_error_description}` : null}
              </span>
            ) : null}
          </div>
        </td>
        <td className="px-3 py-1.5 whitespace-nowrap">
          {/* Fill (UAT) — self-fill in the OEM, never sent to the broker. Shown
              for UAT-lane orders that aren't terminal. See handleFillUat. */}
          {allowsUatSelfFill(uatScope ? "uat" : undefined, r.source) && !TERMINAL_STATES.has(r.state) ? (
            <div className="mb-1 flex flex-col gap-1">
              <Button
                variant="ghost"
                size="sm"
                disabled={!!fillInFlight[r.id]}
                onClick={() => void handleFillUat(r)}
                className="h-7 px-2 text-[10px] uppercase tracking-wider text-success hover:bg-success/10"
                title="Self-fill this UAT order in the OEM (fills from us — never sent to LONGMARK)."
              >
                {fillInFlight[r.id] ? (
                  <>
                    <Loader2 className="mr-1 h-2.5 w-2.5 animate-spin" />
                    filling…
                  </>
                ) : (
                  <>
                    <Pencil className="mr-1 h-3 w-3" />
                    Fill
                  </>
                )}
              </Button>
              {fillError[r.id] ? (
                <span className="text-[9px] text-destructive" title={fillError[r.id] ?? undefined}>
                  {fillError[r.id]}
                </span>
              ) : null}
            </div>
          ) : null}
          {isCancellable(r.state) ? (
            <div className="flex flex-col gap-1">
              <div className="flex gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={!!cancelInFlight[r.id]}
                  onClick={() => void handleCancel(r)}
                  className="h-7 px-2 text-[10px] uppercase tracking-wider text-destructive hover:bg-destructive/10"
                  title={
                    r.state === "PARKED"
                      ? "Cancel this parked order — never left our system, so this just marks it cancelled locally. No broker contact."
                      : `Cancel order ${r.order_id} on IRESS (OrderDelete via worker).`
                  }
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
              <span className="text-[9px] text-muted-foreground">Actions locked until Hermes acknowledges</span>
            </div>
          ) : (
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground">—</span>
          )}
        </td>
      </tr>
      {isExpanded && childCount > 0 ? (
        <tr key={`${groupKey}-lifecycle`} className="border-b border-border/40 bg-accent/10">
          <td colSpan={COLS} className="px-3 py-2">
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
                    const cPct = cOrdVol > 0 ? `${((cFilled / cOrdVol) * 100).toFixed(cFilled > 0 ? 1 : 0)}%` : "—";
                    return (
                      <tr key={c.id} className="border-t border-border/30 hover:bg-accent/10">
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
                        <td className="px-2 py-1 text-[10px] text-muted-foreground whitespace-nowrap">{c.sent_by ?? "—"}</td>
                        <td className="px-2 py-1 text-[10px] text-muted-foreground whitespace-nowrap">{c.source ?? "—"}</td>
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
          <td colSpan={COLS} className="px-3 py-2">
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
                    className={cn("h-7 w-24 text-[11px]", r.order_type === "market" && "cursor-not-allowed opacity-60")}
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
                      r.order_type === "market" ? "MKT — not amendable" : r.limit_price != null ? String(r.limit_price) : "—"
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
                  MARKET order — price amendments are blocked at the broker. Volume / TIF will amend; for a limit price,
                  cancel and re-create. State flips to AMEND_PENDING on submit, then back to WORKING/PARTIAL on broker ack —
                  partial fills preserved.
                </span>
              ) : (
                <span className="text-[10px] text-muted-foreground">
                  Only changed fields are sent to the broker (OrderAmend2 is partial). State flips to AMEND_PENDING on
                  submit, then back to WORKING/PARTIAL on broker ack — partial fills preserved.
                </span>
              )}
            </div>
          </td>
        </tr>
      ) : null}
    </React.Fragment>
  );
}

// Book/strategy labels that are NOT a real multi-security strategy — see
// `buildOrderBookDisplayItems`'s doc comment. Independent of `sources`
// (which controls what gets FETCHED, not how a fetched row is DISPLAYED):
// a basket buy can mint any strategy display name, so that side must stay
// open-ended, but these two sentinel labels are fixed regardless.
const RAW_BOOK_IDS = ["UAT-ADHOC", "CLIENT-BUY"];

export function ExecutionView({ sources, scope }: { sources: string[]; scope?: "live" | "uat" }) {
  // 2026-07-23: fetch by SOURCE, not book_id — book_id/strategy is open-
  // ended (any basket's display name), so a fixed list of book ids to poll
  // can never cover a new strategy. `source` is a small, stable dimension
  // (UAT_ADHOC_ORDER, MINT_CLIENT_ORDER, ...); filtering by it returns
  // every current AND future strategy's orders in ONE query with zero code
  // change when a new basket is bought. See execution/route.ts.
  const sourceParam = sources.join(",");
  const scopeParam = scope ? `&scope=${scope}` : "";
  const executions = usePolling<ExecutionPayload>(
    `/api/admin/orderbook/execution?source=${encodeURIComponent(sourceParam)}${scopeParam}`,
    { interval: 2_000, deps: [sourceParam, scope] },
  );

  // CRM-style order-book numbering (2026-07-23). Books change far less
  // often than fills, so this polls lighter than the 2s execution poll.
  const orderBooks = usePolling<OrderBooksPayload>("/api/admin/orderbook/order-books", { interval: 5_000 });
  const books = orderBooks.data?.books ?? [];

  // Local override layer so SSE deltas update instantly without waiting for
  // the next poll cycle. Keyed by audit row id.
  const [liveOverrides, setLiveOverrides] = React.useState<Record<string, ExecutionRow>>({});
  // When each optimistic override was applied (client clock). Read by the poll
  // reconciliation to decide whether a same-fills poll observation is newer than
  // the override. A ref (not state) so writes don't trigger a re-render.
  const overrideAppliedAtRef = React.useRef<Record<string, number>>({});
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

  const applyDelta = React.useCallback(
    (d: UatDelta) => {
      // 2026-07-23: no book_id filter here anymore — this is the ONE panel
      // showing every UAT-relevant book/strategy now (see the `sources`
      // fetch above), so there's no sibling instance for a delta to "leak"
      // into. Every delta the SSE stream publishes is relevant here.
      setLastEventAt(new Date().toISOString());
      if (!d.order_audit_id) return;
      overrideAppliedAtRef.current[d.order_audit_id] = Date.now();
      setLiveOverrides((prev) => {
        const existing = prev[d.order_audit_id as string];
        const qty = d.qty > 0 ? d.qty : (existing?.qty ?? 0);
        const filled = d.filled;
        const filledPct = qty > 0 ? Math.min(100, (filled / qty) * 100) : 0;
        const avgFill = d.avg_fill_price_cents != null ? d.avg_fill_price_cents / 100 : (existing?.avg_fill_price ?? null);
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
          order_book_seq: existing?.order_book_seq ?? null,
          order_id: d.iress_order_number || existing?.order_id || auditId,
          client_account: existing?.client_account ?? "",
          broker_account: existing?.broker_account ?? null,
          ts: d.timestamp,
          updated_at: d.timestamp,
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
            existing?.limit_price != null && avgFill != null ? Math.round((existing.limit_price - avgFill) * 100) : null,
          day1_pnl_cents:
            existing?.limit_price != null && avgFill != null
              ? Math.round((existing.limit_price - avgFill) * 100) * filled
              : null,
          venue: existing?.venue ?? "JSE",
          tif: existing?.tif ?? "DAY",
          sent_by: existing?.sent_by ?? null,
          state: stateUppercaseToDb(d.state),
          broker: existing?.broker ?? "JSE",
          broker_state:
            rawDelta.brokerState === "ACTIVE" || rawDelta.brokerState === "INACTIVE"
              ? (rawDelta.brokerState as "ACTIVE" | "INACTIVE")
              : existing?.broker_state ?? null,
          action_status: rawDelta.actionStatus ?? existing?.action_status ?? null,
          internal_order_status: rawDelta.internalOrderStatus ?? existing?.internal_order_status ?? null,
          state_description: rawDelta.stateDescription ?? existing?.state_description ?? null,
          remaining_volume: rawDelta.remainingVolume ?? existing?.remaining_volume ?? null,
          remaining_value_cents: rawDelta.remainingValueCents ?? existing?.remaining_value_cents ?? null,
          order_value_cents: rawDelta.orderValueCents ?? existing?.order_value_cents ?? null,
          iress_error_number: existing?.iress_error_number ?? null,
          iress_error_description: existing?.iress_error_description ?? null,
          last_action: d.last_action ?? existing?.last_action ?? null,
          last_action_at: d.last_action_at ?? existing?.last_action_at ?? null,
        };
        return { ...prev, [d.order_audit_id as string]: newRow };
      });
    },
    [],
  );

  /* Subscribe unconditionally. This used to be `useUatStream(uatEnabled, …)`,
     so on production — where the real orders are — the browser never opened
     the stream and fills only appeared on the next poll. The route now 503s
     only when the worker is unconfigured, and the client already retries on
     error, so an unconfigured worker degrades to polling exactly as before. */
  const stream = useUatStream(true, applyDelta);

  const polledRows = executions.data?.rows ?? [];

  // Reconcile optimistic overrides against the poll (SSE-independent, so it works
  // in production where SSE is off). Drop an override when the matched poll row
  // (by id OR order_id — the prod poller delete-inserts and churns the audit PK)
  // is terminal, saw more fills, or is a newer/equal-state observation. Never
  // regresses fills the override already shows, and never masks a raced-in fill.
  const survivingOverrides = React.useMemo(() => {
    const keys = Object.keys(liveOverrides);
    if (keys.length === 0) return liveOverrides;
    const byId = new Map<string, ExecutionRow>();
    const byOrderId = new Map<string, ExecutionRow>();
    for (const r of polledRows) {
      byId.set(r.id, r);
      const k = (r.order_id || "").trim();
      if (!k) continue;
      const cur = byOrderId.get(k);
      if (
        !cur ||
        (TERMINAL_STATES.has(r.state) && !TERMINAL_STATES.has(cur.state)) ||
        (TERMINAL_STATES.has(r.state) === TERMINAL_STATES.has(cur.state) && obsTime(r) >= obsTime(cur))
      )
        byOrderId.set(k, r);
    }
    const out: Record<string, ExecutionRow> = {};
    for (const k of keys) {
      const ov = liveOverrides[k];
      if (!ov) continue;
      // A confirmed-CANCELLED override must drop off the live blotter — the poll
      // now excludes cancelled rows (they live on the Cancelled tab), so keeping
      // the optimistic override would leave a ghost the poll never refreshes.
      // CANCEL_PENDING stays: that order is still at the broker until confirmed.
      if (ov.state === "CANCELLED") continue;
      const p = byId.get(k) ?? byOrderId.get((ov.order_id || "").trim());
      if (!p) {
        out[k] = ov;
        continue;
      }
      if (TERMINAL_STATES.has(p.state)) continue;
      const pF = p.filled ?? 0;
      const oF = ov.filled ?? 0;
      if (pF > oF) continue;
      if (pF === oF) {
        if (p.state === ov.state) continue;
        if (obsTime(p) > (overrideAppliedAtRef.current[k] ?? 0)) continue;
      }
      out[k] = ov;
    }
    return out;
  }, [liveOverrides, polledRows]);

  // Merge surviving overrides onto polled rows (by id, then order_id), appending
  // only overrides the poll hasn't surfaced at all.
  const rows = React.useMemo(() => {
    const keys = Object.keys(survivingOverrides);
    if (keys.length === 0) return polledRows;
    const ovByOrderId = new Map<string, ExecutionRow>();
    for (const o of Object.values(survivingOverrides)) {
      const k = (o.order_id || "").trim();
      if (k && !ovByOrderId.has(k)) ovByOrderId.set(k, o);
    }
    const used = new Set<string>();
    const merged = polledRows.map((r) => {
      const byId = survivingOverrides[r.id];
      if (byId) {
        used.add(r.id);
        return byId;
      }
      const byOrder = ovByOrderId.get((r.order_id || "").trim());
      if (byOrder && !used.has(byOrder.id)) {
        used.add(byOrder.id);
        return byOrder;
      }
      return r;
    });
    const polledIds = new Set(polledRows.map((r) => r.id));
    const polledOrderIds = new Set(polledRows.map((r) => (r.order_id || "").trim()));
    const extra = Object.values(survivingOverrides).filter(
      (o) => !used.has(o.id) && !polledIds.has(o.id) && !polledOrderIds.has((o.order_id || "").trim()),
    );
    return [...extra, ...merged];
  }, [polledRows, survivingOverrides]);

  const symbols = React.useMemo(() => rows.map((r) => r.symbol).filter(Boolean), [rows]);

  // Live tick: poll `/api/quotes` for the symbols on screen every 2s. We
  // intentionally fire this ONLY when there's at least one symbol so a
  // closed book doesn't hit the BFF for nothing.
  const quotesUrl = symbols.length ? `/api/quotes?symbols=${encodeURIComponent(symbols.join(","))}&exchange=JSE` : null;
  const quotes = usePolling<QuotesPayload>(quotesUrl ?? "about:blank", {
    interval: 2_000,
    deps: [symbols.join(",")],
    query: { enabled: symbols.length > 0 },
  });

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

  // Group rows by `order_id` (the IRESS OrderNumber) — this is the "logical
  // order" unit. When the OrderNumber is the same across multiple audit rows
  // (BFF-seeded pre-worker row + worker-poll row), they collapse into one
  // parent row + a chevron that expands the lifecycle timeline.
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
      out.push({ parent: parent!, children });
    }
    out.sort((a, b) => Date.parse(b.parent.ts || "") - Date.parse(a.parent.ts || ""));
    return out;
  }, [rows]);

  // NEW: group logical orders by strategy (fallback: originating book id) —
  // a pure view over the already-reconciled groupedRows. Never re-runs
  // SSE/poll reconciliation per group; strategy grouping happens strictly
  // AFTER groupedRows is computed above.
  const liveGroupedRows = React.useMemo(() => filterOutPromotedBooks(groupedRows, books), [groupedRows, books]);
  const strategyBlocks = React.useMemo(() => groupOrdersByStrategy(liveGroupedRows), [liveGroupedRows]);
  const liveBookSequence = React.useMemo(() => computeLiveBookSequence(books), [books]);
  const displayItems = React.useMemo(
    () => buildOrderBookDisplayItems(strategyBlocks, RAW_BOOK_IDS),
    [strategyBlocks],
  );

  const [expandedStrategy, setExpandedStrategy] = React.useState<Record<string, boolean>>({});
  const [expandedSecurity, setExpandedSecurity] = React.useState<Record<string, boolean>>({});
  const [selectedInvestorByStrategy, setSelectedInvestorByStrategy] = React.useState<Record<string, string | null>>({});

  const toggleStrategy = (key: string) => setExpandedStrategy((p) => ({ ...p, [key]: !p[key] }));
  const toggleSecurity = (key: string) => setExpandedSecurity((p) => ({ ...p, [key]: !p[key] }));

  // Expansion state for the per-order lifecycle timeline — order_id →
  // expanded. Default collapsed; auto-expand when a NEW SSE delta lands so
  // the operator sees the lifecycle event as it happens (Andre, 2026-07-13).
  const [expanded, setExpanded] = React.useState<Record<string, boolean>>({});
  const toggleGroupExpanded = (key: string) => setExpanded((p) => ({ ...p, [key]: !p[key] }));
  const prevLiveCountRef = React.useRef<number>(0);
  React.useEffect(() => {
    const currentCount = Object.keys(liveOverrides).length;
    if (currentCount > prevLiveCountRef.current) {
      setExpanded((prev) => {
        const next = { ...prev };
        for (const o of Object.values(liveOverrides)) {
          const key = (o.order_id || o.id || "").trim();
          if (key) next[key] = true;
        }
        return next;
      });
      // Auto-expand the strategy + security containing the delta too, so a
      // live fill on a collapsed strategy doesn't go unnoticed.
      setExpandedStrategy((prev) => {
        const next = { ...prev };
        for (const o of Object.values(liveOverrides)) {
          const key = o.strategy || "Unassigned";
          next[key] = true;
        }
        return next;
      });
    }
    prevLiveCountRef.current = currentCount;
  }, [liveOverrides]);

  const totalEvents = React.useMemo(
    () => liveGroupedRows.reduce((s, g) => s + 1 + g.children.length, 0),
    [liveGroupedRows],
  );

  // Per-row cancel state. When the desk clicks Cancel on a row, we POST
  // /api/admin/orderbook/cancel which forwards to the worker's
  // /orders/cancel (OrderDelete). The handler optimistically flips the
  // row to CANCEL_PENDING in `liveOverrides` so the UI updates instantly;
  // the SSE delta from the worker confirms the transition on the next push.
  // Fill (UAT) — self-fill a UAT order in the OEM, exactly like the CRM does.
  // Posts to /api/admin/orderbook/fills (a pure DB write) — NO worker/IRESS/
  // broker contact. UAT orders can only ever be filled this way (see
  // uat-guard.ts: they are structurally refused by every send-to-broker path).
  const [fillInFlight, setFillInFlight] = React.useState<Record<string, boolean>>({});
  const [fillError, setFillError] = React.useState<Record<string, string>>({});
  const handleFillUat = React.useCallback(async (row: ExecutionRow) => {
    const orderId = (row.order_id || "").trim();
    if (!orderId) {
      setFillError((p) => ({ ...p, [row.id]: "No order id to fill against." }));
      return;
    }
    // Fill price (Rands): prefer the order's limit, else the last/avg price,
    // else ask. Market UAT orders (no limit) prompt for a self-fill price.
    let priceRands = row.limit_price ?? row.avg_fill_price ?? null;
    if (priceRands == null || !(priceRands > 0)) {
      const entered = typeof window !== "undefined" ? window.prompt(`Self-fill price in Rands for ${row.symbol} (UAT)?`) : null;
      const n = entered == null ? Number.NaN : Number(entered);
      if (!Number.isFinite(n) || n <= 0) return;
      priceRands = n;
    }
    setFillInFlight((p) => ({ ...p, [row.id]: true }));
    setFillError((p) => ({ ...p, [row.id]: "" }));
    try {
      const res = await fetch("/api/admin/orderbook/fills", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          order_id: orderId,
          fills: [{ symbol: row.symbol, qty: row.qty, avg_fill_price_cents: Math.round(priceRands * 100), timestamp: new Date().toISOString() }],
        }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        settlement?: { attempted: number; ok: number; failed: Array<{ error?: string }> };
      };
      if (!res.ok || body.ok === false) {
        setFillError((p) => ({ ...p, [row.id]: body.error ?? `Fill returned ${res.status}` }));
      } else if (body.settlement && body.settlement.failed.length > 0) {
        // Fill itself succeeded, but the auto-settlement call to MyMintAdmin
        // failed — surface it rather than silently leaving the holding open.
        setFillError((p) => ({
          ...p,
          [row.id]: `Filled, but auto-settlement failed: ${body.settlement!.failed[0]?.error ?? "unknown error"}`,
        }));
      }
    } catch (err) {
      setFillError((p) => ({ ...p, [row.id]: err instanceof Error ? err.message : String(err) }));
    } finally {
      setFillInFlight((p) => ({ ...p, [row.id]: false }));
    }
  }, []);

  const [cancelInFlight, setCancelInFlight] = React.useState<Record<string, boolean>>({});
  const [cancelError, setCancelError] = React.useState<Record<string, string>>({});
  const handleCancel = React.useCallback(async (row: ExecutionRow) => {
    const auditId = row.id;

    // A PARKED row has never left our system — zero broker/worker contact —
    // so "cancel" here is a pure local status flip (cancel-parked/route.ts),
    // not a real OrderDelete. Kills a wrong order before "Send to Market"
    // ever sends it anywhere; important now that real (allowlisted)
    // production accounts can park orders too, not just test accounts.
    if (row.state === "PARKED") {
      setCancelInFlight((p) => ({ ...p, [auditId]: true }));
      setCancelError((p) => ({ ...p, [auditId]: "" }));
      overrideAppliedAtRef.current[auditId] = Date.now();
      setLiveOverrides((p) => ({
        ...p,
        [auditId]: { ...(p[auditId] ?? row), state: "CANCELLED" },
      }));
      try {
        const res = await fetch("/api/admin/orderbook/cancel-parked", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ order_audit_id: auditId }),
        });
        const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
        if (!res.ok || body.ok === false) {
          setCancelError((p) => ({ ...p, [auditId]: body.error ?? `Cancel returned ${res.status}` }));
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setCancelError((p) => ({ ...p, [auditId]: msg }));
      } finally {
        setCancelInFlight((p) => ({ ...p, [auditId]: false }));
      }
      return;
    }

    const accountGuess =
      (typeof row.broker_account === "string" && row.broker_account.length > 0 ? row.broker_account : null) ??
      (typeof row.client_account === "string" && row.client_account.length > 0 ? row.client_account : "56378");
    const iressOrderNumber = row.order_id;
    if (!iressOrderNumber) return;
    setCancelInFlight((p) => ({ ...p, [auditId]: true }));
    setCancelError((p) => ({ ...p, [auditId]: "" }));
    overrideAppliedAtRef.current[auditId] = Date.now();
    setLiveOverrides((p) => ({
      ...p,
      [auditId]: { ...(p[auditId] ?? row), state: "CANCEL_PENDING" },
    }));
    try {
      const res = await fetch("/api/admin/orderbook/cancel", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ account: accountGuess, order_number: iressOrderNumber }),
      });
      if (!res.ok && res.status >= 500) {
        setCancelError((p) => ({ ...p, [auditId]: `Cancel endpoint returned ${res.status}` }));
      } else {
        const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; message?: string };
        if (body && body.ok === false) {
          setCancelError((p) => ({ ...p, [auditId]: body.message ?? body.error ?? "Cancel failed" }));
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setCancelError((p) => ({ ...p, [auditId]: msg }));
    } finally {
      setCancelInFlight((p) => ({ ...p, [auditId]: false }));
    }
  }, []);

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
        priceRands: row.limit_price != null ? String(row.limit_price) : "",
        volume: String(row.qty || ""),
        tif: row.tif === "DAY" || row.tif === "GTC" || row.tif === "IOC" || row.tif === "FOK" ? row.tif : "DAY",
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
        (typeof row.broker_account === "string" && row.broker_account.length > 0 ? row.broker_account : null) ??
        (typeof row.client_account === "string" && row.client_account.length > 0 ? row.client_account : "56378");
      const iressOrderNumber = row.order_id;
      if (!iressOrderNumber) return;
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
      if (row.order_type === "market" && px != null && Number.isFinite(px)) {
        setAmendError((p) => ({
          ...p,
          [auditId]:
            "MARKET orders cannot have their price amended via OrderAmend2 — cancel and re-create the order to set a limit price. Volume / TIF will still amend.",
        }));
        setAmendInFlight((p) => ({ ...p, [auditId]: false }));
        return;
      }
      overrideAppliedAtRef.current[auditId] = Date.now();
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
          setAmendError((p) => ({ ...p, [auditId]: `Amend endpoint returned ${res.status}` }));
        } else {
          const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; message?: string };
          if (data && data.ok === false) {
            setAmendError((p) => ({ ...p, [auditId]: data.message ?? data.error ?? "Amend failed" }));
          } else {
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

  const orderActions: OrderActions = {
    cancelInFlight,
    cancelError,
    handleCancel,
    fillInFlight,
    fillError,
    handleFillUat,
    uatScope: scope === "uat",
    amendOpen,
    amendForm,
    setAmendForm,
    amendInFlight,
    amendError,
    openAmend,
    closeAmend,
    submitAmend,
  };

  // "Send to Market (N)" — releases parked mint client-orders. Ported from
  // the now-retired uat-basket-book.tsx: parked count derived from the same
  // already-reconciled `rows` (zero extra fetch), release POSTs to the
  // existing release-to-market route and relies on the 2s poll to reflect
  // the new state (no manual refetch needed).
  const parkedCount = React.useMemo(() => rows.filter((r) => r.state === "PARKED").length, [rows]);
  const [releasing, setReleasing] = React.useState(false);
  const handleRelease = async () => {
    if (SEND_TO_MARKET_LOCKED) {
      toast.error(SEND_TO_MARKET_LOCKED_MESSAGE);
      return;
    }
    setReleasing(true);
    try {
      const res = await fetch("/api/admin/orderbook/release-to-market", { method: "POST" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(body?.error ?? "Send to Market failed.");
        return;
      }
      if (body.released > 0 && body.failed === 0) {
        toast.success(`Sent ${body.released} order${body.released !== 1 ? "s" : ""} to market.`);
      } else if (body.released > 0 && body.failed > 0) {
        toast.message(`Sent ${body.released}, ${body.failed} still parked (blocked by guard — will retry next click).`);
      } else if (body.failed > 0) {
        toast.error(`${body.failed} order${body.failed !== 1 ? "s" : ""} blocked — still parked.`);
      } else {
        toast.message(body.notice ?? "No parked orders to release.");
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Send to Market failed.");
    } finally {
      setReleasing(false);
    }
  };

  const showLoading = executions.loading && liveGroupedRows.length === 0;
  const hasNotice = !!executions.data?.notice;
  const anyLoading = executions.loading;
  const refreshAll = () => {
    void executions.refresh();
    void orderBooks.refresh();
  };

  return (
    <div className="w-full min-w-0 max-w-full rounded-xl border border-border bg-card/40 overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2.5">
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Per-ISIN execution
          </span>
          {/* 2026-07-23: CRM-style "Orderbook :NN" sequence — real number now.
              One book = everything released together in one "Send to
              Market" click (release-to-market/route.ts stamps
              payload.order_book_seq on each released row and inserts one
              oems_order_book row per batch). "Fully filled" (every member
              order status='filled') is computed at read time in
              /api/admin/orderbook/order-books — once true, that book's
              orders are filtered out of this live view (see
              filterOutPromotedBooks below) and instead show up in the
              separate ActiveOrderBooks list. */}
          <Badge
            variant="outline"
            className="font-mono"
            title="CRM-style order-book number — advances once the current book is fully filled and moves to Active Order Books."
          >
            Orderbook :{String(liveBookSequence).padStart(2, "0")}
          </Badge>
          <Badge variant="outline" className="font-mono">
            {liveGroupedRows.length}
          </Badge>
          {totalEvents !== liveGroupedRows.length ? (
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground">({totalEvents} events)</span>
          ) : null}
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
            source{sources.length > 1 ? "s" : ""} {sources.join(", ")}
          </span>
          <DataSourceBadge source="hybrid" db="institutional" />
          {uatEnabled ? (
            <span
              className={cn(
                "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider",
                stream.connected ? "bg-success/15 text-success" : "bg-muted text-muted-foreground",
              )}
              title={
                stream.connected
                  ? `Live fill deltas via SSE. Last event ${lastEventAt ? timeSince(lastEventAt) : "—"}`
                  : "SSE disconnected — fill deltas paused. The 2s poll still updates fills."
              }
            >
              <Radio className={cn("h-3 w-3", stream.connected && "animate-pulse")} />
              {stream.connected ? "LIVE" : "OFFLINE"}
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          {anyLoading && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
          {quotes.loading && (
            <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wider text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" />
              ticking…
            </span>
          )}
          {allowsMarketRelease(scope) ? (
            <Button
              variant="secondary"
              size="sm"
              disabled={SEND_TO_MARKET_LOCKED || parkedCount === 0 || releasing}
              onClick={() => void handleRelease()}
              title={SEND_TO_MARKET_LOCKED ? SEND_TO_MARKET_LOCKED_MESSAGE : "Release every parked mint client-order to the worker/IRESS."}
            >
              <SendHorizontal className="h-3.5 w-3.5" />
              {releasing ? "Sending..." : SEND_TO_MARKET_LOCKED ? "Send to Market (locked)" : `Send to Market (${parkedCount})`}
            </Button>
          ) : null}
          <Button variant="ghost" size="sm" onClick={refreshAll}>
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
                "Client",
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
                <td colSpan={COLS} className="px-3 py-10 text-center text-[12px] text-muted-foreground">
                  Loading executions…
                </td>
              </tr>
            ) : displayItems.length === 0 ? (
              <tr>
                <td colSpan={COLS} className="px-3 py-10 text-center text-[12px] text-muted-foreground">
                  No execution rows for this book yet — click <em>Send to Market</em> to dispatch.
                </td>
              </tr>
            ) : (
              displayItems.map((item) => {
                if (item.type === "order") {
                  return (
                    <GroupRow
                      key={item.group.parent.id}
                      g={item.group}
                      lookupLast={lookupLast}
                      expanded={expanded}
                      toggleExpanded={toggleGroupExpanded}
                      actions={orderActions}
                    />
                  );
                }
                const block = item.block;
                const strategyKey = block.strategy;
                const isGiftOrder = isGiftOrderBlock(strategyKey);
                const isStrategyOpen = !!expandedStrategy[strategyKey];
                const totalOrders = block.groups.length;
                const totalQty = block.groups.reduce((s, g) => s + g.parent.qty, 0);
                const totalValue = block.groups.reduce((s, g) => {
                  const px = g.parent.limit_price ?? g.parent.avg_fill_price ?? 0;
                  return s + px * g.parent.qty;
                }, 0);
                const latestTs = block.groups.reduce((max, g) => Math.max(max, Date.parse(g.parent.ts || "") || 0), 0);
                const investors = buildInvestorAgg(block.groups, lookupLast);
                const selectedInvestor = selectedInvestorByStrategy[strategyKey] ?? null;
                const visibleGroups = selectedInvestor
                  ? block.groups.filter((g) => (g.parent.client_account || "—") === selectedInvestor)
                  : block.groups;
                const securityBlocks = buildSecurityBlocks(visibleGroups);

                return (
                  <React.Fragment key={`strategy:${strategyKey}`}>
                    <tr
                      className="cursor-pointer border-b border-border/60 bg-card/60 hover:bg-accent/20"
                      tabIndex={0}
                      onClick={() => toggleStrategy(strategyKey)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          toggleStrategy(strategyKey);
                        }
                      }}
                    >
                      <td className="px-2 py-1.5 whitespace-nowrap">
                        <ChevronRight
                          className={cn(
                            "h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform",
                            isStrategyOpen && "rotate-90",
                          )}
                        />
                      </td>
                      <td className="px-3 py-1.5 text-[12px] font-semibold text-foreground whitespace-nowrap" colSpan={3}>
                        <span className="inline-flex items-center gap-1.5">
                          <span className={cn(isGiftOrder && "font-mono")}>{strategyKey}</span>
                          {isGiftOrder ? (
                            <span className="rounded-full border border-violet-400/30 bg-violet-500/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-violet-300">
                              Gift order
                            </span>
                          ) : null}
                          <span className="ml-1 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                            {isGiftOrder ? (
                              <>{totalOrders} asset{totalOrders !== 1 ? "s" : ""}</>
                            ) : (
                              <>
                                {totalOrders} order{totalOrders !== 1 ? "s" : ""} · {investors.length} client
                                {investors.length !== 1 ? "s" : ""}
                              </>
                            )}
                          </span>
                        </span>
                      </td>
                      <td className="px-3 py-1.5 text-[11px] text-muted-foreground whitespace-nowrap">
                        {latestTs ? fmtTs(new Date(latestTs).toISOString()) : "—"}
                      </td>
                      <td className="px-3 py-1.5" />
                      <td className="px-3 py-1.5 text-[12px] text-foreground whitespace-nowrap">{fmtQty(totalQty)}</td>
                      <td className="px-3 py-1.5 text-[12px] font-medium text-foreground whitespace-nowrap">
                        {fmtMoney(totalValue)}
                      </td>
                      <td className="px-3 py-1.5" colSpan={8} />
                    </tr>
                    {isStrategyOpen && (
                      <>
                        {isGiftOrder ? (
                          block.groups.map((g) => (
                            <GroupRow
                              key={g.parent.id}
                              g={g}
                              lookupLast={lookupLast}
                              expanded={expanded}
                              toggleExpanded={toggleGroupExpanded}
                              actions={orderActions}
                            />
                          ))
                        ) : securityBlocks.map((sec) => {
                          const secKey = `${strategyKey}::${sec.key}`;
                          const isSecOpen = !!expandedSecurity[secKey];
                          const liveLast = lookupLast(sec.symbol);
                          return (
                            <React.Fragment key={secKey}>
                              <tr
                                className="cursor-pointer border-b border-border/30 hover:bg-accent/10"
                                tabIndex={0}
                                onClick={() => toggleSecurity(secKey)}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter" || e.key === " ") {
                                    e.preventDefault();
                                    toggleSecurity(secKey);
                                  }
                                }}
                              >
                                <td className="px-2 py-1.5 pl-6 whitespace-nowrap">
                                  <ChevronRight
                                    className={cn(
                                      "h-3 w-3 shrink-0 text-muted-foreground transition-transform",
                                      isSecOpen && "rotate-90",
                                    )}
                                  />
                                </td>
                                <td className="px-3 py-1.5 whitespace-nowrap">
                                  <span className="rounded-full bg-muted px-1.5 py-0.5 text-[9px] font-medium text-muted-foreground">
                                    {sec.groups.length}
                                  </span>
                                </td>
                                <td className="px-3 py-1.5" />
                                <td className="px-3 py-1.5 whitespace-nowrap">
                                  <Badge variant={sec.side === "SELL" ? "destructive" : "success"}>{sec.side}</Badge>
                                </td>
                                <td className="px-3 py-1.5 text-[12px] font-semibold text-foreground whitespace-nowrap">
                                  {sec.symbol}
                                </td>
                                <td className="px-3 py-1.5" />
                                <td className="px-3 py-1.5 text-[12px] text-foreground whitespace-nowrap">{fmtQty(sec.qty)}</td>
                                <td className="px-3 py-1.5 text-[12px] text-foreground whitespace-nowrap" colSpan={2}>
                                  {sec.avgFillWeighted != null ? fmtMoney(sec.avgFillWeighted) : "—"}
                                </td>
                                <td className="px-3 py-1.5 text-[12px] text-foreground whitespace-nowrap">
                                  {typeof liveLast === "number" && Number.isFinite(liveLast) ? fmtMoney(liveLast) : "—"}
                                </td>
                                <td className="px-3 py-1.5" colSpan={6} />
                              </tr>
                              {isSecOpen &&
                                sec.groups.map((g) => (
                                  <GroupRow
                                    key={g.parent.id}
                                    g={g}
                                    lookupLast={lookupLast}
                                    expanded={expanded}
                                    toggleExpanded={toggleGroupExpanded}
                                    actions={orderActions}
                                  />
                                ))}
                            </React.Fragment>
                          );
                        })}
                        {!isGiftOrder ? <tr>
                          <td colSpan={COLS} className="p-0">
                            <div className="space-y-1.5 border-t border-border/30 bg-card/20 px-4 py-3">
                              <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                                Investors in {strategyKey}
                                {selectedInvestor ? (
                                  <span className="ml-2 normal-case text-foreground">— filtered to {selectedInvestor}</span>
                                ) : (
                                  <span className="ml-2 normal-case text-muted-foreground/70">
                                    (click a row to see this client&apos;s individual fills)
                                  </span>
                                )}
                              </div>
                              <InvestorFilterTable
                                investors={investors}
                                selectedKey={selectedInvestor}
                                onSelect={(key) =>
                                  setSelectedInvestorByStrategy((p) => ({
                                    ...p,
                                    [strategyKey]: p[strategyKey] === key ? null : key,
                                  }))
                                }
                              />
                            </div>
                          </td>
                        </tr> : null}
                      </>
                    )}
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
