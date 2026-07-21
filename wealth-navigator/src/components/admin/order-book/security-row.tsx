import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/cn";
import { R, type Row, pnlCls, td } from "./format";
import { IressStatusPill } from "./iress-status-pill";

export interface ExecSlice {
  holding_id: string | null;
  state: string;
  filled_pct: number;
  avg_fill_price: number | null;
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
  clientPnl: number;
  mintPnl: number;
  /** Resolved IRESS status for this security's rows — NOT_SENT / MIXED / a real lifecycle state. */
  execState: string;
  execFilledPct: number | null;
  execAvgFillPrice: number | null;
}

/**
 * Group a basket's (possibly investor-filtered) flat Row[] by security
 * (keyed by security_id, falling back to ticker+isin for older rows without
 * it), aggregating quantities/PnL the same way the basket-level group
 * already does, and resolving each security's IRESS execution state via the
 * holding_id -> ExecutionRow join. When the underlying holdings for a
 * security carry different execution states (e.g. one investor's order
 * filled, another's is still working), the state is reported as "MIXED"
 * rather than guessing at a priority order — v1 rule, not enough real
 * multi-state data yet to justify a ladder.
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
    const clientPnl = rs.reduce((s, r) => s + r.clientPnl, 0);
    const mintPnl = rs.reduce((s, r) => s + r.mintPnl, 0);

    const slices = rs.map((r) => execByHolding.get(r.id)).filter((s): s is ExecSlice => Boolean(s));
    let execState = "NOT_SENT";
    let execFilledPct: number | null = null;
    let execAvgFillPrice: number | null = null;
    const firstSlice = slices[0];
    if (firstSlice) {
      const distinctStates = new Set(slices.map((s) => s.state));
      if (distinctStates.size === 1) {
        execState = firstSlice.state;
        execFilledPct = firstSlice.filled_pct;
        execAvgFillPrice = firstSlice.avg_fill_price;
      } else {
        execState = "MIXED";
      }
    }

    out.push({
      key,
      ticker: first.ticker,
      instrument: first.instrument,
      side: first.side,
      qty,
      avgFill,
      expectedFill,
      livePrice,
      clientPnl,
      mintPnl,
      execState,
      execFilledPct,
      execAvgFillPrice,
    });
  }
  return out.sort((a, b) => b.qty - a.qty);
}

export function SecurityRow({ sec, onDeferred }: { sec: SecurityAgg; onDeferred: (label: string) => void }) {
  return (
    <tr className="border-b border-border/30 last:border-b-0 hover:bg-accent/10">
      <td className={cn(td, "pl-9")}>
        <span className="font-semibold">{sec.ticker}</span>
        <span className="ml-2 max-w-[200px] truncate align-middle text-[11px] text-muted-foreground">
          {sec.instrument}
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
          onClick={() => onDeferred("Edit fill price")}
        >
          {R(sec.avgFill)}
        </button>
      </td>
      <td className={td}>
        <button
          type="button"
          className="underline-offset-2 hover:underline"
          onClick={() => onDeferred("Edit expected fill")}
        >
          {R(sec.expectedFill)}
        </button>
      </td>
      <td className={td}>{R(sec.livePrice)}</td>
      <td className={cn(td, pnlCls(sec.clientPnl))}>{R(sec.clientPnl)}</td>
      <td className={td}>{R(sec.mintPnl)}</td>
      <td className={td}>
        <IressStatusPill
          state={sec.execState}
          filledPct={sec.execFilledPct}
          avgFillPrice={sec.execAvgFillPrice}
        />
      </td>
    </tr>
  );
}
