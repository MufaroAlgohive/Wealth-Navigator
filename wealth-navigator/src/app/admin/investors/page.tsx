"use client";

import * as React from "react";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, PieChart, Pie, Cell } from "recharts";

import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { cn } from "@/lib/cn";

/* ── Types (raw payload) ── */
interface Holding { user_id: string; family_member_id: string | null; security_id: string; strategy_id: string | null; quantity: number; avg_fill: number | null; Expected_fill: number | null; }
interface ClosedHolding { user_id: string; quantity: number; avg_fill: number | null; avg_exit: number | null; }
interface NavRow { user_id: string; as_of_date: string; basket_value: number | null; ytd_pct: number | null; inception_pct: number | null; inception_pnl: number | null; }
interface Profile { id: string; first_name: string | null; last_name: string | null; email: string | null; mint_number: string | null; computershare_number: string | null; }
interface SecMeta { id: string; symbol: string; name: string | null; sector: string | null; logo_url: string | null; }
interface SecLive { security_id: string; current_price: number | null; }
interface Txn { id: string; user_id: string; amount: number; direction: string; name: string | null; description: string | null; status: string | null; transaction_date: string | null; broker_fee_cents: number | null; isin_fee_cents: number | null; transaction_fee_cents: number | null; buffer_consumed_cents: number | null; }
interface Residual { user_id: string; balance_cents: number | null; }
interface Payload { holdings: Holding[]; profiles: Profile[]; secMeta: SecMeta[]; secLive: SecLive[]; txns: Txn[]; residuals: Residual[]; closedHoldings: ClosedHolding[]; stratHist: NavRow[]; }

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const PIE = ["#7c5cff", "#22c55e", "#f59e0b", "#38bdf8", "#ec4899", "#ef4444", "#a3a3a3", "#14b8a6", "#eab308", "#8b5cf6"];

const R = (cents: number) => new Intl.NumberFormat("en-ZA", { style: "currency", currency: "ZAR", maximumFractionDigits: 0 }).format(cents / 100);
const pctCls = (n: number | null) => (n == null ? "text-muted-foreground" : n >= 0 ? "text-success" : "text-destructive");
const pctStr = (n: number | null) => (n == null ? "—" : `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`);

function costCentsPerShare(h: Holding): number {
  const avgCents = Number(h.avg_fill) || 0;
  const expectedRaw = Number(h.Expected_fill) || 0;
  if (expectedRaw > 0) {
    const avgRands = avgCents > 0 ? avgCents / 100 : 0;
    const expectedRands = avgRands > 0 && expectedRaw > avgRands * 5 ? expectedRaw / 100 : expectedRaw;
    return Math.round(expectedRands * 100);
  }
  return avgCents > 0 ? avgCents : 0;
}

interface HoldingView { securityId: string; symbol: string; name: string; sector: string; qty: number; valueCents: number; investedCents: number; pnlCents: number; }
interface Investor {
  userId: string; name: string; email: string; mintNumber: string | null; computershare: string | null;
  investedCents: number; currentCents: number; residualCents: number; realizedCents: number; valueCents: number; pnlCents: number; retPct: number;
  ytdPct: number | null; inceptionPct: number | null;
  nav: { date: string; v: number }[]; holdings: HoldingView[]; txns: Txn[];
}

