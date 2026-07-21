import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/cn";
import { ChevronRight } from "lucide-react";
import { R, type Row, td } from "./format";
import { IressStatusPill } from "./iress-status-pill";

export interface ExecSlice {
  holding_id: string | null;
  state: string;
  filled_pct: number;
  avg_fill_price: number | null;
  limit_price: number | null;
  slippage_cents: number | null;
  day1_pnl_cents: number | null;
}

export interface SecurityChild {
  rowId: string;
  client: string;
  side: string;
  qty: number;
  avgFill: number;
  expectedFill: number;
  livePrice: number;
  execState: string;
  execFilledPct: number | null;
  execAvgFillPrice: number | null;
  execLimitPrice: number | null;
  execSlippageCents: number | null;
  execDay1PnlCents: number | null;
}

export interface SecurityAgg {
  key: string;
  ticker: string;
  instrument: string;
  side: string;
  qty: number;
  avgFill: number;
  expectedFill: number;
  livePrice: number;
  /** The individual holdings/orders that roll up into this security's aggregate row. */
  children: SecurityChild[];
}

/**
 * Group a basket's (possibly investor-filtered) flat Row[] by security
 * (keyed by security_id, falling back to ticker+isin for older rows without
 * it). The aggregate row shows position-level totals (qty/avg fill/order
 * value/last) — those are legitimately summable across whoever holds the
 * security. Execution-level detail (limit, slip/day-1 P&L, IRESS state) is
 * NOT shown at the aggregate level — those are per-order attributes, so
 * they only render once expanded to the individual child rows.
 */
export function buildSecurityGroups(rows: Row[], execByHolding: Map<string, ExecSlice>): SecurityAgg[] {
  const m = new Map<string, { rows: Row[] }>();
  for (const r of rows) {
    const key = r.security_id || `${r.ticker}|${r.isin}`;
    let bucket = m.get(key);
    if (!bucket) {
      bucket = { rows: [] };
      m.set(key, bucket);
    }
    bucket.rows.push(r);
  }
  const out: SecurityAgg[] = [];
  for (const [key, { rows: rs }] of m) {
    const first = rs[0];
    if (!first) continue;
    const qty = rs.reduce((s, r) => s + r.qty, 0);
    const avgFill = qty > 0 ? rs.reduce((s, r) => s + r.avgFill * r.qty, 0) / qty : 0;
    const expectedFill = qty > 0 ? rs.reduce((s, r) => s + r.expectedFill * r.qty, 0) / qty : 0;
    const livePrice = first.livePrice;

    const children: SecurityChild[] = rs.map((r) => {
      const slice = execByHolding.get(r.id);
      return {
        rowId: r.id,
        client: r.client,
        side: r.side,
        qty: r.qty,
        avgFill: r.avgFill,
        expectedFill: r.expectedFill,
        livePrice: r.livePrice,
        execState: slice?.state ?? "NOT_SENT",
        execFilledPct: slice?.filled_pct ?? null,
        execAvgFillPrice: slice?.avg_fill_price ?? null,
        execLimitPrice: slice?.limit_price ?? null,
        execSlippageCents: slice?.slippage_cents ?? null,
        execDay1PnlCents: slice?.day1_pnl_cents ?? null,
      };
    });

    out.push({
      key,
      ticker: first.ticker,
      instrument: first.instrument,
      side: first.side,
      qty,
      avgFill,
      expectedFill,
      livePrice,
      children,
    });
  }
  return out.sort((a, b) => b.qty - a.qty);
}

function fmtCents(cents: number | null): string {
  if (cents == null) return "—";
  const rands = cents / 100;
  return `${rands >= 0 ? "+" : ""}${R(rands)}`;
}

export function SecurityRow({
  sec,
  expanded,
  onToggle,
  onDeferred,
}: {
  sec: SecurityAgg;
  expanded: boolean;
  onToggle: () => void;
  onDeferred: (label: string) => void;
}) {
  return (
    <>
      <tr
        className="cursor-pointer border-b border-border/30 last:border-b-0 hover:bg-accent/10"
        tabIndex={0}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onToggle();
          }
        }}
      >
        <td className={cn(td, "pl-9")}>
          <span className="inline-flex items-center gap-1.5">
            <ChevronRight
              className={cn(
                "h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform",
                expanded && "rotate-90",
              )}
            />
            <span className="font-semibold">{sec.ticker}</span>
            <span className="max-w-[200px] truncate text-[11px] text-muted-foreground">{sec.instrument}</span>
            {sec.children.length > 1 && (
              <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                {sec.children.length}
              </span>
            )}
          </span>
        </td>
        <td className={td}>
          <Badge variant={sec.side === "SELL" ? "destructive" : "success"}>{sec.side}</Badge>
        </td>
        <td className={td}>{sec.qty}</td>
        <td className={td}>
          <button
            type="button"
            className="underline-offset-2 hover:underline"
            onClick={(e) => {
              e.stopPropagation();
              onDeferred("Edit fill price");
            }}
          >
            {R(sec.avgFill)}
          </button>
        </td>
        <td className={td}>
          <button
            type="button"
            className="underline-offset-2 hover:underline"
            onClick={(e) => {
              e.stopPropagation();
              onDeferred("Edit expected fill");
            }}
          >
            {R(sec.expectedFill)}
          </button>
        </td>
        <td className={td}>{R(sec.livePrice)}</td>
        <td className={td}>—</td>
        <td className={td}>—</td>
        <td className={td} />
      </tr>
      {expanded &&
        sec.children.map((c) => (
          <tr key={c.rowId} className="border-b border-border/20 bg-accent/5 last:border-b-0">
            <td className={cn(td, "pl-16 text-[11px] text-muted-foreground")}>{c.client}</td>
            <td className={td}>
              <Badge variant={c.side === "SELL" ? "destructive" : "success"}>{c.side}</Badge>
            </td>
            <td className={td}>{c.qty}</td>
            <td className={td}>{R(c.avgFill)}</td>
            <td className={td}>{R(c.expectedFill)}</td>
            <td className={td}>{R(c.livePrice)}</td>
            <td
              className={cn(
                td,
                c.execDay1PnlCents != null && (c.execDay1PnlCents >= 0 ? "text-success" : "text-destructive"),
              )}
            >
              {fmtCents(c.execDay1PnlCents)}
            </td>
            <td className={td}>{c.execLimitPrice != null ? R(c.execLimitPrice) : "—"}</td>
            <td className={td}>
              <IressStatusPill
                state={c.execState}
                filledPct={c.execFilledPct}
                avgFillPrice={c.execAvgFillPrice}
              />
            </td>
          </tr>
        ))}
    </>
  );
}
