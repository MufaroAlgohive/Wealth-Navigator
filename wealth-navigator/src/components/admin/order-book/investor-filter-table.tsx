import { cn } from "@/lib/cn";
import { R, td, th } from "./format";

export interface InvestorAgg {
  key: string;
  email: string;
  client: string;
  marketValue: number;
  holdingsCount: number;
}

/**
 * "Investors in {strategy}" — mirrors the CRM's orderbook.html investor
 * table (click a row to filter the securities table above to that
 * investor's own holdings; click again to clear). This component only
 * renders rows and reports clicks — the parent (basket-detail.tsx) owns the
 * toggle state, matching CRM's click-same-row-to-revert behavior.
 */
export function InvestorFilterTable({
  investors,
  selectedKey,
  onSelect,
}: {
  investors: InvestorAgg[];
  selectedKey: string | null;
  onSelect: (key: string) => void;
}) {
  if (investors.length === 0) return null;
  return (
    <div className="overflow-x-auto rounded-lg border border-border/60">
      <table className="w-full border-collapse">
        <thead>
          <tr className="border-b border-border/60 bg-card/40">
            <th className={th}>Investor</th>
            <th className={th}>Holdings</th>
            <th className={th}>Market value</th>
          </tr>
        </thead>
        <tbody>
          {investors.map((inv) => {
            const selected = inv.key === selectedKey;
            return (
              <tr
                key={inv.key}
                tabIndex={0}
                onClick={() => onSelect(inv.key)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onSelect(inv.key);
                  }
                }}
                className={cn(
                  "cursor-pointer border-b border-border/30 last:border-b-0 hover:bg-accent/10",
                  selected && "bg-accent/20",
                )}
              >
                <td className={cn(td, selected && "font-semibold")}>{inv.client}</td>
                <td className={td}>{inv.holdingsCount}</td>
                <td className={td}>{R(inv.marketValue)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
