"use client";

import * as React from "react";
import { toast } from "sonner";
import { Search, ExternalLink } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/cn";

interface Client { id: string; name: string; email: string | null; strategy: string | null; }
interface PortfolioHolding { id: string; symbol: string; name: string; logo_url: string | null; quantity: number; cost: number; live: number; marketValue: number; pnl: number; strategy: string | null; }
interface Txn { id: string; name: string | null; description: string | null; amount: number; direction: string; transaction_date: string | null; }
interface Portfolio { holdings: PortfolioHolding[]; transactions: Txn[]; totalValue: number; totalPnl: number; pnlPct: number; strategyCount: number; }

const ZAR = (n: number) => new Intl.NumberFormat("en-ZA", { style: "currency", currency: "ZAR", minimumFractionDigits: 2 }).format(Number(n || 0));
const pnlCls = (n: number) => (n >= 0 ? "text-success" : "text-destructive");
const initials = (name: string) => name.split(" ").map((w) => w[0]).join("").slice(0, 2).toUpperCase() || "?";

export default function StudioPage() {
  const [config, setConfig] = React.useState<{ dev: string; live: string }>({ dev: "", live: "" });
  const [env, setEnv] = React.useState<"dev" | "live">("dev");
  const [scope, setScope] = React.useState<"invested" | "all">("invested");
  const [clients, setClients] = React.useState<Client[] | null>(null);
  const [search, setSearch] = React.useState("");
  const [selected, setSelected] = React.useState<Client | null>(null);
  const [portfolio, setPortfolio] = React.useState<Portfolio | null>(null);
  const [launching, setLaunching] = React.useState(false);

  React.useEffect(() => {
    fetch("/api/admin/studio?action=config").then((r) => r.json()).then((d) => d.ok && setConfig({ dev: d.dev, live: d.live })).catch(() => {});
  }, []);

  React.useEffect(() => {
    setClients(null);
    fetch(`/api/admin/studio?action=clients&scope=${scope}`).then((r) => r.json()).then((d) => setClients(d.ok ? d.clients || [] : [])).catch(() => setClients([]));
  }, [scope]);

  const openClient = async (c: Client) => {
    setSelected(c);
    setPortfolio(null);
    const d = await fetch(`/api/admin/studio?action=portfolio&user_id=${c.id}`).then((r) => r.json()).catch(() => ({ ok: false }));
    if (d.ok) setPortfolio(d);
  };

  const launch = async () => {
    if (!selected) return;
    setLaunching(true);
    try {
      const d = await fetch("/api/admin/studio?action=impersonate", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ user_id: selected.id, target: env }),
      }).then((r) => r.json());
      if (d.ok && d.actionLink) window.open(d.actionLink, "_blank");
      else toast.message(d.error || "Deferred");
    } finally { setLaunching(false); }
  };

  const filtered = (clients ?? []).filter((c) => !search.trim() || `${c.name} ${c.email} ${c.strategy}`.toLowerCase().includes(search.toLowerCase()));
  const envUrl = env === "dev" ? config.dev : config.live;

  return (
    <div className="mx-auto max-w-6xl">
      {/* Toolbar */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Environment</span>
        <div className="flex gap-1 rounded-lg bg-muted p-0.5">
          {(["dev", "live"] as const).map((e) => (
            <button key={e} onClick={() => setEnv(e)} disabled={!(e === "dev" ? config.dev : config.live)}
              className={cn("rounded px-3 py-1 text-xs font-medium uppercase disabled:opacity-40", env === e ? "bg-background text-foreground shadow" : "text-muted-foreground")}>{e}</button>
          ))}
        </div>
        {!envUrl && <span className="text-[11px] text-warning">No {env.toUpperCase()} app URL configured.</span>}
        {selected && <Button variant="ghost" size="sm" className="ml-auto" onClick={() => { setSelected(null); setPortfolio(null); }}>Exit preview</Button>}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[340px_1fr]">
        {/* Client list */}
        <div className="rounded-2xl border border-border bg-card p-4">
          <div className="mb-3 flex gap-1 rounded-lg bg-muted p-0.5">
            {(["invested", "all"] as const).map((s) => (
              <button key={s} onClick={() => setScope(s)} className={cn("flex-1 rounded px-2 py-1 text-xs font-medium capitalize", scope === s ? "bg-background text-foreground shadow" : "text-muted-foreground")}>{s === "invested" ? "Invested" : "All Users"}</button>
            ))}
          </div>
          <div className="relative mb-3">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search clients…" className="h-8 pl-8" />
          </div>
          <div className="max-h-[60vh] space-y-1 overflow-y-auto">
            {clients === null ? (
              <p className="py-6 text-center text-xs text-muted-foreground">Loading…</p>
            ) : filtered.length === 0 ? (
              <p className="py-6 text-center text-xs text-muted-foreground">No clients.</p>
            ) : filtered.map((c) => (
              <button key={c.id} onClick={() => openClient(c)} className={cn("flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left", selected?.id === c.id ? "bg-primary/10" : "hover:bg-accent/50")}>
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-primary to-chart-5 text-[11px] font-bold text-primary-foreground">{initials(c.name)}</div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-foreground">{c.name}</div>
                  <div className="truncate text-[11px] text-muted-foreground">{c.strategy || c.email}</div>
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* Preview / inspector */}
        <div className="rounded-2xl border border-border bg-card p-5">
          {!selected ? (
            <div className="flex h-full min-h-[300px] items-center justify-center text-sm text-muted-foreground">Select a client to preview their portfolio.</div>
          ) : portfolio === null ? (
            <p className="py-16 text-center text-sm text-muted-foreground">Loading portfolio…</p>
          ) : (
            <div className="space-y-5">
              {/* Header */}
              <div className="flex items-center justify-between gap-3 rounded-xl bg-gradient-to-br from-primary/15 to-transparent p-4">
                <div>
                  <div className="text-lg font-bold text-foreground">{selected.name}</div>
                  <div className="text-xs text-muted-foreground">{selected.email}</div>
                </div>
                <div className="text-right">
                  <div className="text-2xl font-bold text-foreground">{ZAR(portfolio.totalValue)}</div>
                  <div className="text-[11px] text-muted-foreground">Portfolio value</div>
                </div>
              </div>

              {/* Metrics */}
              <div className="grid grid-cols-3 gap-3">
                <Metric label="P&L" value={ZAR(portfolio.totalPnl)} cls={pnlCls(portfolio.totalPnl)} />
                <Metric label="Return" value={`${portfolio.pnlPct >= 0 ? "+" : ""}${portfolio.pnlPct.toFixed(2)}%`} cls={pnlCls(portfolio.pnlPct)} />
                <Metric label="Strategies" value={String(portfolio.strategyCount)} />
              </div>

              {/* Launch */}
              <div className="flex items-center justify-between rounded-xl border border-border p-4">
                <div className="text-sm text-muted-foreground">Open the {env.toUpperCase()} app as this client.</div>
                <Button onClick={launch} disabled={launching || !envUrl}><ExternalLink className="h-3.5 w-3.5" /> Open as {selected.name.split(" ")[0]}</Button>
              </div>

              {/* Top holdings */}
              <div>
                <h3 className="mb-2 text-sm font-bold text-foreground">Top holdings</h3>
                {portfolio.holdings.length === 0 ? <p className="text-xs text-muted-foreground">No holdings.</p> : (
                  <div className="divide-y divide-border">
                    {portfolio.holdings.slice(0, 8).map((h) => (
                      <div key={h.id} className="flex items-center gap-3 py-2">
                        <div className="min-w-0 flex-1"><p className="text-sm font-semibold text-foreground">{h.symbol}</p><p className="truncate text-[11px] text-muted-foreground">{h.name}</p></div>
                        <div className="text-right"><p className="text-xs font-medium text-foreground">{ZAR(h.marketValue)}</p><p className={cn("text-[11px]", pnlCls(h.pnl))}>{h.pnl >= 0 ? "+" : ""}{ZAR(h.pnl)}</p></div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Recent transactions */}
              <div>
                <h3 className="mb-2 text-sm font-bold text-foreground">Recent transactions</h3>
                {portfolio.transactions.length === 0 ? <p className="text-xs text-muted-foreground">No transactions.</p> : (
                  <div className="divide-y divide-border">
                    {portfolio.transactions.map((t) => (
                      <div key={t.id} className="flex items-center justify-between gap-3 py-2">
                        <div className="min-w-0"><p className="truncate text-sm text-foreground">{t.name || t.description || "—"}</p><p className="text-[11px] text-muted-foreground">{t.transaction_date ? new Date(t.transaction_date).toLocaleDateString("en-ZA") : ""}</p></div>
                        <span className={cn("text-sm font-medium", t.direction === "credit" ? "text-success" : "text-foreground")}>{t.direction === "credit" ? "+" : "-"}{ZAR(Math.abs(Number(t.amount || 0)))}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Metric({ label, value, cls }: { label: string; value: string; cls?: string }) {
  return <div className="rounded-xl border border-border bg-card px-3 py-2.5 text-center"><div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</div><div className={cn("mt-0.5 text-sm font-bold text-foreground", cls)}>{value}</div></div>;
}