function computeRisk(nav: { v: number }[]) {
  const series = nav.map((p) => p.v).filter((v) => v > 0);
  if (series.length < 3) return { sharpe: null, sortino: null, vol: null, maxDD: null, annRet: null };
  const rets: number[] = [];
  for (let i = 1; i < series.length; i++) rets.push(series[i]! / series[i - 1]! - 1);
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length;
  const std = Math.sqrt(variance);
  const downside = Math.sqrt(rets.filter((r) => r < 0).reduce((a, b) => a + b * b, 0) / rets.length);
  let peak = series[0]!, maxDD = 0;
  for (const v of series) { if (v > peak) peak = v; const dd = (v - peak) / peak; if (dd < maxDD) maxDD = dd; }
  return {
    sharpe: std > 0 ? (mean / std) * Math.sqrt(252) : null,
    sortino: downside > 0 ? (mean / downside) * Math.sqrt(252) : null,
    vol: std * Math.sqrt(252) * 100,
    maxDD: maxDD * 100,
    annRet: mean * 252 * 100,
  };
}
function computeCalendar(nav: { date: string; v: number }[]) {
  const monthEnd: Record<string, number> = {};
  for (const p of nav) if (p.v > 0) monthEnd[p.date.slice(0, 7)] = p.v;
  const yms = Object.keys(monthEnd).sort();
  const out: Record<string, Record<number, number>> = {};
  for (let i = 1; i < yms.length; i++) {
    const [y, m] = yms[i]!.split("-").map(Number);
    (out[String(y)] ||= {})[m! - 1] = (monthEnd[yms[i]!]! / monthEnd[yms[i - 1]!]! - 1) * 100;
  }
  return out;
}
function classifyTxn(t: Txn): string {
  const n = `${t.name || ""} ${t.description || ""}`.toLowerCase();
  if (n.includes("withdraw")) return "Withdrawal";
  if (n.includes("fee")) return "Fee";
  if (n.includes("rebalance")) return "Rebalance";
  if (n.includes("refund") || n.includes("reversal")) return "Refund";
  if (n.includes("invest") || n.includes("purchas") || (Number(t.amount) || 0) > 0) return "Investment";
  return "Deposit";
}

