"use client";

import { useMemo } from "react";
import { cn } from "@/lib/cn";

interface DepthLevel {
  price: number;
  qty: number;
  orders: number;
}

function generateBook(mid: number, tick: number, levels: number): { bids: DepthLevel[]; asks: DepthLevel[] } {
  const bids: DepthLevel[] = [];
  const asks: DepthLevel[] = [];
  for (let i = 1; i <= levels; i++) {
    bids.push({ price: +(mid - i * tick).toFixed(2), qty: 200 + Math.floor(Math.random() * 4800), orders: 1 + Math.floor(Math.random() * 9) });
    asks.push({ price: +(mid + i * tick).toFixed(2), qty: 200 + Math.floor(Math.random() * 4800), orders: 1 + Math.floor(Math.random() * 9) });
  }
  return { bids, asks };
}

interface DepthLadderProps {
  mid: number;
  tick?: number;
  levels?: number;
  className?: string;
}

export function DepthLadder({ mid, tick = 0.05, levels = 8, className }: DepthLadderProps) {
  const book = useMemo(() => generateBook(mid, tick, levels), [mid, tick, levels]);
  const maxQty = Math.max(...book.bids.map((b) => b.qty), ...book.asks.map((a) => a.qty));
  return (
    <div className={cn("text-[11px] font-mono", className)}>
      <div className="grid grid-cols-3 border-b border-border/70 bg-card/50 px-2 py-1 text-[9.5px] uppercase tracking-wider text-muted-foreground">
        <span>Orders</span>
        <span className="text-right">Bid Qty</span>
        <span className="text-right">Price</span>
      </div>
      {book.bids.map((b, i) => (
        <Row key={`b${i}`} price={b.price} qty={b.qty} orders={b.orders} side="bid" maxQty={maxQty} />
      ))}
      <div className="my-0.5 border-y border-primary/30 bg-primary/10 px-2 py-1 text-center text-[11px] font-semibold text-primary">
        {mid.toFixed(2)} <span className="text-muted-foreground/80">·</span> MID <span className="text-muted-foreground/80">·</span> spread {(tick * 2).toFixed(2)}
      </div>
      {book.asks.map((a, i) => (
        <Row key={`a${i}`} price={a.price} qty={a.qty} orders={a.orders} side="ask" maxQty={maxQty} />
      ))}
    </div>
  );
}

function Row({ price, qty, orders, side, maxQty }: { price: number; qty: number; orders: number; side: "bid" | "ask"; maxQty: number }) {
  const pct = Math.min(1, qty / maxQty);
  const isBid = side === "bid";
  return (
    <div className="relative grid grid-cols-3 px-2 py-0.5">
      <div
        className={cn("absolute inset-y-0", isBid ? "right-0 bg-success/15" : "left-0 bg-destructive/15")}
        style={{ width: `${pct * 60}%` }}
      />
      <span className="relative text-muted-foreground">{orders}</span>
      <span className="relative text-right tabular-nums">{qty.toLocaleString()}</span>
      <span className={cn("relative text-right tabular-nums", isBid ? "text-up" : "text-down")}>{price.toFixed(2)}</span>
    </div>
  );
}
