"use client";

import * as React from "react";
import { toast } from "sonner";
import { X } from "lucide-react";
import { useSearchParams } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { cn } from "@/lib/cn";

/**
 * Strategy builder — the create/edit + browse view (was `/admin/strategies`).
 * Rendered as the "Builder" tab of the unified Strategies page. Reads/writes the
 * `/api/admin/strategies` admin API (Save is deferred to the data phase).
 */
interface Sec { symbol: string; name: string | null; logo_url: string | null; last_price: number | null; change_percent?: number | null; }
interface Holding { symbol?: string; ticker?: string; shares?: number; quantity?: number; weight?: number; }
interface Strategy {
  id: string; name: string | null; short_name: string | null; description: string | null; objective: string | null;
  sector: string | null; risk_level: string | null; base_currency: string | null; status: string | null;
  is_public: boolean | null; is_featured: boolean | null; holdings: Holding[] | null; investor_environment?: "LIVE" | "UAT" | null;
}
interface FormHolding { symbol: string; name: string; last_price: number; logo_url: string | null; shares: number; weight: number; market_value: number; }

const normalize = (s: string) => (typeof s === "string" && s.trim() ? s.trim().split(".")[0]!.toUpperCase() : s);
const fmtR = (v: number | null, ccy = "ZAR") => {
  const n = Number(v);
  if (!n || Number.isNaN(n)) return "Not calculated";
  try { return new Intl.NumberFormat("en-ZA", { style: "currency", currency: ccy, maximumFractionDigits: 0 }).format(n); }
  catch { return `R ${n.toLocaleString()}`; }
};
const riskCls = (r: string | null) => {
  switch ((r || "").toLowerCase()) {
    case "low": return "bg-success/15 text-success";
    case "medium": return "bg-warning/15 text-warning";
    case "high": return "bg-destructive/15 text-destructive";
    default: return "bg-muted text-muted-foreground";
  }
};
function calcMin(holdings: Holding[], secMap: Map<string, Sec>): number | null {
  let total = 0, matched = 0;
  for (const h of holdings) {
    const sym = String(h.ticker || h.symbol || "");
    const sec = secMap.get(sym) || secMap.get(normalize(sym));
    if (sec && sec.last_price != null) { total += Number(h.shares || h.quantity || 1) * Number(sec.last_price); matched++; }
  }
  return matched > 0 ? Math.round(total) : null;
}

const inputCls = "w-full rounded-xl border border-input bg-background px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/20";

