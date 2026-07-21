"use client";

import { ChevronRight } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";

import { cn } from "@/lib/cn";
import { usePolling } from "@/lib/hooks/use-polling";
import { BasketDetail } from "./basket-detail";
import { R, type Row, fmtDate, groupRowsByStrategy, pnlCls, td, th } from "./format";

interface OrderbookApiResponse {
  ok: boolean;
  rows?: Row[];
}

interface AdhocExecRow {
  id: string;
  ts: string;
  side: string;
  symbol: string;
  isin: string | null;
  qty: number;
  limit_price: number | null;
  avg_fill_price: number | null;
  state: string;
}
interface AdhocExecResponse {
  ok: boolean;
  rows?: AdhocExecRow[];
}

const ADHOC_BOOK_ID = "UAT-ADHOC";

/**
 * The ad-hoc "UAT Order Ticket" writes straight to `oems_order_audit` — it
 * has no underlying `stock_holdings_c` row (no real investor, no cost
 * basis), so it can't be represented as a normal holdings Row the same way
 * the Test Runner's seeded scenarios can. To surface it in this panel
 * anyway, each ad-hoc audit row is turned into a synthetic Row with a
 * placeholder investor ("MINT UAT" — there's no real client behind an
 * ad-hoc test order) and P&L left at 0 (no cost basis to compare against).
 * `id` is set to the audit row's own id, which `BasketDetail`'s exec-join
 * falls back to matching on when there's no `holding_id` to key by.
 */
function adhocRowToRow(r: AdhocExecRow): Row {
  const px = r.avg_fill_price ?? r.limit_price ?? 0;
  return {
    id: r.id,
    security_id: null,
    user_id: null,
    email: "mint-uat@internal",
    client: "MINT UAT",
    instrument: r.symbol,
    ticker: r.symbol,
    isin: r.isin ?? "",
    side: r.side,
    qty: r.qty,
    avgFill: r.avg_fill_price ?? 0,
    expectedFill: r.limit_price ?? 0,
    livePrice: px,
    status: r.state,
    strategy: ADHOC_BOOK_ID,
    clientPnl: 0,
    mintPnl: 0,
    date: r.ts,
  };
}

/**
 * UAT-only basket -> securities/investors drill-down (CRM orderbook.html
 * pattern) + inline IRESS status. Lives exclusively in the "UAT Order
 * Testing" tab, scoped to test holdings (status=active, scope=uat) — kept
 * separate from the Active Orderbook / Closed Books tabs, which are
 * unchanged, so this can be validated against test data before it's ever
 * considered for the real client-facing books.
 *
 * Combines two sources into one grouped list: real seeded test holdings
 * (Test Runner scenarios) AND the ad-hoc UAT Order Ticket's orders (which
 * otherwise only ever showed in the ExecutionView panel above) — so both
 * UAT tools' output lands in the same place.
 */
export function UatBasketBook() {
  const [expanded, setExpanded] = React.useState<Set<string>>(new Set());

  const { data, loading } = usePolling<OrderbookApiResponse>("/api/admin/orderbook?status=active&scope=uat", {
    interval: 30_000,
  });
  const { data: adhocData } = usePolling<AdhocExecResponse>(
    `/api/admin/orderbook/execution?book_id=${ADHOC_BOOK_ID}`,
    { interval: 30_000 },
  );

  const groups = React.useMemo(() => {
    const holdingsRows = data?.rows ?? [];
    const adhocRows = (adhocData?.rows ?? []).map(adhocRowToRow);
    return groupRowsByStrategy([...holdingsRows, ...adhocRows]);
  }, [data, adhocData]);

  const toggle = (s: string) =>
    setExpanded((prev) => {
      const n = new Set(prev);
      n.has(s) ? n.delete(s) : n.add(s);
      return n;
    });

  const deferred = (label: string) =>
    toast.message(`${label} is deferred to the data phase (settlement writes).`);

  const COLS = 9;

  return (
    <div className="space-y-2">
      <div className="px-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        UAT Order Book — test baskets only
      </div>
      <div className="overflow-x-auto rounded-xl border border-border">
        <table className="w-full border-collapse">
          <thead>
            <tr className="border-b border-border bg-card">
              {[
                "Strategy / Execution",
                "Date",
                "Side",
                "Qty",
                "Avg Fill",
                "Order Value",
                "Last",
                "Client P&L",
                "MINT P&L",
              ].map((c) => (
                <th key={c} className={th}>
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading && !data ? (
              <tr>
                <td colSpan={COLS} className="px-3 py-12 text-center text-sm text-muted-foreground">
                  Loading…
                </td>
              </tr>
            ) : groups.length === 0 ? (
              <tr>
                <td colSpan={COLS} className="px-3 py-12 text-center text-sm text-muted-foreground">
                  No UAT test holdings.
                </td>
              </tr>
            ) : (
              groups.map((g) => {
                const open = expanded.has(g.strategy);
                return (
                  <React.Fragment key={g.strategy}>
                    <tr
                      className="cursor-pointer border-b border-border/60 bg-card/60 hover:bg-accent/20"
                      tabIndex={0}
                      onClick={() => toggle(g.strategy)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          toggle(g.strategy);
                        }
                      }}
                    >
                      <td className={cn(td, "font-semibold")}>
                        <span className="inline-flex items-center gap-1.5">
                          <ChevronRight
                            className={cn(
                              "h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform",
                              open && "rotate-90",
                            )}
                          />
                          {g.strategy}
                          <span className="ml-1 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                            {g.rows.length} exec · {g.clients} client{g.clients !== 1 ? "s" : ""}
                          </span>
                        </span>
                      </td>
                      <td className={cn(td, "text-muted-foreground")}>{fmtDate(g.latest)}</td>
                      <td className={td} colSpan={4} />
                      <td className={cn(td, pnlCls(g.clientPnl), "font-semibold")}>{R(g.clientPnl)}</td>
                      <td className={cn(td, "font-semibold")}>{R(g.mintPnl)}</td>
                    </tr>
                    {open && (
                      <tr className="border-b border-border/30 last:border-b-0">
                        <td colSpan={COLS} className="bg-card/20 px-3">
                          <BasketDetail group={g} onDeferred={deferred} />
                        </td>
                      </tr>
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
