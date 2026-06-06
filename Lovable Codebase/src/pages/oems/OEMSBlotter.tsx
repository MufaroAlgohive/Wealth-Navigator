import { useState } from "react";
import PanelFrame from "@/components/oems/PanelFrame";
import PriceCell from "@/components/oems/PriceCell";
import { orders, OrderState } from "@/lib/oemsExtra";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Plus, X, Search } from "lucide-react";
import { cn } from "@/lib/utils";

const STATES: { key: OrderState | "ALL"; label: string }[] = [
  { key: "ALL", label: "All" },
  { key: "WORKING", label: "Working" },
  { key: "PARTIAL", label: "Partial" },
  { key: "FILLED", label: "Filled" },
  { key: "CANCELLED", label: "Cancelled" },
  { key: "REJECTED", label: "Rejected" },
];

export default function OEMSBlotter() {
  const [state, setState] = useState<OrderState | "ALL">("ALL");
  const [q, setQ] = useState("");
  const filtered = orders.filter(o =>
    (state === "ALL" || o.state === state) &&
    (q === "" || o.symbol.toLowerCase().includes(q.toLowerCase()) || o.strategy.toLowerCase().includes(q.toLowerCase()) || o.id.includes(q))
  );

  const counts = STATES.reduce((acc, s) => {
    acc[s.key] = s.key === "ALL" ? orders.length : orders.filter(o => o.state === s.key).length;
    return acc;
  }, {} as Record<string, number>);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">Blotter & Orders</h1>
          <p className="text-xs text-muted-foreground">Live execution tape · FIX 4.4 via IRESS gateway · slippage in bps vs arrival</p>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" className="h-8 text-xs"><X className="h-3 w-3 mr-1" />Cancel All Working</Button>
          <Button size="sm" className="h-8 text-xs"><Plus className="h-3 w-3 mr-1" />New Order</Button>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <Tabs value={state} onValueChange={(v) => setState(v as any)}>
          <TabsList className="h-8 bg-muted">
            {STATES.map(s => (
              <TabsTrigger key={s.key} value={s.key} className="h-6 text-[11px] gap-1.5">
                {s.label}<span className="text-[9px] text-muted-foreground font-mono">{counts[s.key]}</span>
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <div className="relative w-60">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input value={q} onChange={e => setQ(e.target.value)} placeholder="Symbol, strategy, order id..." className="h-8 pl-7 text-xs" />
        </div>
      </div>

      <PanelFrame title={`Orders · ${filtered.length}`} endpoint="GET /v1/orders" dense scroll className="h-[calc(100vh-260px)]">
        <table className="w-full text-[11px]">
          <thead className="bg-muted/40 text-[10px] uppercase tracking-wider text-muted-foreground sticky top-0">
            <tr>
              <th className="text-left px-2 py-1.5">Order ID</th>
              <th className="text-left px-2">Time</th>
              <th className="text-left px-2">Strategy</th>
              <th className="text-left px-2">Side</th>
              <th className="text-left px-2">Symbol</th>
              <th className="text-left px-2">ISIN</th>
              <th className="text-right px-2">Qty</th>
              <th className="text-right px-2">Filled</th>
              <th className="text-right px-2">Limit</th>
              <th className="text-right px-2">Last</th>
              <th className="text-right px-2">VWAP</th>
              <th className="text-right px-2">Slip (bp)</th>
              <th className="text-left px-2">Venue</th>
              <th className="text-left px-2">TIF</th>
              <th className="text-left px-2">Trader</th>
              <th className="text-left px-2">State</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border font-mono">
            {filtered.map(o => (
              <tr key={o.id} className="hover:bg-muted/30">
                <td className="px-2 py-1.5 text-muted-foreground">{o.id}</td>
                <td className="px-2 text-muted-foreground">{o.time}</td>
                <td className="px-2">{o.strategy}</td>
                <td className={cn("px-2 font-semibold", o.side === "BUY" ? "text-success" : "text-destructive")}>{o.side}</td>
                <td className="px-2 font-medium">{o.symbol}</td>
                <td className="px-2 text-[9px] text-muted-foreground">{o.isin}</td>
                <td className="px-2 text-right">{o.qty.toLocaleString()}</td>
                <td className="px-2 text-right">{o.filled.toLocaleString()}<span className="text-[9px] text-muted-foreground"> ({Math.round(o.filled / o.qty * 100)}%)</span></td>
                <td className="px-2 text-right">{o.limit?.toFixed(2) ?? "MKT"}</td>
                <td className="px-2 text-right"><PriceCell tickKey={o.symbol} fallback={o.last} decimals={2} showChange={false} /></td>
                <td className="px-2 text-right">{o.vwap.toFixed(2)}</td>
                <td className={cn("px-2 text-right", o.slippageBps >= 0 ? "text-success" : "text-destructive")}>{o.slippageBps.toFixed(1)}</td>
                <td className="px-2 text-muted-foreground">{o.venue}</td>
                <td className="px-2 text-muted-foreground">{o.tif}</td>
                <td className="px-2 text-muted-foreground">{o.trader}</td>
                <td className="px-2">
                  <Badge variant="outline" className={cn("text-[9px] font-mono h-4",
                    o.state === "FILLED" && "border-success/40 text-success",
                    o.state === "PARTIAL" && "border-warning/40 text-warning",
                    o.state === "WORKING" && "border-primary/40 text-primary",
                    o.state === "REJECTED" && "border-destructive/40 text-destructive",
                    o.state === "CANCELLED" && "border-muted-foreground/40 text-muted-foreground",
                  )}>{o.state}</Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </PanelFrame>
    </div>
  );
}
