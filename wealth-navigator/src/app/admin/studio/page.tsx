"use client";

import * as React from "react";
import { toast } from "sonner";
import { Search, ExternalLink } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/cn";
import { DataSourceBadge } from "@/components/oems/primitives/data-source-badge";

interface Client { id: string; familyMemberId?: string | null; name: string; parentName?: string | null; email: string | null; strategy: string | null; isTest?: boolean; }
interface PortfolioHolding { id: string; symbol: string; name: string; logo_url: string | null; quantity: number; cost: number; live: number; marketValue: number; pnl: number; pnlPct:number; pending:boolean; strategyId:string|null; strategy: string | null; }
interface Txn { id: string; name: string | null; description: string | null; amount: number; direction: string; status?:string|null; transaction_date: string | null; created_at?:string|null; }
interface StrategyPreview {id:string;name:string;value:number;holdings:number}
interface Portfolio { holdings: PortfolioHolding[]; transactions: Txn[]; totalValue: number; cash?: number; totalPnl: number; pnlPct: number; strategyCount: number; strategies:StrategyPreview[];units?:{money:string;sourcePrices:string}; }

const ZAR = (n: number) => new Intl.NumberFormat("en-ZA", { style: "currency", currency: "ZAR", minimumFractionDigits: 2 }).format(Number(n || 0));
const pnlCls = (n: number) => (n >= 0 ? "text-success" : "text-destructive");
const initials = (name: string) => name.split(" ").map((w) => w[0]).join("").slice(0, 2).toUpperCase() || "?";

