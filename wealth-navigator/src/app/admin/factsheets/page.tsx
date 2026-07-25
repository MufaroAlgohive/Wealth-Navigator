"use client";

import * as React from "react";
import { ArrowLeft } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { DataSourceBadge } from "@/components/oems/primitives/data-source-badge";
import { cn } from "@/lib/cn";

interface Sec { symbol: string; name: string | null; logo_url: string | null; last_price: number | null; change_percent?: number | null; }
interface Holding { symbol?: string; ticker?: string; shares?: number; quantity?: number; weight?: number; }
interface Strategy {
  id: string; name: string | null; short_name: string | null; description: string | null; sector: string | null;
  risk_level: string | null; base_currency: string | null; status: string | null; is_public: boolean | null;
  is_featured: boolean | null; tags: string[] | null; holdings: Holding[] | null;
}
interface ReturnRow { as_of_date: string; ytd_pct: number | null; all_pct: number | null; basket_value: number | null; }
interface ListReturns { latest: { ytd_pct: number | null; all_pct: number | null } | null; series: number[]; }

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const FEES = [
  "Management fee: as per strategy mandate.",
  "Execution reserve (cash): 8% of invested capital, held for slippage.",
  "Custody fee per asset applies — see App Settings.",
  "Past performance is not indicative of future results. Capital at risk.",
];

const normalize = (s: string) => (typeof s === "string" && s.trim() ? s.trim().split(".")[0]!.toUpperCase() : s);
const fmtR = (v: number | null, ccy = "ZAR") => {
  const n = Number(v);
  if (!n || Number.isNaN(n)) return "N/A";
  try { return new Intl.NumberFormat("en-ZA", { style: "currency", currency: ccy, maximumFractionDigits: 0 }).format(n); }
  catch { return `R ${n.toLocaleString()}`; }
};
const pctCls = (n: number | null) => (n == null ? "text-muted-foreground" : n >= 0 ? "text-success" : "text-destructive");
const pctStr = (n: number | null) => (n == null ? "—" : `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`);
function calcMin(holdings: Holding[], secMap: Map<string, Sec>): number | null {
  let total = 0, matched = 0;
  for (const h of holdings) {
    const sym = String(h.ticker || h.symbol || "");
    const sec = secMap.get(sym) || secMap.get(normalize(sym));
    if (sec && sec.last_price != null) { total += Number(h.shares || h.quantity || 1) * Number(sec.last_price); matched++; }
  }
  return matched > 0 ? Math.round(total) : null;
}
function sparkPath(series: number[], w = 120, h = 32): { d: string; up: boolean } {
  if (series.length < 2) return { d: "", up: true };
  const min = Math.min(...series), max = Math.max(...series), range = max - min || 1;
  const pts = series.map((v, i) => [(i / (series.length - 1)) * w, h - ((v - min) / range) * h]);
  const d = pts.map((p, i) => `${i === 0 ? "M" : "L"}${p[0]!.toFixed(1)},${p[1]!.toFixed(1)}`).join(" ");
  return { d, up: (series[series.length - 1] ?? 0) >= (series[0] ?? 0) };
}
function iconHue(name: string) { let h = 0; for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360; return h; }

export default function FactsheetsPage() {
  const [detailId, setDetailId] = React.useState<string | null>(null);
  React.useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("id");
    if (id) setDetailId(id);
  }, []);

  return detailId ? <Detail id={detailId} onBack={() => setDetailId(null)} /> : <Gallery onOpen={setDetailId} />;
}