export default function InvestorsPage() {
  const [data, setData] = React.useState<Payload | null>(null);
  const [search, setSearch] = React.useState("");
  const [selId, setSelId] = React.useState<string | null>(null);
  const [tab, setTab] = React.useState("performance");

  React.useEffect(() => {
    fetch("/api/admin/investors/data").then((r) => r.json()).then((d) => setData(d.ok ? d : { holdings: [], profiles: [], secMeta: [], secLive: [], txns: [], residuals: [], closedHoldings: [], stratHist: [] })).catch(() => setData({ holdings: [], profiles: [], secMeta: [], secLive: [], txns: [], residuals: [], closedHoldings: [], stratHist: [] } as Payload));
  }, []);

  const investors = React.useMemo<Investor[]>(() => {
    if (!data) return [];
    const secMetaById = new Map(data.secMeta.map((s) => [s.id, s]));
    const liveById = new Map(data.secLive.map((s) => [s.security_id, Number(s.current_price) || 0]));
    const profById = new Map(data.profiles.map((p) => [p.id, p]));
    const residualByUser: Record<string, number> = {};
    for (const r of data.residuals) residualByUser[r.user_id] = (residualByUser[r.user_id] || 0) + (Number(r.balance_cents) || 0);
    const realizedByUser: Record<string, number> = {};
    for (const c of data.closedHoldings) { const v = ((Number(c.avg_exit) || 0) - (Number(c.avg_fill) || 0)) * Number(c.quantity || 0); realizedByUser[c.user_id] = (realizedByUser[c.user_id] || 0) + v; }
    const navByUser: Record<string, NavRow[]> = {};
    for (const r of data.stratHist) (navByUser[r.user_id] ||= []).push(r);
    const txnByUser: Record<string, Txn[]> = {};
    for (const t of data.txns) (txnByUser[t.user_id] ||= []).push(t);
    const holdsByUser: Record<string, Holding[]> = {};
    for (const h of data.holdings) (holdsByUser[h.user_id] ||= []).push(h);

    const out: Investor[] = [];
    for (const userId of Object.keys(holdsByUser)) {
      const hs = holdsByUser[userId]!;
      const bysecurity: Record<string, HoldingView> = {};
      let investedCents = 0, currentCents = 0;
      for (const h of hs) {
        const live = liveById.get(h.security_id) || costCentsPerShare(h);
        const qty = Number(h.quantity) || 0;
        const mv = qty * live;
        const inv = costCentsPerShare(h) * qty;
        investedCents += inv; currentCents += mv;
        const meta = secMetaById.get(h.security_id);
        const v = (bysecurity[h.security_id] ||= { securityId: h.security_id, symbol: meta?.symbol || "—", name: meta?.name || meta?.symbol || "—", sector: meta?.sector || "Other", qty: 0, valueCents: 0, investedCents: 0, pnlCents: 0 });
        v.qty += qty; v.valueCents += mv; v.investedCents += inv; v.pnlCents = v.valueCents - v.investedCents;
      }
      const residualCents = residualByUser[userId] || 0;
      const realizedCents = realizedByUser[userId] || 0;
      const valueCents = currentCents + residualCents;
      const pnlCents = currentCents - investedCents + realizedCents;
      const nav = (navByUser[userId] || []).filter((r) => r.basket_value != null).map((r) => ({ date: r.as_of_date, v: Number(r.basket_value) }));
      const latestNav = (navByUser[userId] || [])[(navByUser[userId] || []).length - 1];
      const prof = profById.get(userId);
      out.push({
        userId, name: prof ? `${prof.first_name || ""} ${prof.last_name || ""}`.trim() || prof.email || userId.slice(0, 8) : userId.slice(0, 8),
        email: prof?.email || "", mintNumber: prof?.mint_number || null, computershare: prof?.computershare_number || null,
        investedCents, currentCents, residualCents, realizedCents, valueCents, pnlCents,
        retPct: investedCents > 0 ? (pnlCents / investedCents) * 100 : 0,
        ytdPct: latestNav?.ytd_pct ?? null, inceptionPct: latestNav?.inception_pct ?? null,
        nav, holdings: Object.values(bysecurity).sort((a, b) => b.valueCents - a.valueCents), txns: txnByUser[userId] || [],
      });
    }
    return out.sort((a, b) => b.valueCents - a.valueCents);
  }, [data]);

  const kpi = React.useMemo(() => {
    const aum = investors.reduce((s, i) => s + i.valueCents, 0);
    const invested = investors.reduce((s, i) => s + i.investedCents, 0);
    const pnl = investors.reduce((s, i) => s + i.pnlCents, 0);
    const avgRet = investors.length ? investors.reduce((s, i) => s + i.retPct, 0) / investors.length : 0;
    const sorted = [...investors].filter((i) => i.investedCents > 0).sort((a, b) => b.retPct - a.retPct);
    return { aum, invested, pnl, avgRet, best: sorted[0] || null, worst: sorted[sorted.length - 1] || null };
  }, [investors]);

  const filtered = investors.filter((i) => !search.trim() || `${i.name} ${i.email}`.toLowerCase().includes(search.toLowerCase()));
  const sel = investors.find((i) => i.userId === selId) || null;

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      {/* KPI bar */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-6">
        <Kpi label="Total AUM" value={R(kpi.aum)} />
        <Kpi label="Invested" value={R(kpi.invested)} />
        <Kpi label="Total P&L" value={R(kpi.pnl)} valueCls={pctCls(kpi.pnl)} />
        <Kpi label="Avg Return" value={pctStr(kpi.avgRet)} valueCls={pctCls(kpi.avgRet)} />
        <Kpi label="Best" value={kpi.best ? kpi.best.name.split(" ")[0]! : "—"} sub={kpi.best ? pctStr(kpi.best.retPct) : undefined} subCls={pctCls(kpi.best?.retPct ?? null)} />
        <Kpi label="Worst" value={kpi.worst ? kpi.worst.name.split(" ")[0]! : "—"} sub={kpi.worst ? pctStr(kpi.worst.retPct) : undefined} subCls={pctCls(kpi.worst?.retPct ?? null)} />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[320px_1fr]">
        {/* List */}
        <div className="rounded-2xl border border-border bg-card p-4">
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search investors…" className="mb-3 h-8" />
          <div className="max-h-[65vh] space-y-1 overflow-y-auto">
            {data === null ? <p className="py-6 text-center text-xs text-muted-foreground">Loading…</p>
              : filtered.length === 0 ? <p className="py-6 text-center text-xs text-muted-foreground">No investors.</p>
              : filtered.map((i) => (
                <button key={i.userId} onClick={() => setSelId(i.userId)} className={cn("flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-left", selId === i.userId ? "bg-primary/10" : "hover:bg-accent/50")}>
                  <div className="min-w-0"><div className="truncate text-sm font-medium text-foreground">{i.name}</div><div className="text-[11px] text-muted-foreground">{R(i.valueCents)}</div></div>
                  <span className={cn("text-xs font-semibold", pctCls(i.retPct))}>{pctStr(i.retPct)}</span>
                </button>
              ))}
          </div>
        </div>

        {/* Detail */}
        <div className="rounded-2xl border border-border bg-card p-5">
          {!sel ? <div className="flex h-full min-h-[300px] items-center justify-center text-sm text-muted-foreground">Select an investor.</div> : <InvestorDetail inv={sel} tab={tab} setTab={setTab} />}
        </div>
      </div>
    </div>
  );
}