export default function StudioPage() {
  const [config, setConfig] = React.useState<{ dev: string; live: string }>({ dev: "", live: "" });
  const [env, setEnv] = React.useState<"dev" | "live">("live");
  const [scope, setScope] = React.useState<"invested" | "all">("invested");
  const [clients, setClients] = React.useState<Client[] | null>(null);
  const [search, setSearch] = React.useState("");
  const [selected, setSelected] = React.useState<Client | null>(null);
  const [portfolio, setPortfolio] = React.useState<Portfolio | null>(null);
  const [launching, setLaunching] = React.useState(false);
  const [portfolioError,setPortfolioError]=React.useState<string|null>(null);

  React.useEffect(() => {
    fetch("/api/admin/studio?action=config").then((r) => r.json()).then((d) => {if(d.ok){const next={dev:d.dev||"",live:d.live||""};setConfig(next);if(!next.live&&next.dev)setEnv("dev");}}).catch(() => {});
  }, []);

  React.useEffect(() => {
    setClients(null);
    if (scope === "invested") {
      fetch("/api/admin/investors/data").then((r) => r.json()).then((d) => {
        if (!d.ok) { setClients([]); return; }
        const strategyById = new Map<string, string>((d.strategies || []).map((s: any) => [String(s.id), String(s.name)]));
        const profById = new Map<string, any>((d.profiles || []).map((p: any) => [p.id, p]));
        const famById = new Map<string, any>((d.familyMembers || []).map((f: any) => [f.id, f]));
        
        const groups = new Map<string, { userId: string; familyMemberId: string | null; strategyIds: Set<string> }>();
        for (const h of (d.holdings || [])) {
          const id = h.user_id;
          if (!id) continue;
          const famId = h.family_member_id || null;
          const key = `${id}:${famId || ""}`;
          
          const g = groups.get(key) || { userId: id, familyMemberId: famId, strategyIds: new Set<string>() };
          if (h.strategy_id && strategyById.has(String(h.strategy_id))) g.strategyIds.add(strategyById.get(String(h.strategy_id))!);
          groups.set(key, g);
        }

        const mapped: Client[] = [];
        for (const g of groups.values()) {
          const prof = profById.get(g.userId);
          if (!prof) continue;
          
          let displayName = `${prof.first_name || ""} ${prof.last_name || ""}`.trim() || prof.email;
          let parentName: string | null = null;
          if (g.familyMemberId) {
             const fam = famById.get(g.familyMemberId);
             if (fam) {
                const famName = `${fam.first_name || ""} ${fam.last_name || ""}`.trim();
                parentName = displayName;
                displayName = famName;
             }
          }
          
          mapped.push({
            id: g.userId,
            familyMemberId: g.familyMemberId,
            name: displayName,
            parentName: parentName,
            email: prof.email,
            strategy: [...g.strategyIds].join(", ") || null,
            isTest: false
          });
        }
        
        mapped.sort((a, b) => String(a.name).localeCompare(String(b.name)));
        setClients(mapped);
      }).catch(() => setClients([]));
    } else {
      fetch(`/api/admin/studio?action=clients&scope=all`).then((r) => r.json()).then((d) => setClients(d.ok ? d.clients || [] : [])).catch(() => setClients([]));
    }
  }, [scope]);

  const openClient = async (c: Client) => {
    setSelected(c);
    setPortfolio(null);
    setPortfolioError(null);
    const qs = `user_id=${c.id}${c.familyMemberId ? `&family_member_id=${c.familyMemberId}` : ""}`;
    const d = await fetch(`/api/admin/studio?action=portfolio&${qs}`).then((r) => r.json()).catch(() => ({ ok: false }));
    if (d.ok) setPortfolio(d);else setPortfolioError(d.error||"Portfolio preview unavailable");
  };

  const launch = async () => {
    if (!selected) return;
    setLaunching(true);
    const preview=window.open("/admin/studio/preview?loading=1","_blank");
    if(preview){preview.document.title="Preparing client view";preview.document.body.innerHTML='<div style="font-family:system-ui;padding:32px;color:#6d28d9">Preparing secure client sign-in…</div>';}
    if(preview)preview.location.href="/admin/studio/preview?loading=1";
    try {
      const d = await fetch("/api/admin/studio?action=impersonate", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ user_id: selected.id, target: env }),
      }).then((r) => r.json());
      if (d.ok && d.actionLink){
        const payload={actionLink:d.actionLink,environment:env,client:selected,portfolio};
        const encoded=btoa(unescape(encodeURIComponent(JSON.stringify(payload))));
        const previewUrl=`/admin/studio/preview#payload=${encodeURIComponent(encoded)}`;
        if(preview)preview.location.href=previewUrl;else window.open(previewUrl,"_blank","noopener,noreferrer");
      }
      else {preview?.close();toast.error(d.error || "Could not open client view");}
    } catch(error){preview?.close();toast.error(error instanceof Error?error.message:"Could not open client view");} finally { setLaunching(false); }
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
          <div className="mb-3 flex justify-end"><DataSourceBadge source="supabase" db="retail" /></div>
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
              <button key={`${c.id}:${c.familyMemberId || ""}`} onClick={() => openClient(c)} className={cn("flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left", selected?.id === c.id && selected?.familyMemberId === c.familyMemberId ? "bg-primary/10" : "hover:bg-accent/50")}>
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-primary to-chart-5 text-[11px] font-bold text-primary-foreground">{initials(c.name)}</div>
                <div className="min-w-0 flex-1 flex flex-col items-start text-left">
                  <span className="w-full truncate text-sm font-medium text-foreground">{c.name}</span>
                  {c.parentName && <span className="w-full truncate text-[11px] text-muted-foreground opacity-80">Managed by {c.parentName}</span>}
                  <span className="w-full truncate text-[11px] text-muted-foreground" title={c.strategy || ""}>
                    {c.email} {c.strategy ? `· ${c.strategy}` : ""} {c.isTest ? "· UAT" : ""}
                  </span>
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* Preview / inspector */}
        <div className="rounded-2xl border border-border bg-card p-5">
          {!selected ? (
            <div className="flex h-full min-h-[300px] items-center justify-center text-sm text-muted-foreground">Select a client to preview their portfolio.</div>
          ) : portfolioError ? (
            <div className="flex min-h-[300px] flex-col items-center justify-center gap-3"><p className="text-sm text-destructive">{portfolioError}</p><Button size="sm" variant="secondary" onClick={()=>openClient(selected)}>Retry</Button></div>
          ) : portfolio === null ? (
            <p className="py-16 text-center text-sm text-muted-foreground">Loading portfolio…</p>
          ) : (
            <div className="space-y-5">
              {/* Header */}
              <div className="flex items-center justify-between gap-3 rounded-xl border border-primary/15 bg-gradient-to-br from-primary/20 via-primary/5 to-transparent p-4">
                <div>
                  <div className="text-lg font-bold text-foreground">{selected.name}</div>
                  <div className="text-xs text-muted-foreground">{selected.email}</div>
                </div>
                <div className="text-right">
                  <div className="text-2xl font-bold text-foreground">{ZAR(portfolio.totalValue)}</div>
                  <div className="mt-0.5 flex items-center justify-end gap-2 text-[11px] text-muted-foreground"><span>Positions + cash · ZAR</span><DataSourceBadge source="hybrid" db="retail" /></div>
                  {!!portfolio.cash && <div className="mt-0.5 text-[10px] text-muted-foreground">incl. {ZAR(portfolio.cash)} cash</div>}
                </div>
              </div>

              {/* Metrics */}
              <div className="grid grid-cols-3 gap-3">
                <Metric label="P&L" value={ZAR(portfolio.totalPnl)} cls={pnlCls(portfolio.totalPnl)} />
                <Metric label="Return" value={`${portfolio.pnlPct >= 0 ? "+" : ""}${portfolio.pnlPct.toFixed(2)}%`} cls={pnlCls(portfolio.pnlPct)} />
                <Metric label="Strategies" value={String(portfolio.strategyCount)} />
              </div>

              <div>
                <div className="mb-2 flex items-center justify-between"><h3 className="text-sm font-bold text-foreground">Strategy preview</h3><span className="text-[9px] uppercase tracking-wider text-muted-foreground">{portfolio.units?.sourcePrices||"Intraday-first pricing"}</span></div>
                {portfolio.strategies.length===0?<p className="text-xs text-muted-foreground">Direct securities only.</p>:<div className="grid gap-2 sm:grid-cols-2">{portfolio.strategies.map(strategy=><div key={strategy.id} className="rounded-xl border border-border bg-muted/20 p-3"><div className="flex items-center justify-between gap-2"><p className="truncate text-xs font-semibold text-foreground">{strategy.name}</p><p className="font-mono text-xs font-semibold text-primary">{ZAR(strategy.value)}</p></div><p className="mt-1 text-[10px] text-muted-foreground">{strategy.holdings} holding{strategy.holdings===1?"":"s"}</p></div>)}</div>}
              </div>

              {/* Launch */}
              <div className="flex items-center justify-between rounded-xl border border-border p-4">
                <div><div className="text-sm text-foreground">Secure client preview</div><div className="text-[10px] text-muted-foreground">Generate a one-time {env.toUpperCase()} sign-in link. No password is exposed.</div></div>
                <Button onClick={launch} disabled={launching || !envUrl}><ExternalLink className="h-3.5 w-3.5" /> Open as {selected.name.split(" ")[0]}</Button>
              </div>

              {/* Top holdings */}
              <div>
                <h3 className="mb-2 text-sm font-bold text-foreground">Top holdings</h3>
                {portfolio.holdings.length === 0 ? <p className="text-xs text-muted-foreground">No holdings.</p> : (
                  <div className="divide-y divide-border">
                    {portfolio.holdings.slice(0, 8).map((h) => (
                      <div key={h.id} className="flex items-center gap-3 py-2">
                        <div className="min-w-0 flex-1"><p className="text-sm font-semibold text-foreground">{h.symbol}{h.pending?<span className="ml-1.5 rounded bg-warning/15 px-1.5 py-0.5 text-[8px] text-warning">PENDING</span>:null}</p><p className="truncate text-[11px] text-muted-foreground">{h.name} · {h.quantity} × {ZAR(h.live)}</p></div>
                        <div className="text-right"><p className="text-xs font-medium text-foreground">{ZAR(h.marketValue)}</p><p className={cn("text-[11px]", pnlCls(h.pnl))}>{h.pnl >= 0 ? "+" : ""}{ZAR(h.pnl)} · {h.pnlPct.toFixed(2)}%</p></div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Recent transactions */}
              <div>
                <div className="mb-2 flex items-center justify-between gap-2"><h3 className="text-sm font-bold text-foreground">Recent transactions</h3><DataSourceBadge source="supabase" db="retail" /></div>
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
