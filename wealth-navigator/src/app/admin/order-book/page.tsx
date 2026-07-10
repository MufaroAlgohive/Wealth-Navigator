"use client";

import * as React from "react";
import { toast } from "sonner";
import { Download, ChevronRight } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/cn";
import { UatBanner } from "@/components/admin/order-book/uat-banner";
import { UatOrderTicket } from "@/components/admin/order-book/uat-order-ticket";
import { UatTestRunner } from "@/components/admin/order-book/uat-test-runner";
import { ExecutionView } from "@/components/admin/order-book/execution-view";

interface Row {
  id: string; email: string; client: string; instrument: string; ticker: string; isin: string;
  side: string; qty: number; avgFill: number; expectedFill: number; livePrice: number;
  status: string | null; strategy: string | null; clientPnl: number; mintPnl: number;
  /** Execution date (ISO). Sorted desc; populated when the OEMS feed is wired. */
  date: string | null;
}

const R = (n: number) => new Intl.NumberFormat("en-ZA", { style: "currency", currency: "ZAR", minimumFractionDigits: 2 }).format(Number(n || 0));
const pnlCls = (n: number) => (n >= 0 ? "text-success" : "text-destructive");
const fmtDate = (iso: string | null) => {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString("en-ZA", { day: "2-digit", month: "short", year: "numeric" });
};
const th = "px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-wider text-muted-foreground whitespace-nowrap";
const td = "px-3 py-2 text-[12px] text-foreground whitespace-nowrap";

