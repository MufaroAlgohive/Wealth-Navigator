"use client";

import * as React from "react";
import { toast } from "sonner";
import { Download } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/cn";

interface Row {
  id: string; email: string; client: string; instrument: string; ticker: string; isin: string;
  side: string; qty: number; avgFill: number; expectedFill: number; livePrice: number;
  status: string | null; strategy: string | null; clientPnl: number; mintPnl: number;
}

const R = (n: number) => new Intl.NumberFormat("en-ZA", { style: "currency", currency: "ZAR", minimumFractionDigits: 2 }).format(Number(n || 0));
const pnlCls = (n: number) => (n >= 0 ? "text-success" : "text-destructive");
const th = "px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-wider text-muted-foreground whitespace-nowrap";
const td = "px-3 py-2 text-[12px] text-foreground whitespace-nowrap";

function toCsv(rows: Row[]): string {
  const head = ["Client Email", "Instrument", "Ticker", "ISIN", "Side", "Qty", "Avg Fill", "Expected Fill", "Live Price", "Strategy", "Client PnL", "MINT PnL"];
  const esc = (v: unknown) => { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const lines = rows.map((r) => [r.email, r.instrument, r.ticker, r.isin, r.side, r.qty, r.avgFill.toFixed(2), r.expectedFill.toFixed(2), r.livePrice.toFixed(2), r.strategy ?? "", r.clientPnl.toFixed(2), r.mintPnl.toFixed(2)].map(esc).join(","));
  return [head.join(","), ...lines].join("\n");
}

export default function OrderBookPage() {
  const [tab, setTab] = React.useState("active");
  const [scope, setScope] = React.useState<"live" | "uat">("live");
  const [rows, setRows] = React.useState<Row[] | null>(null);
  const [search, setSearch] = React.useState("");

  const load = React.useCallback(async () => {
    setRows(null);
    const d = await fetch(`/api/admin/orderbook?status=${tab}&scope=${scope}`).then((r) => r.json()).catch(() => ({ ok: false }));
    setRows(d.ok ? d.rows || [] : []);
  }, [tab, scope]);
  React.useEffect(() => { void load(); }, [load]);

  const filtered = (rows ?? []).filter((r) => !search.trim() || `${r.email} ${r.ticker} ${r.client}`.toLowerCase().includes(search.toLowerCase()));

  const exportCsv = () => {
    if (!filtered.length) return toast.error("Nothing to export");
    const blob = new Blob([toCsv(filtered)], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `orderbook-${tab}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  const deferred = (label: string) => toast.message(`${label} is deferred to the data phase (settlement writes).`);

  const totalClientPnl = filtered.reduce((s, r) => s + r.clientPnl, 0);
  const totalMintPnl = filtered.reduce((s, r) => s + r.mintPnl, 0);

  return (
    <div className="mx-auto max-w-[1400px] space-y-4">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex gap-1 rounded-lg bg-muted p-0.5">
          {(["live", "uat"] as const).map((s) => (
            <button key={s} onClick={() => setScope(s)} className={cn("rounded px-3 py-1 text-xs font-medium uppercase", scope === s ? "bg-background text-foreground shadow" : "text-muted-foreground")}>{s}</button>
          ))}
        </div>
        <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search email / ticker…" className="h-8 w-56" />
        <div className="flex-1" />
        <Button variant="secondary" size="sm" onClick={exportCsv}><Download className="h-3.5 w-3.5" /> Export CSV</Button>
        <Button variant="secondary" size="sm" onClick={() => deferred("Capture snapshot")}>Capture snapshot</Button>
        <Button variant="secondary" size="sm" onClick={() => deferred("Strate BIR export")}>Strate BIR</Button>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:max-w-md">
        <div className="rounded-xl border border-border bg-card px-4 py-2.5"><div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Client P&L (shown)</div><div className={cn("text-lg font-bold", pnlCls(totalClientPnl))}>{R(totalClientPnl)}</div></div>
        <div className="rounded-xl border border-border bg-card px-4 py-2.5"><div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">MINT P&L (shown)</div><div className="text-lg font-bold text-foreground">{R(totalMintPnl)}</div></div>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="active">Active Orderbook</TabsTrigger>
          <TabsTrigger value="closed">Closed Books</TabsTrigger>
        </TabsList>
        <TabsContent value={tab} className="mt-3">
          <div className="overflow-x-auto rounded-xl border border-border">
            <table className="w-full border-collapse">
              <thead>
                <tr className="border-b border-border bg-card">
                  {["Client", "Instrument", "Ticker", "Side", "Qty", "Avg Fill", "Expected Fill", "Live Price", "Strategy", "Client P&L", "MINT P&L"].map((c) => <th key={c} className={th}>{c}</th>)}
                </tr>
              </thead>
              <tbody>
                {rows === null ? (
                  <tr><td colSpan={11} className="px-3 py-12 text-center text-sm text-muted-foreground">Loading…</td></tr>
                ) : filtered.length === 0 ? (
                  <tr><td colSpan={11} className="px-3 py-12 text-center text-sm text-muted-foreground">No {scope.toUpperCase()} {tab} holdings.</td></tr>
                ) : filtered.map((r) => (
                  <tr key={r.id} className="border-b border-border/40 last:border-b-0 hover:bg-accent/20">
                    <td className={cn(td, "max-w-[180px] truncate")}>{r.email}</td>
                    <td className={cn(td, "max-w-[180px] truncate")}>{r.instrument}</td>
                    <td className={cn(td, "font-semibold")}>{r.ticker}</td>
                    <td className={td}><Badge variant={r.side === "SELL" ? "destructive" : "success"}>{r.side}</Badge></td>
                    <td className={td}>{r.qty}</td>
                    <td className={cn(td, "cursor-pointer underline-offset-2 hover:underline")} onClick={() => deferred("Edit fill price")}>{R(r.avgFill)}</td>
                    <td className={cn(td, "cursor-pointer underline-offset-2 hover:underline")} onClick={() => deferred("Edit expected fill")}>{R(r.expectedFill)}</td>
                    <td className={td}>{R(r.livePrice)}</td>
                    <td className={cn(td, "max-w-[140px] truncate text-muted-foreground")}>{r.strategy || "—"}</td>
                    <td className={cn(td, pnlCls(r.clientPnl))}>{R(r.clientPnl)}</td>
                    <td className={td}>{R(r.mintPnl)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
