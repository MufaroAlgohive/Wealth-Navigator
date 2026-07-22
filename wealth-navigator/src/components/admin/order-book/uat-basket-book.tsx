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
  client_account: string | null;
}
interface AdhocExecResponse {
  ok: boolean;
  rows?: AdhocExecRow[];
}

const ADHOC_BOOK_ID = "UAT-ADHOC";
// Orders forwarded from a real client buy/sell in the mint app (see
// client-order/route.ts) land under this separate book id — kept distinct
// from UAT-ADHOC (the admin ad-hoc ticket) so the two provenances don't get
// visually conflated, even though both are merged into this same panel.
const CLIENT_BUY_BOOK_ID = "CLIENT-BUY";

/**
 * Ad-hoc/audit-only orders (the "UAT Order Ticket", and mint-forwarded
 * client orders) write straight to `oems_order_audit` with no underlying
 * `stock_holdings_c` row visible to this query — they can't be represented
 * as a normal holdings Row the same way the Test Runner's seeded scenarios
 * can. Each audit row is turned into a synthetic Row instead. `client`
 * prefers the audit row's own `client_account` (the real client's email for
 * a mint-forwarded order; the operator's email for an ad-hoc ticket order)
 * over the generic "MINT UAT" placeholder. `id` is set to the audit row's
 * own id, which `BasketDetail`'s exec-join falls back to matching on when
 * there's no `holding_id` to key by. P&L is left at 0 — no cost basis to
 * compare a bare execution row against.
 */
function adhocRowToRow(r: AdhocExecRow, bookId: string): Row {
  const px = r.avg_fill_price ?? r.limit_price ?? 0;
  const client = r.client_account && r.client_account.trim().length > 0 ? r.client_account : "MINT UAT";
  return {
    id: r.id,
    security_id: null,
    user_id: null,
    email: client,
    client,
    instrument: r.symbol,
    ticker: r.symbol,
    isin: r.isin ?? "",
    side: r.side,
    qty: r.qty,
    avgFill: r.avg_fill_price ?? 0,
    expectedFill: r.limit_price ?? 0,
    livePrice: px,
    status: r.state,
    strategy: bookId,
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

  // 2026-07-21: temporarily hiding real seeded test holdings (Test Runner
  // scenarios, sourced from the RETAIL/CRM stock_holdings_c table) per
  // explicit direction — only UAT-ADHOC should show for now. The fetch is
  // disabled (not just filtered out) so it isn't hitting RETAIL every 30s
  // for data nobody sees. Flip `SHOW_SEEDED_HOLDINGS` back on to restore it.
  const SHOW_SEEDED_HOLDINGS = false;
  const { data } = usePolling<OrderbookApiResponse>("/api/admin/orderbook?status=active&scope=uat", {
    interval: 30_000,
    query: { enabled: SHOW_SEEDED_HOLDINGS },
  });
  // 2s, matching ExecutionView's own poll cadence (execution-view.tsx) — this
  // panel has no SSE stream of its own, so a fast poll is what gets it close
  // to the "real time" feel the two SSE-backed legacy panels already have.
  const { data: adhocData } = usePolling<AdhocExecResponse>(
    `/api/admin/orderbook/execution?book_id=${ADHOC_BOOK_ID}`,
    { interval: 2_000 },
  );
  const { data: clientBuyData } = usePolling<AdhocExecResponse>(
    `/api/admin/orderbook/execution?book_id=${CLIENT_BUY_BOOK_ID}`,
    { interval: 2_000 },
  );

  const groups = React.useMemo(() => {
    const holdingsRows = SHOW_SEEDED_HOLDINGS ? (data?.rows ?? []) : [];
    const adhocRows = (adhocData?.rows ?? []).map((r) => adhocRowToRow(r, ADHOC_BOOK_ID));
    const clientBuyRows = (clientBuyData?.rows ?? []).map((r) => adhocRowToRow(r, CLIENT_BUY_BOOK_ID));
    return groupRowsByStrategy([...holdingsRows, ...adhocRows, ...clientBuyRows]);
  }, [data, adhocData, clientBuyData]);

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
            {groups.length === 0 ? (
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
                        <td colSpan={COLS} className="p-0">
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
