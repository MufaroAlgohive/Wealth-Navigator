"use client";

import type { OrderBookMember } from "./execution-view";

const money = (value: number | null) =>
  value == null
    ? "—"
    : new Intl.NumberFormat("en-ZA", {
        style: "currency",
        currency: "ZAR",
        minimumFractionDigits: 2,
      }).format(value);

export function CrmOrderBreakdown({ member }: { member: OrderBookMember }) {
  const details = member.crm_details;
  if (!details) return null;

  return (
    <div className="space-y-3 border-t border-border/40 bg-muted/20 px-3 py-3">
      {details.is_strategy ? (
        <>
          <section>
            <h4 className="mb-1.5 text-[10px] font-semibold uppercase text-muted-foreground">
              Holdings under {details.strategy_name ?? member.symbol ?? "strategy"}
            </h4>
            {details.holdings.length ? (
              <div className="overflow-x-auto">
                <table className="w-full text-[11px]">
                  <thead>
                    <tr className="text-left text-[10px] uppercase text-muted-foreground">
                      <th className="py-1 pr-3">Instrument</th>
                      <th className="py-1 pr-3">Ticker</th>
                      <th className="py-1 pr-3">Side</th>
                      <th className="py-1 pr-3 text-right">Qty</th>
                      <th className="py-1 pr-3 text-right">Avg fill</th>
                      <th className="py-1 pr-3 text-right">Expected fill</th>
                      <th className="py-1 pr-3 text-right">Market value</th>
                      <th className="py-1 text-right">Client PnL</th>
                    </tr>
                  </thead>
                  <tbody>
                    {details.holdings.map((holding) => (
                      <tr key={holding.id} className="border-t border-border/30">
                        <td className="py-1.5 pr-3 font-medium">{holding.instrument}</td>
                        <td className="py-1.5 pr-3 text-muted-foreground">{holding.ticker}</td>
                        <td className="py-1.5 pr-3">{holding.side}</td>
                        <td className="py-1.5 pr-3 text-right tabular-nums">{holding.qty}</td>
                        <td className="py-1.5 pr-3 text-right tabular-nums">{money(holding.avg_fill_rands)}</td>
                        <td className="py-1.5 pr-3 text-right tabular-nums">{money(holding.expected_fill_rands)}</td>
                        <td className="py-1.5 pr-3 text-right tabular-nums">{money(holding.market_value_rands)}</td>
                        <td className="py-1.5 text-right tabular-nums">{money(holding.pnl_rands)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="text-[11px] text-muted-foreground">No holdings captured for this strategy.</div>
            )}
          </section>

          <section>
            <h4 className="mb-1.5 text-[10px] font-semibold uppercase text-muted-foreground">
              Investors in {details.strategy_name ?? member.symbol ?? "strategy"}
            </h4>
            {details.investors.length ? (
              <div className="overflow-x-auto">
                <table className="w-full text-[11px]">
                  <thead>
                    <tr className="text-left text-[10px] uppercase text-muted-foreground">
                      <th className="py-1 pr-3">Client</th>
                      <th className="py-1 pr-3">Account</th>
                      <th className="py-1 pr-3">Owner</th>
                      <th className="py-1 pr-3 text-right">Holdings</th>
                      <th className="py-1 text-right">Market value</th>
                    </tr>
                  </thead>
                  <tbody>
                    {details.investors.map((investor) => (
                      <tr key={investor.id} className="border-t border-border/30">
                        <td className="py-1.5 pr-3 font-medium">{investor.name}</td>
                        <td className="py-1.5 pr-3">{investor.account_id ?? "—"}</td>
                        <td className="py-1.5 pr-3 text-muted-foreground">
                          {investor.family_relationship ?? "Primary"}
                        </td>
                        <td className="py-1.5 pr-3 text-right tabular-nums">{investor.holdings_count}</td>
                        <td className="py-1.5 text-right tabular-nums">{money(investor.market_value_rands)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="text-[11px] text-muted-foreground">No investors captured for this strategy.</div>
            )}
          </section>
        </>
      ) : details.allocations.length ? (
        <section>
          <h4 className="mb-1.5 text-[10px] font-semibold uppercase text-muted-foreground">
            BND allocation details
          </h4>
          <div className="overflow-x-auto">
            <table className="w-full text-[11px]">
              <thead>
                <tr className="text-left text-[10px] uppercase text-muted-foreground">
                  <th className="py-1 pr-3">Client</th>
                  <th className="py-1 pr-3">Account</th>
                  <th className="py-1 pr-3">BND reference</th>
                  <th className="py-1 pr-3 text-right">Qty</th>
                  <th className="py-1 pr-3 text-right">Market value</th>
                  <th className="py-1 pr-3">Order time</th>
                  <th className="py-1 pr-3">Instruction</th>
                  <th className="py-1">Settlement ref</th>
                </tr>
              </thead>
              <tbody>
                {details.allocations.map((allocation) => (
                  <tr key={allocation.id} className="border-t border-border/30">
                    <td className="py-1.5 pr-3 font-medium">{allocation.name}</td>
                    <td className="py-1.5 pr-3">{allocation.account_id ?? "—"}</td>
                    <td className="py-1.5 pr-3 font-mono text-[10px]">{allocation.reference ?? "—"}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">{allocation.qty}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">{money(allocation.market_value_rands)}</td>
                    <td className="py-1.5 pr-3">{allocation.timestamp ?? "—"}</td>
                    <td className="py-1.5 pr-3">{allocation.instruction_type ?? "Market"}</td>
                    <td className="py-1.5">{allocation.settlement_ref ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </div>
  );
}
