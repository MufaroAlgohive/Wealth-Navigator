import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/cn";
import { ChevronRight, Loader2 } from "lucide-react";
import { R, type Row } from "./format";
import { IressStatusPill } from "./iress-status-pill";
import { type UseOrderActions, isAmendable, isAwaitingBrokerAck, isCancellable } from "./use-order-actions";

// Compact cell padding for this table specifically (not the shared td/th
// from format.ts, which the outer basket table still uses) — needed to fit
// Order ID / Timestamp / Actions alongside everything else without the
// table forcing a horizontal scroll.
const ctd = "px-2 py-1.5 text-[11px] text-foreground whitespace-nowrap";
export const cth =
  "px-2 py-1.5 text-left text-[9px] font-semibold uppercase tracking-wider text-muted-foreground whitespace-nowrap";

export interface ExecSlice {
  /** The oems_order_audit row's own id — the state key for Cancel/Amend, distinct from holding_id. */
  id: string;
  holding_id: string | null;
  order_id: string | null;
  client_account: string | null;
  broker_account: string | null;
  ts: string | null;
  state: string;
  filled_pct: number;
  avg_fill_price: number | null;
  limit_price: number | null;
  slippage_cents: number | null;
  day1_pnl_cents: number | null;
  tif: string | null;
  order_type: "limit" | "market" | null;
}