function toCsv(rows: Row[]): string {
  const head = ["Date", "Client Email", "Strategy", "Instrument", "Ticker", "ISIN", "Side", "Qty", "Avg Fill", "Expected Fill", "Live Price", "Client PnL", "MINT PnL"];
  const esc = (v: unknown) => { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const lines = rows.map((r) => [r.date ?? "", r.email, r.strategy ?? "", r.instrument, r.ticker, r.isin, r.side, r.qty, r.avgFill.toFixed(2), r.expectedFill.toFixed(2), r.livePrice.toFixed(2), r.clientPnl.toFixed(2), r.mintPnl.toFixed(2)].map(esc).join(","));
  return [head.join(","), ...lines].join("\n");
}

interface StrategyGroup {
  strategy: string;
  rows: Row[];
  clientPnl: number;
  mintPnl: number;
  latest: string;
  clients: number;
}

export default function OrderBookPage() {
  const [tab, setTab] = React.useState("active");
  const [scope, setScope] = React.useState<"live" | "uat">("live");
  const [rows, setRows] = React.useState<Row[] | null>(null);
  const [search, setSearch] = React.useState("");
  const [expanded, setExpanded] = React.useState<Set<string>>(new Set());
  const [uatRefresh, setUatRefresh] = React.useState(0);

  const load = React.useCallback(async () => {
    setRows(null);
    const d = await fetch(`/api/admin/orderbook?status=${tab}&scope=${scope}`).then((r) => r.json()).catch(() => ({ ok: false }));
    setRows(d.ok ? d.rows || [] : []);
  }, [tab, scope]);
  React.useEffect(() => { void load(); }, [load]);

  const filtered = (rows ?? []).filter((r) => !search.trim() || `${r.email} ${r.ticker} ${r.client} ${r.strategy ?? ""}`.toLowerCase().includes(search.toLowerCase()));

  // Grouped by strategy (Lonwabo: "combine where strategies combined… drop down →
  // see all the securities under that strategy that were executed"). Groups and
  // their executions sort by date desc.
  const groups = React.useMemo<StrategyGroup[]>(() => {
    const m = new Map<string, Row[]>();
    for (const r of filtered) {
      const k = r.strategy || "Unassigned";
      (m.get(k) ?? m.set(k, []).get(k)!).push(r);
    }
    return [...m.entries()]
      .map(([strategy, rs]) => {
        const sorted = [...rs].sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
        return {
          strategy,
          rows: sorted,
          clientPnl: rs.reduce((s, r) => s + r.clientPnl, 0),
          mintPnl: rs.reduce((s, r) => s + r.mintPnl, 0),
          latest: sorted[0]?.date ?? "",
          clients: new Set(rs.map((r) => r.email)).size,
        };
      })
      .sort((a, b) => b.latest.localeCompare(a.latest));
  }, [filtered]);

  const toggle = (s: string) => setExpanded((prev) => { const n = new Set(prev); n.has(s) ? n.delete(s) : n.add(s); return n; });

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
  const COLS = 9;

  return (
    <div className="mx-auto max-w-[1400px] space-y-4">
      {tab !== "uat-testing" && (
      <>
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex gap-1 rounded-lg bg-muted p-0.5">
          {(["live", "uat"] as const).map((s) => (
            <button key={s} onClick={() => setScope(s)} className={cn("rounded px-3 py-1 text-xs font-medium uppercase", scope === s ? "bg-background text-foreground shadow" : "text-muted-foreground")}>{s}</button>
          ))}
        </div>
        <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search email / ticker / strategy…" className="h-8 w-64" />
        <div className="flex-1" />
        <Button variant="secondary" size="sm" onClick={exportCsv}><Download className="h-3.5 w-3.5" /> Export CSV</Button>
        <Button variant="secondary" size="sm" onClick={() => deferred("Capture snapshot")}>Capture snapshot</Button>
        <Button variant="secondary" size="sm" onClick={() => deferred("Strate BIR export")}>Strate BIR</Button>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:max-w-md">
        <div className="rounded-xl border border-border bg-card px-4 py-2.5"><div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Client P&L (shown)</div><div className={cn("text-lg font-bold", pnlCls(totalClientPnl))}>{R(totalClientPnl)}</div></div>
        <div className="rounded-xl border border-border bg-card px-4 py-2.5"><div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">MINT P&L (shown)</div><div className="text-lg font-bold text-foreground">{R(totalMintPnl)}</div></div>
      </div>
      </>
      )}

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="active">Active Orderbook</TabsTrigger>
          <TabsTrigger value="closed">Closed Books</TabsTrigger>
          <TabsTrigger value="uat-testing">UAT Order Testing</TabsTrigger>
        </TabsList>
        {tab === "uat-testing" ? (
          <TabsContent value="uat-testing" className="mt-3 space-y-3">
            <UatBanner />
            <UatOrderTicket onPlaced={() => setUatRefresh((n) => n + 1)} />
            <UatTestRunner />
            <ExecutionView key={uatRefresh} bookId="UAT-ADHOC" />
          </TabsContent>
        ) : (
        <TabsContent value={tab} className="mt-3">
          <div className="overflow-x-auto rounded-xl border border-border">
            <table className="w-full border-collapse">
              <thead>
                <tr className="border-b border-border bg-card">
                  {["Strategy / Execution", "Date", "Side", "Qty", "Avg Fill", "Expected Fill", "Live Price", "Client P&L", "MINT P&L"].map((c) => <th key={c} className={th}>{c}</th>)}
                </tr>
              </thead>
              <tbody>
                {rows === null ? (
                  <tr><td colSpan={COLS} className="px-3 py-12 text-center text-sm text-muted-foreground">Loading…</td></tr>
                ) : groups.length === 0 ? (
                  <tr><td colSpan={COLS} className="px-3 py-12 text-center text-sm text-muted-foreground">No {scope.toUpperCase()} {tab} holdings.</td></tr>
                ) : groups.map((g) => {
                  const open = expanded.has(g.strategy);
                  return (
                    <React.Fragment key={g.strategy}>
                      {/* Strategy group header — combined, click to drill down */}
                      <tr
                        className="cursor-pointer border-b border-border/60 bg-card/60 hover:bg-accent/20"
                        onClick={() => toggle(g.strategy)}
                      >
                        <td className={cn(td, "font-semibold")}>
                          <span className="inline-flex items-center gap-1.5">
                            <ChevronRight className={cn("h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
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
                      {/* Executed securities under the strategy */}
                      {open && g.rows.map((r) => (
                        <tr key={r.id} className="border-b border-border/30 last:border-b-0 hover:bg-accent/10">
                          <td className={cn(td, "pl-9")}>
                            <span className="font-semibold">{r.ticker}</span>
                            <span className="ml-2 max-w-[200px] truncate align-middle text-[11px] text-muted-foreground">{r.instrument}</span>
                            <span className="ml-2 align-middle text-[10px] text-muted-foreground/70">{r.email}</span>
                          </td>
                          <td className={cn(td, "text-muted-foreground")}>{fmtDate(r.date)}</td>
                          <td className={td}><Badge variant={r.side === "SELL" ? "destructive" : "success"}>{r.side}</Badge></td>
                          <td className={td}>{r.qty}</td>
                          <td className={cn(td, "cursor-pointer underline-offset-2 hover:underline")} onClick={(e) => { e.stopPropagation(); deferred("Edit fill price"); }}>{R(r.avgFill)}</td>
                          <td className={cn(td, "cursor-pointer underline-offset-2 hover:underline")} onClick={(e) => { e.stopPropagation(); deferred("Edit expected fill"); }}>{R(r.expectedFill)}</td>
                          <td className={td}>{R(r.livePrice)}</td>
                          <td className={cn(td, pnlCls(r.clientPnl))}>{R(r.clientPnl)}</td>
                          <td className={td}>{R(r.mintPnl)}</td>
                        </tr>
                      ))}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </TabsContent>
        )}
      </Tabs>
    </div>
  );
}
