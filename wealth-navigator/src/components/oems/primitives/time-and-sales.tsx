"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/cn";

interface Print {
  time: string;
  price: number;
  qty: number;
  side: "B" | "S";
  venue: string;
}

function generatePrints(mid: number, n: number): Print[] {
  const out: Print[] = [];
  let p = mid;
  for (let i = 0; i < n; i++) {
    p = +(p + (Math.random() - 0.5) * Math.max(mid * 0.0008, 0.04)).toFixed(2);
    const d = new Date(Date.now() - (n - i) * 7000);
    out.push({
      time: d.toLocaleTimeString("en-ZA", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }),
      price: p,
      qty: 100 + Math.floor(Math.random() * 4000),
      side: Math.random() > 0.5 ? "B" : "S",
      venue: Math.random() > 0.85 ? "DARK" : "JSE",
    });
  }
  return out.reverse();
}

export function TimeAndSales({ mid, n = 24, className }: { mid: number; n?: number; className?: string }) {
  const [prints, setPrints] = useState<Print[]>(() => generatePrints(mid, n));

  useEffect(() => {
    setPrints(generatePrints(mid, n));
    const id = setInterval(() => {
      setPrints((prev) => {
        const head = prev[0];
        const last = head ? head.price : mid;
        const next: Print = {
          time: new Date().toLocaleTimeString("en-ZA", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }),
          price: +(last + (Math.random() - 0.5) * Math.max(mid * 0.001, 0.05)).toFixed(2),
          qty: 100 + Math.floor(Math.random() * 4000),
          side: Math.random() > 0.5 ? "B" : "S",
          venue: Math.random() > 0.85 ? "DARK" : "JSE",
        };
        return [next, ...prev].slice(0, n);
      });
    }, 1800);
    return () => clearInterval(id);
  }, [mid, n]);

  return (
    <div className={cn("text-[11px] font-mono", className)}>
      <div className="sticky top-0 z-10 grid grid-cols-4 border-b border-border/70 bg-card/95 px-2 py-1 text-[9.5px] uppercase tracking-wider text-muted-foreground backdrop-blur">
        <span>Time</span>
        <span className="text-right">Price</span>
        <span className="text-right">Qty</span>
        <span className="text-right">Vn</span>
      </div>
      <div className="max-h-[260px] overflow-y-auto scrollbar-thin">
        {prints.map((p, i) => (
          <div key={`${p.time}-${i}`} className="grid grid-cols-4 px-2 py-0.5 hover:bg-muted/30">
            <span className="text-muted-foreground">{p.time}</span>
            <span className={cn("text-right tabular-nums", p.side === "B" ? "text-up" : "text-down")}>{p.price.toFixed(2)}</span>
            <span className="text-right tabular-nums">{p.qty.toLocaleString()}</span>
            <span className="text-right text-[10px] text-muted-foreground/80">{p.venue}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