export interface SecurityChild {
  rowId: string;
  client: string;
  side: string;
  qty: number;
  avgFill: number;
  expectedFill: number;
  livePrice: number;
  execAuditId: string | null;
  execOrderId: string | null;
  execTs: string | null;
  execClientAccount: string | null;
  execBrokerAccount: string | null;
  execTif: string | null;
  execOrderType: "limit" | "market" | null;
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

/** Table column count — 1 more cell than this on every row keeps the grid aligned. */
export const HOLDINGS_TABLE_COLS = 11;

/**
 * Group a basket's (possibly investor-filtered) flat Row[] by security
 * (keyed by security_id, falling back to ticker+isin for older rows without
 * it). The aggregate row shows position-level totals (qty/avg fill/order
 * value/last) — those are legitimately summable across whoever holds the
 * security. Execution-level detail (order id/timestamp, limit, slip/day-1
 * P&L, IRESS state, actions) is NOT shown at the aggregate level — those
 * are per-order attributes, so they only render once expanded to the
 * individual child rows.
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
        execAuditId: slice?.id ?? null,
        execOrderId: slice?.order_id ?? null,
        execTs: slice?.ts ?? null,
        execClientAccount: slice?.client_account ?? null,
        execBrokerAccount: slice?.broker_account ?? null,
        execTif: slice?.tif ?? null,
        execOrderType: slice?.order_type ?? null,
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

function fmtTs(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-ZA", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

export function SecurityRow({
  sec,
  expanded,
  onToggle,
  onDeferred,
  actions,
}: {
  sec: SecurityAgg;
  expanded: boolean;
  onToggle: () => void;
  onDeferred: (label: string) => void;
  actions: UseOrderActions;
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
        <td className={cn(ctd, "pl-6")}>
          <span className="inline-flex items-center gap-1.5">
            <ChevronRight
              className={cn(
                "h-3 w-3 shrink-0 text-muted-foreground transition-transform",
                expanded && "rotate-90",
              )}
            />
            <span className="font-semibold">{sec.ticker}</span>
            <span className="max-w-[140px] truncate text-[10px] text-muted-foreground">{sec.instrument}</span>
            {sec.children.length > 1 && (
              <span className="rounded-full bg-muted px-1.5 py-0.5 text-[9px] font-medium text-muted-foreground">
                {sec.children.length}
              </span>
            )}
          </span>
        </td>
        <td className={ctd}>
          <Badge variant={sec.side === "SELL" ? "destructive" : "success"}>{sec.side}</Badge>
        </td>
        <td className={ctd}>{sec.qty}</td>
        <td className={ctd}>
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
        <td className={ctd}>
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
        <td className={ctd}>{R(sec.livePrice)}</td>
        <td className={ctd}>—</td>
        <td className={ctd}>—</td>
        <td className={ctd}>—</td>
        <td className={ctd} />
        <td className={ctd} />
      </tr>
      {expanded && sec.children.map((c) => <SecurityChildRow key={c.rowId} c={c} actions={actions} />)}
    </>
  );
}

function SecurityChildRow({ c, actions }: { c: SecurityChild; actions: UseOrderActions }) {
  const auditId = c.execAuditId;
  const actionableRow = auditId
    ? {
        id: auditId,
        order_id: c.execOrderId,
        client_account: c.execClientAccount,
        broker_account: c.execBrokerAccount,
        limit_price: c.execLimitPrice,
        qty: c.qty,
        tif: c.execTif,
        order_type: c.execOrderType,
        state: c.execState,
      }
    : null;

  return (
    <>
      <tr className="border-b border-border/20 bg-accent/5 last:border-b-0">
        <td className={cn(ctd, "pl-10 text-muted-foreground")}>{c.client}</td>
        <td className={ctd}>
          <Badge variant={c.side === "SELL" ? "destructive" : "success"}>{c.side}</Badge>
        </td>
        <td className={ctd}>{c.qty}</td>
        <td className={ctd}>{R(c.avgFill)}</td>
        <td className={ctd}>{R(c.expectedFill)}</td>
        <td className={ctd}>{R(c.livePrice)}</td>
        <td
          className={cn(
            ctd,
            c.execDay1PnlCents != null && (c.execDay1PnlCents >= 0 ? "text-success" : "text-destructive"),
          )}
        >
          {fmtCents(c.execDay1PnlCents)}
        </td>
        <td className={ctd}>{c.execLimitPrice != null ? R(c.execLimitPrice) : "—"}</td>
        <td className={ctd}>
          <div className="flex flex-col leading-tight">
            <span className="font-mono text-[10px]">{c.execOrderId ?? "—"}</span>
            <span className="text-[9px] text-muted-foreground">{fmtTs(c.execTs)}</span>
          </div>
        </td>
        <td className={ctd}>
          <IressStatusPill
            state={c.execState}
            filledPct={c.execFilledPct}
            avgFillPrice={c.execAvgFillPrice}
          />
        </td>
        <td className={ctd}>
          {!actionableRow ? (
            <span className="text-[10px] text-muted-foreground">—</span>
          ) : isCancellable(actionableRow.state) ? (
            <div className="flex flex-col gap-0.5">
              <div className="flex gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={!!actions.cancelInFlight[actionableRow.id]}
                  onClick={() => void actions.handleCancel(actionableRow)}
                  className="h-6 px-1.5 text-[9px] uppercase tracking-wider text-destructive hover:bg-destructive/10"
                >
                  {actions.cancelInFlight[actionableRow.id] ? (
                    <Loader2 className="h-2.5 w-2.5 animate-spin" />
                  ) : (
                    "Cancel"
                  )}
                </Button>
                {isAmendable(actionableRow.state) && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => actions.openAmend(actionableRow)}
                    className="h-6 px-1.5 text-[9px] uppercase tracking-wider text-primary hover:bg-primary/10"
                  >
                    Amend
                  </Button>
                )}
              </div>
              {actions.cancelError[actionableRow.id] && (
                <span className="text-[9px] text-destructive">{actions.cancelError[actionableRow.id]}</span>
              )}
            </div>
          ) : isAwaitingBrokerAck(actionableRow.state) ? (
            <span className="text-[9px] text-warning">awaiting ack</span>
          ) : (
            <span className="text-[10px] text-muted-foreground">—</span>
          )}
        </td>
      </tr>
      {actionableRow && actions.amendOpen[actionableRow.id] && (
        <tr className="border-b border-border/20 bg-muted/30">
          <td colSpan={HOLDINGS_TABLE_COLS} className="px-3 py-2">
            <div className="flex flex-col gap-1">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Amend order {actionableRow.order_id} — OrderAmend2 via worker
              </span>
              <div className="flex flex-wrap items-end gap-2">
                <label
                  htmlFor={`amend-price-${actionableRow.id}`}
                  className="flex flex-col gap-0.5 text-[10px] uppercase tracking-wider text-muted-foreground"
                >
                  Price (R)
                  <Input
                    id={`amend-price-${actionableRow.id}`}
                    type="number"
                    step="0.01"
                    min="0"
                    disabled={actionableRow.order_type === "market"}
                    className={cn(
                      "h-7 w-24 text-[11px]",
                      actionableRow.order_type === "market" && "cursor-not-allowed opacity-60",
                    )}
                    value={actions.amendForm[actionableRow.id]?.priceRands ?? ""}
                    onChange={(e) =>
                      actions.setAmendForm((p) => ({
                        ...p,
                        [actionableRow.id]: {
                          priceRands: e.target.value,
                          volume: p[actionableRow.id]?.volume ?? "",
                          tif: p[actionableRow.id]?.tif ?? "DAY",
                        },
                      }))
                    }
                    placeholder={actionableRow.order_type === "market" ? "MKT — not amendable" : "—"}
                  />
                </label>
                <label
                  htmlFor={`amend-volume-${actionableRow.id}`}
                  className="flex flex-col gap-0.5 text-[10px] uppercase tracking-wider text-muted-foreground"
                >
                  Volume
                  <Input
                    id={`amend-volume-${actionableRow.id}`}
                    type="number"
                    step="1"
                    min="1"
                    className="h-7 w-20 text-[11px]"
                    value={actions.amendForm[actionableRow.id]?.volume ?? ""}
                    onChange={(e) =>
                      actions.setAmendForm((p) => ({
                        ...p,
                        [actionableRow.id]: {
                          priceRands: p[actionableRow.id]?.priceRands ?? "",
                          volume: e.target.value,
                          tif: p[actionableRow.id]?.tif ?? "DAY",
                        },
                      }))
                    }
                  />
                </label>
                <label
                  htmlFor={`amend-tif-${actionableRow.id}`}
                  className="flex flex-col gap-0.5 text-[10px] uppercase tracking-wider text-muted-foreground"
                >
                  TIF
                  <select
                    id={`amend-tif-${actionableRow.id}`}
                    className="h-7 rounded-md border border-input bg-background px-2 text-[11px]"
                    value={actions.amendForm[actionableRow.id]?.tif ?? "DAY"}
                    onChange={(e) =>
                      actions.setAmendForm((p) => ({
                        ...p,
                        [actionableRow.id]: {
                          priceRands: p[actionableRow.id]?.priceRands ?? "",
                          volume: p[actionableRow.id]?.volume ?? "",
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
                  disabled={!!actions.amendInFlight[actionableRow.id]}
                  onClick={() => void actions.submitAmend(actionableRow)}
                  className="h-7 text-[10px] uppercase tracking-wider"
                >
                  {actions.amendInFlight[actionableRow.id] ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    "Submit amend"
                  )}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => actions.closeAmend(actionableRow.id)}
                  className="h-7 text-[10px] uppercase tracking-wider"
                >
                  Cancel
                </Button>
              </div>
              {actions.amendError[actionableRow.id] && (
                <span className="text-[10px] text-destructive">{actions.amendError[actionableRow.id]}</span>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