// ───────────────────────────── Gallery ─────────────────────────────
function Gallery({ onOpen }: { onOpen: (id: string) => void }) {
  const [strategies, setStrategies] = React.useState<Strategy[] | null>(null);
  const [returns, setReturns] = React.useState<Record<string, ListReturns>>({});
  const [investors, setInvestors] = React.useState<Record<string, number>>({});
  const [filter, setFilter] = React.useState("all");
  const [search, setSearch] = React.useState("");
  const [sort, setSort] = React.useState("recent");

  React.useEffect(() => {
    (async () => {
      const d = await fetch("/api/admin/factsheets?action=list").then((r) => r.json()).catch(() => ({ ok: false }));
      setStrategies(d.ok ? d.strategies || [] : []);
      setReturns(d.ok ? d.returns || {} : {});
      setInvestors(d.ok ? d.investors || {} : {});
    })();
  }, []);

  const ytdOf = (id: string) => returns[id]?.latest?.ytd_pct ?? null;
  const liveCount = (strategies ?? []).filter((s) => s.status === "live" || s.status === "active").length;
  const totalInvestors = Object.values(investors).reduce((a, b) => a + b, 0);
  const ytds = (strategies ?? []).map((s) => ytdOf(s.id)).filter((v): v is number => v != null);
  const avgYtd = ytds.length ? ytds.reduce((a, b) => a + b, 0) / ytds.length : null;
  const top = (strategies ?? []).reduce<{ name: string; ytd: number } | null>((best, s) => {
    const y = ytdOf(s.id); if (y == null) return best; return !best || y > best.ytd ? { name: s.name || "—", ytd: y } : best;
  }, null);
  const spotlight = (strategies ?? []).find((s) => s.is_featured) || (strategies ?? [])[0] || null;

  const visible = React.useMemo(() => {
    let items = [...(strategies ?? [])];
    if (filter !== "all") items = items.filter((s) => (s.status || "draft") === filter);
    const q = search.trim().toLowerCase();
    if (q) items = items.filter((s) => [s.name, s.short_name, s.description].filter(Boolean).join(" ").toLowerCase().includes(q));
    if (sort === "name") items.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
    else if (sort === "ytd") items.sort((a, b) => (ytdOf(b.id) ?? -999) - (ytdOf(a.id) ?? -999));
    return items;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [strategies, returns, filter, search, sort]);

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      {/* Overview band */}
      <div className="flex justify-end">
        <DataSourceBadge source="hybrid" db="retail" />
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Kpi label="Strategies Live" value={String(liveCount)} />
        <Kpi label="Total Investors" value={String(totalInvestors)} />
        <Kpi label="Avg YTD" value={avgYtd == null ? "—" : pctStr(avgYtd)} valueCls={pctCls(avgYtd)} />
        <Kpi label="Top Performer" value={top ? top.name : "—"} sub={top ? pctStr(top.ytd) : undefined} />
      </div>

      {/* Spotlight */}
      {spotlight && (
        <button type="button" onClick={() => onOpen(spotlight.id)} className="block w-full rounded-2xl border border-primary/30 bg-gradient-to-br from-primary/10 to-transparent p-5 text-left">
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-primary">Spotlight</div>
              <div className="mt-1 text-lg font-bold text-foreground">{spotlight.name}</div>
              {spotlight.description && <p className="mt-1 line-clamp-2 max-w-xl text-sm text-muted-foreground">{spotlight.description}</p>}
            </div>
            <div className="shrink-0 text-right">
              <div className={cn("text-2xl font-bold", pctCls(ytdOf(spotlight.id)))}>{pctStr(ytdOf(spotlight.id))}</div>
              <div className="text-[11px] text-muted-foreground">YTD</div>
              <Spark series={returns[spotlight.id]?.series ?? []} />
            </div>
          </div>
        </button>
      )}

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex gap-1 rounded-lg bg-muted p-0.5">
          {["all", "live", "staged", "draft"].map((f) => (
            <button key={f} onClick={() => setFilter(f)} className={cn("rounded px-3 py-1 text-xs font-medium capitalize", filter === f ? "bg-background text-foreground shadow" : "text-muted-foreground")}>{f}</button>
          ))}
        </div>
        <div className="flex-1" />
        <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search…" className="h-8 w-40" />
        <div className="w-32"><Select value={sort} onValueChange={setSort}><SelectTrigger className="h-8"><SelectValue /></SelectTrigger><SelectContent>
          <SelectItem value="recent">Newest</SelectItem><SelectItem value="name">Name A-Z</SelectItem><SelectItem value="ytd">Top YTD</SelectItem>
        </SelectContent></Select></div>
      </div>

      {/* Grid */}
      {strategies === null ? (
        <p className="py-10 text-center text-sm text-muted-foreground">Loading…</p>
      ) : visible.length === 0 ? (
        <p className="py-10 text-center text-sm text-muted-foreground">No strategies.</p>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {visible.map((s) => {
            const hs = Array.isArray(s.holdings) ? s.holdings : [];
            const ytd = ytdOf(s.id);
            return (
              <button key={s.id} type="button" onClick={() => onOpen(s.id)} className="rounded-2xl border border-border bg-card p-4 text-left transition-colors hover:border-primary/40">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex h-9 w-9 items-center justify-center rounded-lg text-[12px] font-bold text-white" style={{ background: `hsl(${iconHue(s.name || "x")} 60% 50%)` }}>{(s.name || "S").slice(0, 2).toUpperCase()}</div>
                  <div className={cn("text-right text-lg font-bold", pctCls(ytd))}>{pctStr(ytd)}<div className="text-[10px] font-normal text-muted-foreground">YTD</div></div>
                </div>
                <div className="mt-2 font-semibold text-foreground">{s.name}</div>
                {s.description && <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{s.description}</p>}
                <div className="mt-3 flex items-center gap-3 text-[11px] text-muted-foreground">
                  <span>{hs.length} holdings</span>
                  <span>{investors[s.id] || 0} investors</span>
                  {s.is_featured && <span className="rounded-full bg-warning/15 px-2 text-warning">Featured</span>}
                  <span className="ml-auto capitalize">{s.status || "draft"}</span>
                </div>
                <div className="mt-2"><Spark series={returns[s.id]?.series ?? []} /></div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ───────────────────────────── Detail ─────────────────────────────
function Detail({ id, onBack }: { id: string; onBack: () => void }) {
  const [data, setData] = React.useState<{ strategy: Strategy; returns: ReturnRow[]; securities: Record<string, Sec> } | null>(null);
  const [notFound, setNotFound] = React.useState(false);
  const [year, setYear] = React.useState<number | null>(null);
  const [reserveRate, setReserveRate] = React.useState<number | null>(null);

  React.useEffect(() => {
    (async () => {
      const d = await fetch(`/api/admin/factsheets?action=detail&id=${id}`).then((r) => r.json()).catch(() => ({ ok: false }));
      if (d.ok) {
        // securities_c.last_price is stored in CENTS; this view renders Rands
        // (holding value, min investment). Normalise to Rands once at ingestion.
        const rawSecs: Record<string, Sec> = d.securities || {};
        const securities: Record<string, Sec> = {};
        for (const k in rawSecs) { const sc = rawSecs[k]; if (!sc) continue; securities[k] = sc.last_price != null ? { ...sc, last_price: Number(sc.last_price) / 100 } : sc; }
        setData({ strategy: d.strategy, returns: d.returns || [], securities });
      }
      else setNotFound(true);
    })();
  }, [id]);

  // The CASH row weight = the configured execution-reserve app-setting, not a
  // hardcoded constant. Defensive: accepts a fraction (0.08) or a percent (8);
  // falls back to the documented 8% default if the setting isn't available.
  React.useEffect(() => {
    (async () => {
      const r = await fetch(`/api/admin/app-settings`).then((x) => x.json()).catch(() => null);
      const raw = r?.settings?.executionReserveRate ?? r?.executionReserveRate;
      const n = Number(raw);
      if (Number.isFinite(n) && n > 0) setReserveRate(n <= 1 ? n * 100 : n);
    })();
  }, []);

  const secMap = React.useMemo(() => {
    const m = new Map<string, Sec>();
    for (const [k, v] of Object.entries(data?.securities ?? {})) { m.set(k, v as Sec); const n = normalize(k); if (n !== k) m.set(n, v as Sec); }
    return m;
  }, [data]);

  if (notFound) return <div className="py-16 text-center text-sm text-muted-foreground">Strategy not found. <button onClick={onBack} className="text-primary underline">Back</button></div>;
  if (!data) return <p className="py-16 text-center text-sm text-muted-foreground">Loading…</p>;

  const { strategy: s, returns } = data;
  const hs = Array.isArray(s.holdings) ? s.holdings : [];
  const tw = hs.reduce((sum, h) => sum + (Number(h.weight) || 0), 0);
  const min = calcMin(hs, secMap);
  const latest = returns[returns.length - 1] ?? null;

  // Daily returns from basket_value series
  const series = returns.filter((r) => r.basket_value != null);
  const daily: number[] = [];
  for (let i = 1; i < series.length; i++) {
    const prev = Number(series[i - 1]!.basket_value), cur = Number(series[i]!.basket_value);
    if (prev > 0) daily.push((cur / prev - 1) * 100);
  }
  const best = daily.length ? Math.max(...daily) : null;
  const worst = daily.length ? Math.min(...daily) : null;
  const avg = daily.length ? daily.reduce((a, b) => a + b, 0) / daily.length : null;

  // Calendar: monthly returns from end-of-month basket_value
  const monthEnd: Record<string, number> = {};
  for (const r of series) { const ym = r.as_of_date.slice(0, 7); monthEnd[ym] = Number(r.basket_value); }
  const yms = Object.keys(monthEnd).sort();
  const monthly: Record<string, Record<number, number>> = {};
  for (let i = 1; i < yms.length; i++) {
    const [y, m] = yms[i]!.split("-").map(Number);
    const ret = (monthEnd[yms[i]!]! / monthEnd[yms[i - 1]!]! - 1) * 100;
    (monthly[String(y)] ||= {})[m! - 1] = ret;
  }
  const years = Object.keys(monthly).sort().reverse();
  const activeYear = year ?? (years.length ? Number(years[0]) : null);

  const cashWeight = reserveRate ?? 8;
  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <button onClick={onBack} className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="h-4 w-4" /> Back to factsheets</button>

      <div className="rounded-2xl border border-border bg-card p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold text-foreground">{s.name}</h1>
            <p className="mt-1 text-sm text-muted-foreground">{s.short_name || ""}{s.sector ? ` · ${s.sector}` : ""}</p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {s.risk_level && <Tag>{s.risk_level}</Tag>}
              {s.status && <Tag>{s.status}</Tag>}
              {s.is_public && <Tag tone="success">Public</Tag>}
              {s.is_featured && <Tag tone="warning">Featured</Tag>}
              {(s.tags ?? []).map((t) => <Tag key={t}>{t}</Tag>)}
            </div>
          </div>
          <DataSourceBadge source="hybrid" db="retail" />
        </div>
        {s.description && <p className="mt-4 text-sm text-foreground/80">{s.description}</p>}

        <div className="mt-5 grid grid-cols-3 gap-3">
          <Kpi label="Holdings" value={String(hs.length)} />
          <Kpi label="Min. Investment" value={min ? fmtR(min, s.base_currency || "ZAR") : "N/A"} />
          <Kpi label="All-time Return" value={pctStr(latest?.all_pct ?? null)} valueCls={pctCls(latest?.all_pct ?? null)} />
        </div>
      </div>

      {/* Performance summary */}
      <div className="flex justify-end">
        <DataSourceBadge source="supabase" db="retail" />
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Kpi label="Best Day" value={pctStr(best)} valueCls={pctCls(best)} />
        <Kpi label="Worst Day" value={pctStr(worst)} valueCls={pctCls(worst)} />
        <Kpi label="Avg Daily" value={pctStr(avg)} valueCls={pctCls(avg)} />
        <Kpi label="YTD" value={pctStr(latest?.ytd_pct ?? null)} valueCls={pctCls(latest?.ytd_pct ?? null)} />
      </div>

      {/* Holdings */}
      <div className="rounded-2xl border border-border bg-card p-5">
        <div className="mb-3 flex items-center justify-between gap-2">
          <h3 className="text-sm font-bold text-foreground">Portfolio Holdings</h3>
          <DataSourceBadge source="hybrid" db="retail" />
        </div>
        <div className="divide-y divide-border">
          {hs.map((h, i) => {
            const sym = String(h.ticker || h.symbol || "");
            const sec = secMap.get(sym) || secMap.get(normalize(sym));
            const price = sec?.last_price ? Number(sec.last_price) : 0;
            const shares = Number(h.shares || h.quantity || 1);
            const wNorm = tw > 0 ? ((Number(h.weight) || 0) / tw) * (100 - cashWeight) : 0;
            const chg = sec?.change_percent != null ? Number(sec.change_percent) : null;
            return (
              <div key={`${sym}-${i}`} className="flex items-center gap-3 py-2.5">
                <div className="min-w-0 flex-1"><p className="text-sm font-semibold text-foreground">{sym}</p><p className="truncate text-xs text-muted-foreground">{sec?.name || sym}</p></div>
                <div className="text-right text-xs text-muted-foreground">{shares} sh · R {(shares * price).toFixed(2)}</div>
                <div className="w-16 text-right"><p className="text-xs font-semibold text-primary">{wNorm.toFixed(1)}%</p>{chg != null && <p className={cn("text-[11px]", pctCls(chg))}>{pctStr(chg)}</p>}</div>
              </div>
            );
          })}
          <div className="flex items-center gap-3 py-2.5">
            <div className="min-w-0 flex-1"><p className="text-sm font-semibold text-foreground">CASH</p><p className="text-xs text-muted-foreground">Execution reserve</p></div>
            <div className="text-right text-xs text-muted-foreground">{min ? fmtR(Math.round((min * cashWeight) / 100)) : "—"}</div>
            <div className="w-16 text-right text-xs font-semibold text-primary">{cashWeight.toFixed(1)}%</div>
          </div>
        </div>
      </div>

      {/* Calendar */}
      {years.length > 0 && activeYear != null && (
        <div className="rounded-2xl border border-border bg-card p-5">
          <div className="mb-3 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-bold text-foreground">Monthly Returns</h3>
              <DataSourceBadge source="supabase" db="retail" />
            </div>
            <div className="flex gap-1">{years.map((y) => <button key={y} onClick={() => setYear(Number(y))} className={cn("rounded px-2 py-0.5 text-xs", Number(y) === activeYear ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground")}>{y}</button>)}</div>
          </div>
          <div className="grid grid-cols-6 gap-1.5 sm:grid-cols-12">
            {MONTHS.map((m, i) => {
              const v = monthly[String(activeYear)]?.[i];
              return (
                <div key={m} className={cn("rounded-md px-1 py-2 text-center", v == null ? "bg-muted/30" : v >= 0 ? "bg-success/15" : "bg-destructive/15")}>
                  <div className="text-[9px] uppercase text-muted-foreground">{m}</div>
                  <div className={cn("text-[11px] font-semibold", v == null ? "text-muted-foreground" : pctCls(v))}>{v == null ? "·" : `${v >= 0 ? "+" : ""}${v.toFixed(1)}`}</div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Fees */}
      <div className="rounded-2xl border border-border bg-card p-5">
        <h3 className="mb-2 text-sm font-bold text-foreground">Fees & Disclaimers</h3>
        <ul className="list-inside list-disc space-y-1 text-xs text-muted-foreground">{FEES.map((f) => <li key={f}>{f}</li>)}</ul>
      </div>
    </div>
  );
}

function Spark({ series }: { series: number[] }) {
  if (series.length < 2) return <div className="h-8 w-[120px]" />;
  const { d, up } = sparkPath(series);
  return <svg viewBox="0 0 120 32" className="h-8 w-[120px]"><path d={d} fill="none" stroke={up ? "hsl(var(--success))" : "hsl(var(--destructive))"} strokeWidth={1.5} /></svg>;
}
function Kpi({ label, value, sub, valueCls }: { label: string; value: string; sub?: string; valueCls?: string }) {
  return <div className="rounded-xl border border-border bg-card px-4 py-3"><div className="text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</div><div className={cn("mt-1 truncate text-base font-bold text-foreground", valueCls)}>{value}</div>{sub && <div className={cn("text-[11px]", valueCls)}>{sub}</div>}</div>;
}
function Tag({ children, tone }: { children: React.ReactNode; tone?: "success" | "warning" }) {
  return <span className={cn("rounded-full px-2.5 py-0.5 text-[11px] font-semibold capitalize", tone === "success" ? "bg-success/15 text-success" : tone === "warning" ? "bg-warning/15 text-warning" : "bg-muted text-muted-foreground")}>{children}</span>;
}
