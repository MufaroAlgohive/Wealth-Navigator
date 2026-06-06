import { useMemo } from "react";
import { generateDepth } from "@/lib/oemsExtra";
import { cn } from "@/lib/utils";

export default function DepthLadder({ mid, tick = 0.05, levels = 10 }: { mid: number; tick?: number; levels?: number }) {
  const book = useMemo(() => generateDepth(mid, tick, levels), [mid, tick, levels]);
  const maxQty = Math.max(...book.bids.map(b => b.qty), ...book.asks.map(a => a.qty));

  return (
    <div className="text-[11px] font-mono">
      <div className="grid grid-cols-3 text-[10px] uppercase tracking-wider text-muted-foreground border-b border-border px-2 py-1">
        <span>Orders</span><span className="text-right">Bid Qty</span><span className="text-right">Price</span>
      </div>
      {book.bids.map((b, i) => (
        <div key={`b${i}`} className="grid grid-cols-3 px-2 py-0.5 relative">
          <div className="absolute inset-y-0 right-0 bg-success/15" style={{ width: `${(b.qty / maxQty) * 60}%` }} />
          <span className="relative text-muted-foreground">{b.orders}</span>
          <span className="relative text-right tabular-nums">{b.qty.toLocaleString()}</span>
          <span className="relative text-right tabular-nums text-success">{b.price.toFixed(2)}</span>
        </div>
      ))}
      <div className="px-2 py-1 my-1 bg-primary/10 border-y border-primary/20 text-center text-primary font-semibold">
        {mid.toFixed(2)} · MID · spread {(tick * 2).toFixed(2)}
      </div>
      <div className="grid grid-cols-3 text-[10px] uppercase tracking-wider text-muted-foreground border-b border-border px-2 py-1">
        <span>Price</span><span className="text-right">Ask Qty</span><span className="text-right">Orders</span>
      </div>
      {book.asks.map((a, i) => (
        <div key={`a${i}`} className="grid grid-cols-3 px-2 py-0.5 relative">
          <div className="absolute inset-y-0 left-0 bg-destructive/15" style={{ width: `${(a.qty / maxQty) * 60}%` }} />
          <span className="relative tabular-nums text-destructive">{a.price.toFixed(2)}</span>
          <span className="relative text-right tabular-nums">{a.qty.toLocaleString()}</span>
          <span className="relative text-right text-muted-foreground">{a.orders}</span>
        </div>
      ))}
    </div>
  );
}