export function StrategyBuilder() {
  const searchParams = useSearchParams();
  const [strategies, setStrategies] = React.useState<Strategy[] | null>(null);
  const [securities, setSecurities] = React.useState<Record<string, Sec>>({});
  const secMap = React.useMemo(() => {
    const m = new Map<string, Sec>();
    for (const [k, v] of Object.entries(securities)) { m.set(k, v); const n = normalize(k); if (n !== k) m.set(n, v); }
    return m;
  }, [securities]);

  const load = React.useCallback(async () => {
    setStrategies(null);
    const d = await fetch("/api/admin/strategies?action=list").then((r) => r.json()).catch(() => ({ ok: false }));
    setStrategies(d.ok ? d.strategies || [] : []);
    // securities_c.last_price is stored in CENTS; the builder derives Rands everywhere
    // (prices, market value, min investment). Normalise to Rands once at ingestion so
    // every downstream calc is correct. Weights are ratios (scale-invariant), unaffected.
    const rawSecs: Record<string, Sec> = d.ok ? d.securities || {} : {};
    const secs: Record<string, Sec> = {};
    for (const k in rawSecs) { const s = rawSecs[k]; if (!s) continue; secs[k] = s.last_price != null ? { ...s, last_price: Number(s.last_price) / 100 } : s; }
    setSecurities(secs);
  }, []);
  React.useEffect(() => { void load(); }, [load]);

  // ── Create form ──
  const [name, setName] = React.useState("");
  const [shortName, setShortName] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [risk, setRisk] = React.useState("");
  const [sector, setSector] = React.useState("");
  const [currency, setCurrency] = React.useState("ZAR");
  const [isPublic, setIsPublic] = React.useState(false);
  const [isFeatured, setIsFeatured] = React.useState(false);
  const [investorEnvironment, setInvestorEnvironment] = React.useState<"LIVE" | "UAT">("LIVE");
  const [holdings, setHoldings] = React.useState<FormHolding[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [editingId, setEditingId] = React.useState("");
  const [passwordOpen, setPasswordOpen] = React.useState(false);
  const [savePassword, setSavePassword] = React.useState("");

  // security search
  const [secQuery, setSecQuery] = React.useState("");
  const [secResults, setSecResults] = React.useState<Sec[]>([]);
  React.useEffect(() => {
    if (!secQuery.trim()) { setSecResults([]); return; }
    const t = setTimeout(async () => {
      const d = await fetch(`/api/admin/strategies?action=search-securities&q=${encodeURIComponent(secQuery.trim())}`).then((r) => r.json()).catch(() => ({ ok: false }));
      const existing = new Set(holdings.map((h) => h.symbol));
      // last_price is CENTS from the API — normalise to Rands (see load()).
      const raw = (d.ok ? d.securities || [] : []) as Sec[];
      const norm = raw.map((s) => (s && s.last_price != null ? { ...s, last_price: Number(s.last_price) / 100 } : s));
      setSecResults(norm.filter((s: Sec) => !existing.has(s.symbol)));
    }, 250);
    return () => clearTimeout(t);
  }, [secQuery, holdings]);

  const withWeights = (hs: FormHolding[]): FormHolding[] => {
    const total = hs.reduce((sum, h) => sum + h.shares * (h.last_price || 0), 0);
    return hs.map((h) => { const mv = h.shares * (h.last_price || 0); return { ...h, market_value: mv, weight: total > 0 ? (mv / total) * 100 : 0 }; });
  };
  React.useEffect(() => {
    const id = searchParams.get("edit") || "";
    if (!id || !strategies || editingId === id) return;
    const strategy = strategies.find((row) => row.id === id);
    if (!strategy) return;
    setEditingId(id); setName(strategy.name || ""); setShortName(strategy.short_name || "");
    setDescription(strategy.description || strategy.objective || ""); setRisk(strategy.risk_level || "");
    setSector(strategy.sector || ""); setCurrency(strategy.base_currency || "ZAR");
    setIsPublic(Boolean(strategy.is_public)); setIsFeatured(Boolean(strategy.is_featured));
    setInvestorEnvironment(strategy.investor_environment === "UAT" ? "UAT" : "LIVE");
    setHoldings(withWeights((strategy.holdings || []).map((holding) => {
      const symbol = String(holding.ticker || holding.symbol || "");
      const security = secMap.get(symbol) || secMap.get(normalize(symbol));
      const shares = Number(holding.shares || holding.quantity || 1); const price = Number(security?.last_price || 0);
      return { symbol, name: security?.name || symbol, last_price: price, logo_url: security?.logo_url || null, shares, weight: Number(holding.weight || 0), market_value: shares * price };
    })));
  }, [editingId, searchParams, secMap, strategies]);
  const addHolding = (s: Sec) => {
    setHoldings((hs) => withWeights([...hs, { symbol: s.symbol, name: s.name || s.symbol, last_price: Number(s.last_price) || 0, logo_url: s.logo_url, shares: 1, weight: 0, market_value: 0 }]));
    setSecQuery(""); setSecResults([]);
  };
  const setShares = (i: number, shares: number) => setHoldings((hs) => withWeights(hs.map((h, idx) => idx === i ? { ...h, shares: Math.max(1, shares || 1) } : h)));
  const removeHolding = (i: number) => setHoldings((hs) => withWeights(hs.filter((_, idx) => idx !== i)));

  const totalWeight = holdings.reduce((s, h) => s + h.weight, 0);
  const minInvest = Math.round(holdings.reduce((s, h) => s + h.market_value, 0));

  const submit = async () => {
    if (!name.trim()) return toast.error("Strategy name is required");
    setSavePassword(""); setPasswordOpen(true);
  };
  const performSave = async () => {
    if (!savePassword) return;
    setBusy(true);
    try {
      const payload = {
        name: name.trim(), short_name: shortName.trim() || null, description: description.trim() || null,
        risk_level: risk || null, sector: sector.trim() || null, base_currency: currency.trim() || "ZAR",
        is_public: isPublic, is_featured: isFeatured, investor_environment: investorEnvironment, status: "active",
        holdings: holdings.map((h) => ({ symbol: h.symbol, shares: h.shares, weight: h.weight })),
        min_investment: minInvest,
      };
      const d = await fetch("/api/admin/strategies", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: editingId ? "update" : "create", id: editingId || undefined, password: savePassword, patch: payload }) }).then((r) => r.json());
      if (!d.ok) return toast.error(d.error || "Strategy save failed");
      toast.success(editingId ? "Strategy updated" : "Strategy created"); setPasswordOpen(false); await load();
    } finally { setBusy(false); }
  };

  // ── Browse ──
  const [search, setSearch] = React.useState("");
  const [fRisk, setFRisk] = React.useState("all");
  const [fVis, setFVis] = React.useState("all");
  const [sort, setSort] = React.useState("recent");
  const [modal, setModal] = React.useState<Strategy | null>(null);

  const visible = React.useMemo(() => {
    let items = [...(strategies ?? [])];
    const q = search.trim().toLowerCase();
    if (q) items = items.filter((i) => [i.name, i.short_name, i.description, i.objective, i.sector].filter(Boolean).join(" ").toLowerCase().includes(q));
    if (fRisk !== "all") items = items.filter((i) => (i.risk_level || "").toLowerCase() === fRisk);
    if (fVis === "public") items = items.filter((i) => i.is_public);
    if (fVis === "featured") items = items.filter((i) => i.is_featured);
    if (fVis === "active") items = items.filter((i) => i.status === "active");
    if (sort === "name") items.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
    else if (sort === "holdings_desc") items.sort((a, b) => (b.holdings?.length || 0) - (a.holdings?.length || 0));
    return items;
  }, [strategies, search, fRisk, fVis, sort]);

  return (
    <div className="mx-auto max-w-6xl">
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-12">
        {/* Create */}
        <section className="xl:col-span-5">
          <div className="rounded-2xl border border-border bg-card p-5">
            <div className="flex items-center justify-between"><h2 className="text-base font-bold text-foreground">{editingId ? "Edit strategy" : "Create strategy"}</h2>{editingId && <span className="rounded-full bg-primary/10 px-2 py-1 text-[10px] font-bold text-primary">Editing live record</span>}</div>
            <p className="mt-1 text-xs text-muted-foreground">Add holdings to calculate weights and minimum investment. Changes require your admin password.</p>
            <div className="mt-4 space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <Field label="Strategy name"><input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="Global Growth Fund" /></Field>
                <Field label="Short name"><input className={inputCls} value={shortName} onChange={(e) => setShortName(e.target.value)} placeholder="GGF" /></Field>
              </div>
              <Field label="Description / objective"><textarea rows={2} className={cn(inputCls, "resize-none")} value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
              <div className="grid grid-cols-3 gap-3">
                <Field label="Risk level">
                  <Select value={risk || "none"} onValueChange={(v) => setRisk(v === "none" ? "" : v)}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent><SelectItem value="none">Unspecified</SelectItem><SelectItem value="low">Low</SelectItem><SelectItem value="medium">Medium</SelectItem><SelectItem value="high">High</SelectItem></SelectContent>
                  </Select>
                </Field>
                <Field label="Sector"><input className={inputCls} value={sector} onChange={(e) => setSector(e.target.value)} placeholder="Equity" /></Field>
                <Field label="Currency"><input className={inputCls} value={currency} onChange={(e) => setCurrency(e.target.value)} /></Field>
              </div>
              <div className="flex gap-4">
                <label className="flex items-center gap-2 text-xs text-foreground"><input type="checkbox" className="accent-primary" checked={isPublic} onChange={(e) => setIsPublic(e.target.checked)} />Public</label>
                <label className="flex items-center gap-2 text-xs text-foreground"><input type="checkbox" className="accent-primary" checked={isFeatured} onChange={(e) => setIsFeatured(e.target.checked)} />Featured</label>
                <label className="ml-auto flex items-center gap-2 text-xs text-foreground">Environment<select className="rounded-lg border border-input bg-background px-2 py-1" value={investorEnvironment} onChange={(e) => setInvestorEnvironment(e.target.value as "LIVE" | "UAT")}><option value="LIVE">LIVE</option><option value="UAT">UAT</option></select></label>
              </div>

              <div className="border-t border-border pt-3">
                <div className="mb-2 flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-foreground">Holdings</h3>
                  <span className="text-xs text-muted-foreground">{holdings.length} asset{holdings.length !== 1 ? "s" : ""}</span>
                </div>
                <div className="relative">
                  <input className={inputCls} value={secQuery} onChange={(e) => setSecQuery(e.target.value)} placeholder="Search securities to add (e.g. NPN)…" />
                  {secResults.length > 0 && (
                    <div className="absolute z-20 mt-1 max-h-64 w-full overflow-y-auto rounded-xl border border-border bg-popover shadow-lg">
                      {secResults.map((s) => (
                        <button key={s.symbol} type="button" onClick={() => addHolding(s)} className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-accent/50">
                          <span className="flex-1 truncate text-sm text-foreground">{s.name || s.symbol} <span className="text-xs text-muted-foreground">{s.symbol}</span></span>
                          <span className="text-xs text-muted-foreground">{s.last_price ? `R ${Number(s.last_price).toFixed(2)}` : "N/A"}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <div className="mt-3 space-y-2">
                  {holdings.length === 0 ? (
                    <div className="rounded-xl border border-dashed border-border py-4 text-center text-xs text-muted-foreground">No holdings added yet</div>
                  ) : holdings.map((h, i) => (
                    <div key={h.symbol} className="flex items-center gap-3 rounded-xl border border-border p-3">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-xs font-semibold text-foreground">{h.symbol}</p>
                        <p className="truncate text-[11px] text-muted-foreground">{h.name}</p>
                      </div>
                      <div className="text-right"><p className="text-[10px] text-muted-foreground">Shares</p>
                        <input type="number" min={1} value={h.shares} onChange={(e) => setShares(i, Number(e.target.value))} className="w-16 rounded-lg border border-input bg-background px-2 py-1 text-right text-xs outline-none" /></div>
                      <div className="w-14 text-right"><p className="text-[10px] text-muted-foreground">Weight</p><p className="text-xs font-semibold text-primary">{h.weight.toFixed(1)}%</p></div>
                      <div className="w-20 text-right"><p className="text-[10px] text-muted-foreground">Mkt Value</p><p className="text-xs text-foreground">R {h.market_value.toFixed(2)}</p></div>
                      <button type="button" onClick={() => removeHolding(i)} className="text-muted-foreground hover:text-destructive"><X className="h-3.5 w-3.5" /></button>
                    </div>
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3 border-t border-border pt-3">
                <div className="rounded-xl bg-muted/40 p-3 text-center"><p className="text-[11px] text-muted-foreground">Total Weight</p><p className={cn("mt-1 text-lg font-semibold", Math.abs(totalWeight - 100) < 0.5 ? "text-success" : "text-foreground")}>{totalWeight > 0 ? totalWeight.toFixed(1) + "%" : "0%"}</p></div>
                <div className="rounded-xl bg-primary/10 p-3 text-center"><p className="text-[11px] text-primary">Min. Investment</p><p className="mt-1 text-lg font-semibold text-primary">{minInvest > 0 ? fmtR(minInvest, currency) : "R 0"}</p></div>
              </div>

              <div className="flex justify-end pt-1"><Button onClick={submit} disabled={busy}>{busy ? "Saving…" : editingId ? "Save changes" : "Create strategy"}</Button></div>
            </div>
          </div>
        </section>

        {/* Browse */}
        <section className="xl:col-span-7">
          <div className="rounded-2xl border border-border bg-card p-5">
            <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <h2 className="text-base font-bold text-foreground">All strategies</h2>
              <div className="flex flex-wrap items-center gap-2">
                <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search…" className="h-8 w-32" />
                <MiniSelect value={fRisk} onChange={setFRisk} opts={[["all", "All risks"], ["low", "Low"], ["medium", "Medium"], ["high", "High"]]} />
                <MiniSelect value={fVis} onChange={setFVis} opts={[["all", "All visibility"], ["public", "Public"], ["featured", "Featured"], ["active", "Active"]]} />
                <MiniSelect value={sort} onChange={setSort} opts={[["recent", "Newest"], ["name", "Name A-Z"], ["holdings_desc", "Most holdings"]]} />
              </div>
            </div>
            <div className="space-y-3">
              {strategies === null ? (
                <p className="py-10 text-center text-sm text-muted-foreground">Loading…</p>
              ) : visible.length === 0 ? (
                <p className="py-10 text-center text-sm text-muted-foreground">No strategies match your filters.</p>
              ) : visible.map((s) => {
                const hs = Array.isArray(s.holdings) ? s.holdings : [];
                const min = calcMin(hs, secMap);
                const tw = hs.reduce((sum, h) => sum + (Number(h.weight) || 0), 0);
                return (
                  <button key={s.id} type="button" onClick={() => setModal(s)} className="w-full rounded-2xl border border-border p-4 text-left transition-colors hover:border-primary/40">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="mb-1 flex flex-wrap items-center gap-2">
                          <p className="font-semibold text-foreground">{s.name || "Untitled"}</p>
                          {s.short_name && <span className="text-xs text-muted-foreground">({s.short_name})</span>}
                          {s.is_featured && <span className="rounded-full bg-warning/15 px-2 py-0.5 text-[10px] font-semibold text-warning">Featured</span>}
                          {s.is_public && <span className="rounded-full bg-success/15 px-2 py-0.5 text-[10px] font-semibold text-success">Public</span>}
                        </div>
                        {s.description && <p className="mb-2 line-clamp-2 text-xs text-muted-foreground">{s.description}</p>}
                        <div className="flex items-center gap-4 text-[11px] text-muted-foreground">
                          <span>Sector: {s.sector || "Unspecified"}</span>
                          <span>{hs.length} holding{hs.length !== 1 ? "s" : ""}</span>
                          {tw > 0 && <span>Weight: {tw.toFixed(1)}%</span>}
                        </div>
                      </div>
                      <div className="flex flex-col items-end gap-1">
                        <span className={cn("rounded-full px-2 py-0.5 text-[11px]", riskCls(s.risk_level))}>{(s.risk_level || "unspecified").toLowerCase()}</span>
                        <span className="text-xs font-medium text-foreground">{min ? fmtR(min, s.base_currency || "ZAR") : "No min"}</span>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        </section>
      </div>

      {/* Modal */}
      <Dialog open={!!modal} onOpenChange={(o) => !o && setModal(null)}>
        <DialogContent className="max-h-[90vh] max-w-lg overflow-y-auto">
          {modal && <StrategyDetail strategy={modal} secMap={secMap} />}
        </DialogContent>
      </Dialog>
      <Dialog open={passwordOpen} onOpenChange={setPasswordOpen}>
        <DialogContent className="max-w-sm">
          <h2 className="text-base font-bold">Confirm strategy changes</h2>
          <p className="mt-1 text-xs text-muted-foreground">Enter your admin password to {editingId ? "update" : "create"} this strategy.</p>
          <input autoFocus type="password" value={savePassword} onChange={(event) => setSavePassword(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void performSave(); }} className={cn(inputCls, "mt-4")} placeholder="Admin password" />
          <div className="mt-4 flex justify-end gap-2"><Button variant="outline" onClick={() => setPasswordOpen(false)}>Cancel</Button><Button disabled={busy || !savePassword} onClick={performSave}>{busy ? "Saving…" : "Confirm & save"}</Button></div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><label className="mb-1 block text-xs font-medium text-muted-foreground">{label}</label>{children}</div>;
}
function MiniSelect({ value, onChange, opts }: { value: string; onChange: (v: string) => void; opts: [string, string][] }) {
  return (
    <div className="w-32">
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
        <SelectContent>{opts.map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}</SelectContent>
      </Select>
    </div>
  );
}
function StrategyDetail({ strategy, secMap }: { strategy: Strategy; secMap: Map<string, Sec> }) {
  const hs = Array.isArray(strategy.holdings) ? strategy.holdings : [];
  const tw = hs.reduce((sum, h) => sum + (Number(h.weight) || 0), 0);
  const min = calcMin(hs, secMap);
  return (
    <div>
      <h2 className="text-lg font-semibold text-foreground">{strategy.name || "Untitled"}</h2>
      <p className="mt-0.5 text-sm text-muted-foreground">{strategy.short_name || ""}{strategy.sector ? ` · ${strategy.sector}` : ""}</p>
      {strategy.description && <p className="mt-3 text-sm text-foreground/80">{strategy.description}</p>}
      <div className="mt-4 grid grid-cols-3 gap-3">
        <Stat label="Holdings" value={String(hs.length)} />
        <Stat label="Total Weight" value={`${tw.toFixed(1)}%`} />
        <Stat label="Min. Investment" value={min ? fmtR(min) : "N/A"} accent />
      </div>
      {hs.length > 0 && (
        <div className="mt-4 border-t border-border pt-4">
          <h3 className="mb-2 text-sm font-semibold text-foreground">Portfolio Holdings</h3>
          <div className="divide-y divide-border">
            {hs.map((h, i) => {
              const sym = String(h.ticker || h.symbol || "");
              const sec = secMap.get(sym) || secMap.get(normalize(sym));
              const price = sec?.last_price ? Number(sec.last_price) : 0;
              const shares = Number(h.shares || h.quantity || 1);
              const wNorm = tw > 0 ? ((Number(h.weight) || 0) / tw) * 100 : 0;
              const chg = sec?.change_percent != null ? Number(sec.change_percent) : null;
              return (
                <div key={`${sym}-${i}`} className="flex items-center gap-3 py-2">
                  <div className="min-w-0 flex-1"><p className="text-sm font-semibold text-foreground">{sym}</p><p className="truncate text-xs text-muted-foreground">{sec?.name || sym}</p></div>
                  <div className="text-right"><p className="text-xs font-semibold text-foreground">{shares} share{shares !== 1 ? "s" : ""}</p><p className="text-[11px] text-muted-foreground">R {(shares * price).toFixed(2)}</p></div>
                  <div className="w-16 text-right">
                    <p className="text-xs font-semibold text-primary">{wNorm.toFixed(1)}%</p>
                    {chg != null && <p className={cn("text-[11px] font-medium", chg >= 0 ? "text-success" : "text-destructive")}>{chg >= 0 ? "+" : ""}{chg.toFixed(2)}%</p>}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return <div className={cn("rounded-xl p-3 text-center", accent ? "bg-primary/10" : "bg-muted/40")}><p className={cn("text-[11px]", accent ? "text-primary" : "text-muted-foreground")}>{label}</p><p className={cn("mt-0.5 text-base font-semibold", accent ? "text-primary" : "text-foreground")}>{value}</p></div>;
}
