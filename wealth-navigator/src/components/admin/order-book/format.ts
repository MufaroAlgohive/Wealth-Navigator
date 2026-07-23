export interface Row {
  id: string;
  security_id: string | null;
  user_id: string | null;
  email: string;
  client: string;
  instrument: string;
  ticker: string;
  isin: string;
  side: string;
  qty: number;
  avgFill: number;
  expectedFill: number;
  livePrice: number;
  status: string | null;
  strategy: string | null;
  clientPnl: number;
  mintPnl: number;
  /** Execution date (ISO). Sorted desc; populated when the OEMS feed is wired. */
  date: string | null;
}

export interface StrategyGroup {
  strategy: string;
  rows: Row[];
  clientPnl: number;
  mintPnl: number;
  latest: string;
  clients: number;
}

export const R = (n: number) =>
  new Intl.NumberFormat("en-ZA", { style: "currency", currency: "ZAR", minimumFractionDigits: 2 }).format(
    Number(n || 0),
  );
export const pnlCls = (n: number) => (n >= 0 ? "text-success" : "text-destructive");
export const fmtDate = (iso: string | null) => {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "—"
    : d.toLocaleDateString("en-ZA", { day: "2-digit", month: "short", year: "numeric" });
};
export const th =
  "px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-wider text-muted-foreground whitespace-nowrap";
export const td = "px-3 py-2 text-[12px] text-foreground whitespace-nowrap";

/**
 * Order-action eligibility by lifecycle state — single source of truth,
 * shared by ExecutionView's per-order rows. Previously duplicated between
 * execution-view.tsx and the now-retired use-order-actions.ts.
 *
 * A row is "cancellable" when it's in flight at the broker — i.e. not
 * already FILLED / CANCELLED / REJECTED / EXPIRED / FAILED. PENDING_ACK is
 * excluded: per Hermes rules, once an order leaves our session it's owned by
 * the destination until acked, so we can't cancel/amend it from here yet
 * (Andre + Juan, 2026-07-15 transcript 06:35-07:46).
 */
export const isCancellable = (state: string): boolean =>
  state === "WORKING" ||
  state === "PARTIAL" ||
  state === "ACKNOWLEDGED" ||
  state === "created" ||
  state === "amended";

/** Same set as cancel, minus AMEND_PENDING (never race two broker instructions on one OrderNumber). */
export const isAmendable = (state: string): boolean => isCancellable(state) && state !== "AMEND_PENDING";

/** PENDING_ACK rows are read-only until the broker acks — actions column shows a hint instead. */
export const isAwaitingBrokerAck = (state: string): boolean => state === "PENDING_ACK";

/**
 * Group a flat holdings Row[] into per-strategy StrategyGroup[] — same
 * grouping key (strategy_name_snapshot) and sort (rows newest-first, groups
 * by latest date) as the original page.tsx grouping this was lifted from.
 */
export function groupRowsByStrategy(rows: Row[]): StrategyGroup[] {
  const m = new Map<string, Row[]>();
  for (const r of rows) {
    const k = r.strategy || "Unassigned";
    const bucket = m.get(k);
    if (bucket) bucket.push(r);
    else m.set(k, [r]);
  }
  return [...m.entries()]
    .map(([strategy, rs]) => {
      const sorted = [...rs].sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
      return {
        strategy,
        rows: sorted,
        clientPnl: rs.reduce((s, r) => s + r.clientPnl, 0),
        mintPnl: rs.reduce((s, r) => s + r.mintPnl, 0),
        latest: sorted[0]?.date ?? "",
        clients: new Set(rs.map((r) => r.email)).size,
      };
    })
    .sort((a, b) => b.latest.localeCompare(a.latest));
}
