import { useMemo } from "react";
import { generatePrints } from "@/lib/oemsExtra";
import { cn } from "@/lib/utils";

export default function TimeAndSales({ mid, n = 20 }: { mid: number; n?: number }) {
  const prints = useMemo(() => generatePrints(mid, n), [mid, n]);
  return (
    <div className="text-[11px] font-mono">
      <div className="grid grid-cols-4 text-[10px] uppercase tracking-wider text-muted-foreground border-b border-border px-2 py-1">
        <span>Time</span><span className="text-right">Price</span><span className="text-right">Qty</span><span className="text-right">Vn</span>
      </div>
      <div className="max-h-[260px] overflow-y-auto">
        {prints.map((p, i) => (
          <div key={i} className="grid grid-cols-4 px-2 py-0.5 hover:bg-muted/40">
            <span className="text-muted-foreground">{p.time}</span>
            <span className={cn("text-right tabular-nums", p.side === "B" ? "text-success" : "text-destructive")}>{p.price.toFixed(2)}</span>
            <span className="text-right tabular-nums">{p.qty.toLocaleString()}</span>
            <span className="text-right text-muted-foreground text-[10px]">{p.venue}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