function InvestorDetail({ inv, tab, setTab }: { inv: Investor; tab: string; setTab: (v: string) => void }) {
  const risk = React.useMemo(() => computeRisk(inv.nav), [inv]);
  const calendar = React.useMemo(() => computeCalendar(inv.nav), [inv]);
  const years = Object.keys(calendar).sort().reverse();
  const [year, setYear] = React.useState<number | null>(null);
  const activeYear = year ?? (years.length ? Number(years[0]) : null);

  const navChart = inv.nav.map((p) => ({ date: p.date, value: Math.round(p.v / 100) }));
  const sectors = React.useMemo(() => {
    const m: Record<string, number> = {};
    for (const h of inv.holdings) m[h.sector] = (m[h.sector] || 0) + h.valueCents;
    return Object.entries(m).map(([name, v]) => ({ name, value: Math.round(v / 100) })).sort((a, b) => b.value - a.value);
  }, [inv]);
  const fees = inv.txns.reduce((acc, t) => { acc.broker += Number(t.broker_fee_cents) || 0; acc.isin += Number(t.isin_fee_cents) || 0; acc.txn += Number(t.transaction_fee_cents) || 0; acc.buffer += Number(t.buffer_consumed_cents) || 0; return acc; }, { broker: 0, isin: 0, txn: 0, buffer: 0 });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3 rounded-xl bg-gradient-to-br from-primary/15 to-transparent p-4">
        <div>
          <div className="text-lg font-bold text-foreground">{inv.name}</div>
          <div className="text-xs text-muted-foreground">{inv.email}{inv.mintNumber ? ` · ${inv.mintNumber}` : ""}</div>
        </div>
        <div className="text-right">
          <div className="text-2xl font-bold text-foreground">{R(inv.valueCents)}</div>
          <div className="text-[11px] text-muted-foreground">Holdings {R(inv.currentCents)} · Cash {R(inv.residualCents)}</div>
        </div>
      </div>

      <div className="grid grid-cols-4 gap-3">
        <Kpi label="Invested" value={R(inv.investedCents)} />
        <Kpi label="P&L" value={R(inv.pnlCents)} valueCls={pctCls(inv.pnlCents)} />
        <Kpi label="YTD" value={pctStr(inv.ytdPct)} valueCls={pctCls(inv.ytdPct)} />
        <Kpi label="Inception" value={pctStr(inv.inceptionPct)} valueCls={pctCls(inv.inceptionPct)} />
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="flex-wrap">
          <TabsTrigger value="performance">Performance</TabsTrigger>
          <TabsTrigger value="risk">Risk &amp; Drawdown</TabsTrigger>
          <TabsTrigger value="allocations">Allocations</TabsTrigger>
          <TabsTrigger value="transactions">Transactions</TabsTrigger>
        </TabsList>

        <TabsContent value="performance" className="space-y-4">
          {navChart.length > 1 ? (
            <div className="h-56 w-full rounded-xl border border-border p-3">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={navChart} margin={{ top: 5, right: 5, bottom: 0, left: 0 }}>
                  <XAxis dataKey="date" hide /><YAxis hide domain={["auto", "auto"]} />
                  <Tooltip formatter={(v: number) => `R ${v.toLocaleString("en-ZA")}`} labelFormatter={(l) => String(l)} contentStyle={{ fontSize: 11 }} />
                  <Line type="monotone" dataKey="value" stroke="hsl(var(--primary))" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          ) : <p className="py-6 text-center text-xs text-muted-foreground">No NAV history.</p>}

          {years.length > 0 && activeYear != null && (
            <div className="rounded-xl border border-border p-3">
              <div className="mb-2 flex items-center justify-between"><span className="text-xs font-bold text-foreground">Monthly Returns</span>
                <div className="flex gap-1">{years.map((y) => <button key={y} onClick={() => setYear(Number(y))} className={cn("rounded px-2 py-0.5 text-[11px]", Number(y) === activeYear ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground")}>{y}</button>)}</div>
              </div>
              <div className="grid grid-cols-6 gap-1 sm:grid-cols-12">
                {MONTHS.map((m, i) => { const v = calendar[String(activeYear)]?.[i]; return <div key={m} className={cn("rounded px-1 py-1.5 text-center", v == null ? "bg-muted/30" : v >= 0 ? "bg-success/15" : "bg-destructive/15")}><div className="text-[8px] uppercase text-muted-foreground">{m}</div><div className={cn("text-[10px] font-semibold", v == null ? "text-muted-foreground" : pctCls(v))}>{v == null ? "·" : v.toFixed(1)}</div></div>; })}
              </div>
            </div>
          )}

          <HoldingsTable holdings={inv.holdings} total={inv.currentCents} top={5} />
        </TabsContent>

        <TabsContent value="risk">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
            <Kpi label="Sharpe" value={risk.sharpe == null ? "—" : risk.sharpe.toFixed(2)} />
            <Kpi label="Sortino" value={risk.sortino == null ? "—" : risk.sortino.toFixed(2)} />
            <Kpi label="Volatility" value={risk.vol == null ? "—" : `${risk.vol.toFixed(1)}%`} />
            <Kpi label="Max Drawdown" value={risk.maxDD == null ? "—" : `${risk.maxDD.toFixed(1)}%`} valueCls="text-destructive" />
            <Kpi label="Ann. Return" value={risk.annRet == null ? "—" : pctStr(risk.annRet)} valueCls={pctCls(risk.annRet)} />
          </div>
        </TabsContent>

        <TabsContent value="allocations" className="space-y-4">
          {sectors.length > 0 && (
            <div className="flex flex-col items-center gap-4 sm:flex-row">
              <div className="h-48 w-48">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart><Pie data={sectors} dataKey="value" nameKey="name" innerRadius={40} outerRadius={70} paddingAngle={2}>{sectors.map((_, i) => <Cell key={i} fill={PIE[i % PIE.length]} />)}</Pie><Tooltip formatter={(v: number) => `R ${v.toLocaleString("en-ZA")}`} contentStyle={{ fontSize: 11 }} /></PieChart>
                </ResponsiveContainer>
              </div>
              <div className="flex-1 space-y-1">
                {sectors.map((s, i) => <div key={s.name} className="flex items-center gap-2 text-xs"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: PIE[i % PIE.length] }} /><span className="flex-1 text-foreground">{s.name}</span><span className="text-muted-foreground">R {s.value.toLocaleString("en-ZA")}</span></div>)}
              </div>
            </div>
          )}
          <HoldingsTable holdings={inv.holdings} total={inv.currentCents} />
        </TabsContent>

        <TabsContent value="transactions" className="space-y-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Kpi label="Broker fees" value={R(fees.broker)} />
            <Kpi label="ISIN/custody" value={R(fees.isin)} />
            <Kpi label="Txn fees" value={R(fees.txn)} />
            <Kpi label="Buffer used" value={R(fees.buffer)} />
          </div>
          <div className="overflow-x-auto rounded-xl border border-border">
            <table className="w-full border-collapse">
              <thead><tr className="border-b border-border"><th className="px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Date</th><th className="px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Description</th><th className="px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Type</th><th className="px-3 py-2 text-right text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Amount</th></tr></thead>
              <tbody>
                {inv.txns.length === 0 ? <tr><td colSpan={4} className="px-3 py-8 text-center text-xs text-muted-foreground">No transactions.</td></tr>
                  : inv.txns.slice(0, 50).map((t) => (
                    <tr key={t.id} className="border-b border-border/40 last:border-b-0">
                      <td className="px-3 py-2 text-[12px] text-foreground">{t.transaction_date ? new Date(t.transaction_date).toLocaleDateString("en-ZA") : "—"}</td>
                      <td className="px-3 py-2 text-[12px] text-foreground">{t.name || t.description || "—"}</td>
                      <td className="px-3 py-2 text-[12px] text-muted-foreground">{classifyTxn(t)}</td>
                      <td className={cn("px-3 py-2 text-right text-[12px] font-medium", t.direction === "credit" ? "text-success" : "text-foreground")}>{t.direction === "credit" ? "+" : "-"}R {Math.abs(Number(t.amount) || 0).toLocaleString("en-ZA")}</td>
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

function HoldingsTable({ holdings, total, top }: { holdings: HoldingView[]; total: number; top?: number }) {
  const rows = top ? holdings.slice(0, top) : holdings;
  return (
    <div className="overflow-x-auto rounded-xl border border-border">
      <table className="w-full border-collapse">
        <thead><tr className="border-b border-border">
          {["Symbol", "Sector", "Qty", "Value", "Weight", "P&L"].map((c) => <th key={c} className="px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{c}</th>)}
        </tr></thead>
        <tbody>
          {rows.length === 0 ? <tr><td colSpan={6} className="px-3 py-8 text-center text-xs text-muted-foreground">No holdings.</td></tr>
            : rows.map((h) => (
              <tr key={h.securityId} className="border-b border-border/40 last:border-b-0">
                <td className="px-3 py-2 text-[12px] font-semibold text-foreground">{h.symbol}</td>
                <td className="px-3 py-2 text-[12px] text-muted-foreground">{h.sector}</td>
                <td className="px-3 py-2 text-[12px] text-foreground">{h.qty}</td>
                <td className="px-3 py-2 text-[12px] text-foreground">{R(h.valueCents)}</td>
                <td className="px-3 py-2 text-[12px] text-primary">{total > 0 ? ((h.valueCents / total) * 100).toFixed(1) : "0"}%</td>
                <td className={cn("px-3 py-2 text-[12px]", pctCls(h.pnlCents))}>{R(h.pnlCents)}</td>
              </tr>
            ))}
        </tbody>
      </table>
    </div>
  );
}

function Kpi({ label, value, sub, valueCls, subCls }: { label: string; value: string; sub?: string; valueCls?: string; subCls?: string }) {
  return <div className="rounded-xl border border-border bg-card px-3 py-2.5"><div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</div><div className={cn("mt-0.5 truncate text-sm font-bold text-foreground", valueCls)}>{value}</div>{sub && <div className={cn("text-[11px]", subCls)}>{sub}</div>}</div>;
}
