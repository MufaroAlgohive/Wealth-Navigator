"use client";

/**
 * Analysis sub-tabs — fiscal.ai-style sections, richer, all real Yahoo data or
 * honest "—". Financials, Estimates, Research (analyst consensus), Ownership
 * (insiders + institutions), Dividends, and a client-side valuation model.
 * Every tab shares ONE /deep query (react-query dedupes), so switching tabs
 * never refetches.
 */

import { useQuery } from "@tanstack/react-query";
import { CalendarDays, Scale, TrendingDown, TrendingUp } from "lucide-react";
import { useMemo, useState } from "react";

import { EmptyDataState } from "@/components/oems/primitives/empty-data-state";
import { GlassSection } from "@/components/oems/primitives/glass";
import { PanelSkeleton } from "@/components/oems/primitives/panel-skeleton";
import { Pill } from "@/components/oems/primitives/pill";
import type { CompanyDeep, EstimateRow, StatementTable as TStmt } from "@/lib/company-analysis/yahoo";
import { cn } from "@/lib/cn";
import { queryOpts } from "@/lib/store/query-provider";

// ── shared ──────────────────────────────────────────────────────────────

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function ccySym(code: string): string {
  switch ((code ?? "").toUpperCase()) {
    case "USD": return "$";
    case "ZAR": return "R";
    case "GBP":
    case "GBX": return "£";
    case "EUR": return "€";
    case "JPY": return "¥";
    default: return code ? `${code} ` : "";
  }
}
function money(v: number | null | undefined, ccy: string): string {
  if (v == null || !Number.isFinite(v)) return "—";
  const s = ccySym(ccy), a = Math.abs(v), sign = v < 0 ? "-" : "";
  if (a >= 1e12) return `${sign}${s}${(a / 1e12).toFixed(2)}T`;
  if (a >= 1e9) return `${sign}${s}${(a / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${sign}${s}${(a / 1e6).toFixed(1)}M`;
  return `${sign}${s}${a.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}
function price(v: number | null | undefined, ccy: string): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${ccySym(ccy)}${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function pct(v: number | null | undefined): string {
  return v == null || !Number.isFinite(v) ? "—" : `${(v * 100).toFixed(1)}%`;
}
function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return `${d.getUTCDate()} ${MON[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
function intFmt(v: number | null): string {
  if (v == null) return "—";
  const a = Math.abs(v);
  if (a >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  return v.toLocaleString("en-US");
}

function useDeep(sym: string) {
  return useQuery<CompanyDeep>({
    queryKey: ["company-deep", sym],
    queryFn: async () => {
      const r = await fetch(`/api/company-analysis/${encodeURIComponent(sym)}/deep`, { cache: "no-store" });
      if (!r.ok) throw new Error(`deep ${r.status}`);
      return r.json();
    },
    ...queryOpts("reference"),
    enabled: Boolean(sym),
    staleTime: 5 * 60_000,
  });
}

function DeepGate({
  sym,
  title,
  subtitle,
  children,
}: {
  sym: string;
  title: string;
  subtitle: string;
  children: (d: CompanyDeep) => React.ReactNode;
}) {
  const q = useDeep(sym);
  if (q.isLoading) return <PanelSkeleton rows={6} height="h-[360px]" />;
  if (!q.data || !q.data.ok) {
    return (
      <GlassSection title={title} subtitle={subtitle} dataSource="yahoo">
        <EmptyDataState
          reason="empty"
          message={`No data returned for ${sym}.`}
          hint={q.data?.error ?? "Yahoo did not return this dataset for the symbol."}
          badgeLabel="yahoo"
        />
      </GlassSection>
    );
  }
  return <>{children(q.data)}</>;
}

const NoteList = ({ notes }: { notes: string[] }) =>
  notes.length ? (
    <ul className="mt-3 space-y-1">
      {notes.map((n, i) => (
        <li key={i} className="text-[10.5px] leading-snug text-muted-foreground/80">· {n}</li>
      ))}
    </ul>
  ) : null;

// ── statement table ───────────────────────────────────────────────────

const BOLD_ROWS = new Set(["totalRevenue", "grossProfit", "operatingIncome", "netIncome", "totalAssets", "totalStockholderEquity", "totalCashFromOperatingActivities", "freeCashFlow"]);

function StatementView({ table, ccy }: { table: TStmt; ccy: string }) {
  if (!table.periods.length || !table.rows.length) {
    return (
      <EmptyDataState reason="empty" message="No statement data for this period type." hint="Yahoo did not return these statements for this symbol." badgeLabel="yahoo" />
    );
  }
  return (
    <div className="glass-inset overflow-hidden rounded-xl">
      <div className="overflow-x-auto scrollbar-thin">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-[hsl(var(--glass-border))] bg-[hsl(var(--foreground)/0.02)]">
              <th className="sticky left-0 bg-[hsl(var(--background))] px-3 py-2.5 text-left font-medium text-muted-foreground">Line item</th>
              {table.periods.map((p) => (
                <th key={p} className="px-3 py-2.5 text-right font-mono font-medium text-muted-foreground">{p}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.rows.map((r) => (
              <tr key={r.key} className="border-b border-[hsl(var(--glass-border))]/50 hover:bg-[hsl(var(--primary)/0.03)]">
                <td className={cn("sticky left-0 bg-[hsl(var(--background))] px-3 py-2", BOLD_ROWS.has(r.key) ? "font-semibold" : "text-muted-foreground")}>{r.label}</td>
                {r.values.map((v, i) => (
                  <td key={i} className={cn("px-3 py-2 text-right font-mono tabular-nums", BOLD_ROWS.has(r.key) && "font-semibold", v != null && v < 0 && "text-down")}>
                    {money(v, ccy)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Financials ─────────────────────────────────────────────────────────

export function FinancialsTab({ sym }: { sym: string }) {
  const [view, setView] = useState<"income" | "balance" | "cashflow">("income");
  const [period, setPeriod] = useState<"annual" | "quarterly">("annual");
  return (
    <DeepGate sym={sym} title="Financials" subtitle="Yahoo Finance income, balance sheet and cash flow">
      {(d) => {
        const table = d.statements[view][period];
        return (
          <GlassSection
            title="Financial statements"
            subtitle={`${ccySym(d.currency)} · Yahoo Finance · ${period === "annual" ? "annual" : "quarterly"}`}
            dataSource="yahoo"
            right={
              <div className="flex flex-wrap items-center gap-2">
                <Seg value={view} onChange={(v) => setView(v as typeof view)} options={[["income", "Income"], ["balance", "Balance"], ["cashflow", "Cash flow"]]} />
                <Seg value={period} onChange={(v) => setPeriod(v as typeof period)} options={[["annual", "Annual"], ["quarterly", "Quarterly"]]} />
              </div>
            }
          >
            <StatementView table={table} ccy={d.currency} />
            <NoteList notes={d.notes} />
          </GlassSection>
        );
      }}
    </DeepGate>
  );
}

function Seg({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: Array<[string, string]> }) {
  return (
    <div className="glass-inset inline-flex gap-0.5 p-1">
      {options.map(([id, label]) => (
        <button
          key={id}
          type="button"
          onClick={() => onChange(id)}
          className={cn(
            "h-6 rounded-md px-2 text-[11px] font-medium transition-all duration-200",
            value === id ? "bg-primary text-primary-foreground shadow-[0_2px_12px_hsl(var(--primary)/0.35)]" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

// ── Estimates ──────────────────────────────────────────────────────────

export function EstimatesTab({ sym }: { sym: string }) {
  return (
    <DeepGate sym={sym} title="Estimates" subtitle="Yahoo Finance analyst estimates">
      {(d) => (
        <div className="space-y-4">
          <EstimateTable title="Revenue estimates" rows={d.estimates.revenue} ccy={d.currency} kind="money" />
          <EstimateTable title="EPS estimates" rows={d.estimates.earnings} ccy={d.currency} kind="price" />
          <GlassSection title="Long-term growth" subtitle="Consensus 5-year estimate" dataSource="yahoo">
            <p className="font-mono text-2xl font-semibold tabular-nums">{d.estimates.ltGrowth != null ? pct(d.estimates.ltGrowth) : "—"}</p>
            <NoteList notes={d.notes} />
          </GlassSection>
        </div>
      )}
    </DeepGate>
  );
}

function EstimateTable({ title, rows, ccy, kind }: { title: string; rows: EstimateRow[]; ccy: string; kind: "money" | "price" }) {
  const fmt = (v: number | null) => (kind === "money" ? money(v, ccy) : price(v, ccy));
  return (
    <GlassSection title={title} subtitle="avg / low / high · analyst count · year-on-year growth" dataSource="yahoo">
      {rows.length ? (
        <div className="glass-inset overflow-hidden rounded-xl">
          <div className="overflow-x-auto scrollbar-thin">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-[hsl(var(--glass-border))] bg-[hsl(var(--foreground)/0.02)] text-muted-foreground">
                  {["Period", "Avg", "Low", "High", "Analysts", "Y/Y"].map((h, i) => (
                    <th key={h} className={cn("px-3 py-2.5 font-medium", i === 0 ? "text-left" : "text-right")}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.period} className="border-b border-[hsl(var(--glass-border))]/50">
                    <td className="px-3 py-2 font-semibold">{r.period}</td>
                    <td className="px-3 py-2 text-right font-mono font-semibold tabular-nums">{fmt(r.avg)}</td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums text-muted-foreground">{fmt(r.low)}</td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums text-muted-foreground">{fmt(r.high)}</td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums text-muted-foreground">{r.numAnalysts ?? "—"}</td>
                    <td className={cn("px-3 py-2 text-right font-mono tabular-nums", r.growth == null ? "" : r.growth >= 0 ? "text-up" : "text-down")}>{pct(r.growth)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <EmptyDataState reason="empty" message="No analyst estimates published." hint="No sell-side coverage on the free feed for this security." badgeLabel="yahoo" />
      )}
    </GlassSection>
  );
}

// ── Research (analyst consensus) ─────────────────────────────────────────

const REC_LABEL: Record<string, string> = { strong_buy: "Strong Buy", buy: "Buy", hold: "Hold", underperform: "Underperform", sell: "Sell" };

export function ResearchTab({ sym }: { sym: string }) {
  return (
    <DeepGate sym={sym} title="Research" subtitle="Yahoo Finance analyst consensus and rating changes">
      {(d) => {
        const r = d.research;
        const upside = r.targetMean != null && r.currentPrice != null && r.currentPrice > 0 ? (r.targetMean - r.currentPrice) / r.currentPrice : null;
        const t = r.trend;
        const total = t ? t.strongBuy + t.buy + t.hold + t.sell + t.strongSell : 0;
        const bars: Array<[string, number, string]> = t
          ? [["Strong Buy", t.strongBuy, "bg-up"], ["Buy", t.buy, "bg-up/60"], ["Hold", t.hold, "bg-muted-foreground/40"], ["Sell", t.sell, "bg-down/60"], ["Strong Sell", t.strongSell, "bg-down"]]
          : [];
        return (
          <div className="space-y-4">
            <GlassSection title="Analyst consensus" subtitle="Yahoo Finance" dataSource="yahoo">
              <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-[hsl(var(--glass-border))] sm:grid-cols-4">
                <Stat k="Consensus" v={r.recommendationKey ? (REC_LABEL[r.recommendationKey] ?? r.recommendationKey) : "—"} tone={r.recommendationKey === "strong_buy" || r.recommendationKey === "buy" ? "up" : r.recommendationKey === "sell" ? "down" : "none"} />
                <Stat k="Analysts" v={r.numAnalysts != null ? String(r.numAnalysts) : "—"} />
                <Stat k="Mean target" v={price(r.targetMean, d.currency)} />
                <Stat k="Implied upside" v={upside != null ? pct(upside) : "—"} tone={upside == null ? "none" : upside >= 0 ? "up" : "down"} />
                <Stat k="Low target" v={price(r.targetLow, d.currency)} />
                <Stat k="High target" v={price(r.targetHigh, d.currency)} />
                <Stat k="Current" v={price(r.currentPrice, d.currency)} />
                <Stat k="Rating (1-5)" v={r.recommendationMean != null ? r.recommendationMean.toFixed(2) : "—"} />
              </div>
              {t && total > 0 ? (
                <div className="mt-4 space-y-1.5">
                  {bars.map(([label, n, color]) => (
                    <div key={label} className="flex items-center gap-2">
                      <span className="w-24 text-[11px] text-muted-foreground">{label}</span>
                      <div className="h-3 flex-1 overflow-hidden rounded bg-[hsl(var(--foreground)/0.05)]">
                        <div className={cn("h-full rounded", color)} style={{ width: `${(n / total) * 100}%` }} />
                      </div>
                      <span className="w-7 text-right font-mono text-[11px] tabular-nums">{n}</span>
                    </div>
                  ))}
                </div>
              ) : null}
              <NoteList notes={d.notes} />
            </GlassSection>

            <GlassSection title="Recent rating changes" subtitle="Sell-side upgrades and downgrades" dataSource="yahoo">
              {r.actions.length ? (
                <div className="glass-inset overflow-hidden rounded-xl">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-[hsl(var(--glass-border))] bg-[hsl(var(--foreground)/0.02)] text-muted-foreground">
                        {["Date", "Firm", "Action", "Rating"].map((h, i) => (
                          <th key={h} className={cn("px-3 py-2.5 font-medium", i === 0 || i === 1 ? "text-left" : "text-left")}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {r.actions.map((a, i) => (
                        <tr key={i} className="border-b border-[hsl(var(--glass-border))]/50">
                          <td className="px-3 py-2 font-mono text-muted-foreground">{fmtDate(a.date)}</td>
                          <td className="px-3 py-2 font-medium">{a.firm ?? "—"}</td>
                          <td className="px-3 py-2 capitalize text-muted-foreground">{a.action ?? "—"}</td>
                          <td className="px-3 py-2">{a.fromGrade && a.fromGrade !== a.toGrade ? `${a.fromGrade} → ${a.toGrade}` : (a.toGrade ?? "—")}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <EmptyDataState reason="empty" message="No recent rating changes." hint="No up/downgrade history on the free feed." badgeLabel="yahoo" />
              )}
            </GlassSection>
          </div>
        );
      }}
    </DeepGate>
  );
}

function Stat({ k, v, tone = "none" }: { k: string; v: string; tone?: "up" | "down" | "none" }) {
  return (
    <div className="flex flex-col gap-0.5 bg-[hsl(var(--foreground)/0.015)] px-3 py-2.5">
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{k}</span>
      <span className={cn("font-mono text-sm font-semibold tabular-nums", tone === "up" && "text-up", tone === "down" && "text-down")}>{v}</span>
    </div>
  );
}

// ── Ownership (insiders + institutions) ──────────────────────────────────

export function OwnershipTab({ sym }: { sym: string }) {
  return (
    <DeepGate sym={sym} title="Ownership" subtitle="Yahoo Finance institutional and insider holdings">
      {(d) => {
        const o = d.ownership;
        return (
          <div className="space-y-4">
            <GlassSection title="Ownership breakdown" subtitle="Yahoo Finance" dataSource="yahoo">
              <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-[hsl(var(--glass-border))] sm:grid-cols-4">
                <Stat k="Institutions" v={pct(o.institutionPct)} />
                <Stat k="Insiders" v={pct(o.insiderPct)} />
                <Stat k="Inst. float" v={pct(o.floatPct)} />
                <Stat k="# institutions" v={o.institutionsCount != null ? intFmt(o.institutionsCount) : "—"} />
              </div>
            </GlassSection>

            <GlassSection title="Top institutional holders" subtitle="Largest reported positions" dataSource="yahoo">
              {o.topInstitutions.length ? (
                <div className="glass-inset overflow-hidden rounded-xl">
                  <div className="overflow-x-auto scrollbar-thin">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b border-[hsl(var(--glass-border))] bg-[hsl(var(--foreground)/0.02)] text-muted-foreground">
                          {["Institution", "% held", "Shares", "Value", "As of"].map((h, i) => (
                            <th key={h} className={cn("px-3 py-2.5 font-medium", i === 0 ? "text-left" : "text-right")}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {o.topInstitutions.map((it, i) => (
                          <tr key={i} className="border-b border-[hsl(var(--glass-border))]/50">
                            <td className="px-3 py-2 font-medium">{it.name}</td>
                            <td className="px-3 py-2 text-right font-mono tabular-nums">{pct(it.pct)}</td>
                            <td className="px-3 py-2 text-right font-mono tabular-nums text-muted-foreground">{intFmt(it.shares)}</td>
                            <td className="px-3 py-2 text-right font-mono tabular-nums">{money(it.value, d.currency)}</td>
                            <td className="px-3 py-2 text-right font-mono tabular-nums text-muted-foreground">{fmtDate(it.date)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ) : (
                <EmptyDataState reason="empty" message="No institutional holders reported." hint="Yahoo did not return institutional ownership for this symbol." badgeLabel="yahoo" />
              )}
            </GlassSection>

            <GlassSection title="Recent insider transactions" subtitle="Reported insider buys and sells" dataSource="yahoo">
              {o.insiderTx.length ? (
                <div className="glass-inset overflow-hidden rounded-xl">
                  <div className="overflow-x-auto scrollbar-thin">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b border-[hsl(var(--glass-border))] bg-[hsl(var(--foreground)/0.02)] text-muted-foreground">
                          {["Insider", "Relation", "Transaction", "Shares", "Value", "Date"].map((h, i) => (
                            <th key={h} className={cn("px-3 py-2.5 font-medium", i <= 2 ? "text-left" : "text-right")}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {o.insiderTx.map((t, i) => (
                          <tr key={i} className="border-b border-[hsl(var(--glass-border))]/50">
                            <td className="px-3 py-2 font-medium">{t.name}</td>
                            <td className="px-3 py-2 text-muted-foreground">{t.relation ?? "—"}</td>
                            <td className="px-3 py-2 text-muted-foreground">{t.text ?? "—"}</td>
                            <td className="px-3 py-2 text-right font-mono tabular-nums text-muted-foreground">{intFmt(t.shares)}</td>
                            <td className="px-3 py-2 text-right font-mono tabular-nums">{money(t.value, d.currency)}</td>
                            <td className="px-3 py-2 text-right font-mono tabular-nums text-muted-foreground">{fmtDate(t.date)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ) : (
                <EmptyDataState reason="empty" message="No recent insider transactions." hint="Yahoo did not return insider activity for this symbol." badgeLabel="yahoo" />
              )}
            </GlassSection>
          </div>
        );
      }}
    </DeepGate>
  );
}

// ── Dividends ──────────────────────────────────────────────────────────

export function DividendsTab({ sym }: { sym: string }) {
  return (
    <DeepGate sym={sym} title="Dividends" subtitle="Yahoo Finance dividend profile">
      {(d) => {
        const dv = d.dividends;
        const none = dv.yield == null && dv.rate == null;
        return (
          <GlassSection title="Dividend profile" subtitle="Yahoo Finance" dataSource="yahoo">
            {none ? (
              <EmptyDataState reason="empty" message={`${sym} does not currently pay a dividend.`} hint="No dividend rate or yield reported." badgeLabel="yahoo" />
            ) : (
              <>
                <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-[hsl(var(--glass-border))] sm:grid-cols-3">
                  <Stat k="Annual rate (DPS)" v={price(dv.rate, d.currency)} />
                  <Stat k="Yield" v={pct(dv.yield)} />
                  <Stat k="Payout ratio" v={pct(dv.payout)} />
                  <Stat k="Ex-dividend date" v={fmtDate(dv.exDate)} />
                  <Stat k="5-yr avg yield" v={dv.fiveYrAvgYield != null ? `${dv.fiveYrAvgYield.toFixed(2)}%` : "—"} />
                </div>
                <p className="mt-3 text-[10.5px] text-muted-foreground/80">
                  Per-payment dividend history and growth rates require a longer-history vendor feed.
                </p>
              </>
            )}
          </GlassSection>
        );
      }}
    </DeepGate>
  );
}

// ── Financial Modeling (client-side DCF / DDM sandbox) ───────────────────

export function ModelingTab({ sym }: { sym: string }) {
  const q = useDeep(sym);
  const last = q.data?.research.currentPrice ?? null;
  // Cash-flow base = consensus current-year EPS (per share), so the model yields a
  // per-share fair value comparable to the live price. Falls back to the nearest
  // available EPS estimate; null when the security has no earnings coverage.
  const baseEps =
    q.data?.estimates.earnings.find((e) => e.period === "Current Year")?.avg ??
    q.data?.estimates.earnings[0]?.avg ??
    null;
  const [growth, setGrowth] = useState(8);
  const [discount, setDiscount] = useState(12);
  const [exitMult, setExitMult] = useState(18);
  const [horizon, setHorizon] = useState(5);

  const model = useMemo(() => {
    if (baseEps == null) return { fairValue: null as number | null, reason: "No earnings estimate available to model this security." };
    const g = growth / 100, r = discount / 100;
    if (r <= g) return { fairValue: null as number | null, reason: "Discount rate must exceed the growth rate." };
    let pv = 0;
    for (let i = 1; i <= horizon; i++) pv += (baseEps * Math.pow(1 + g, i)) / Math.pow(1 + r, i);
    const terminal = (exitMult * baseEps * Math.pow(1 + g, horizon + 1)) / Math.pow(1 + r, horizon);
    return { fairValue: pv + terminal, reason: undefined as string | undefined };
  }, [baseEps, growth, discount, exitMult, horizon]);

  const ccy = q.data?.currency ?? "USD";
  const upside = model?.fairValue != null && last != null && last > 0 ? (model.fairValue - last) / last : null;

  return (
    <GlassSection title="Valuation model" subtitle="Indicative two-stage model on the consensus earnings estimate. Not a recommendation." dataSource="code-gap">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="grid grid-cols-2 gap-3">
          <NumInput label="Growth rate (%)" value={growth} step={0.5} onChange={setGrowth} icon={<TrendingUp className="h-3.5 w-3.5" />} />
          <NumInput label="Discount rate (%)" value={discount} step={0.5} onChange={setDiscount} icon={<Scale className="h-3.5 w-3.5" />} />
          <NumInput label="Exit multiple (x)" value={exitMult} step={0.5} onChange={setExitMult} icon={<Scale className="h-3.5 w-3.5" />} />
          <NumInput label="Horizon (years)" value={horizon} step={1} onChange={(n) => setHorizon(Math.max(1, Math.min(15, n)))} icon={<CalendarDays className="h-3.5 w-3.5" />} />
        </div>
        <div className="glass-inset flex flex-col justify-center gap-2 rounded-xl px-4 py-3">
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Indicative fair value</span>
          <span className="font-mono text-3xl font-semibold tabular-nums">{model?.fairValue != null ? price(model.fairValue, ccy) : "—"}</span>
          {model?.reason ? <span className="font-mono text-[11px] text-warning">{model.reason}</span> : null}
          <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
            <span className="text-muted-foreground">Current {price(last, ccy)}</span>
            <span className="text-muted-foreground">Base EPS {price(baseEps, ccy)}</span>
            {upside != null ? (
              <span className={cn("inline-flex items-center gap-1 font-semibold", upside >= 0 ? "text-up" : "text-down")}>
                {upside >= 0 ? <TrendingUp className="h-3.5 w-3.5" /> : <TrendingDown className="h-3.5 w-3.5" />}
                {pct(upside)} vs fair value
              </span>
            ) : null}
          </div>
        </div>
      </div>
      <p className="mt-3 text-[10.5px] leading-snug text-muted-foreground/80">
        Two-stage model: present value of the consensus forward EPS grown over the horizon, plus an exit-multiple terminal value. Desk assumptions only, indicative, not investment advice.
      </p>
    </GlassSection>
  );
}

function NumInput({ label, value, step, onChange, icon }: { label: string; value: number; step: number; onChange: (n: number) => void; icon: React.ReactNode }) {
  return (
    <label className="glass-inset flex items-center gap-2 rounded-xl px-3 py-2">
      <span className="text-muted-foreground">{icon}</span>
      <span className="flex-1 text-[11.5px] text-muted-foreground">{label}</span>
      <input
        type="number"
        value={value}
        step={step}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-16 bg-transparent text-right font-mono text-xs font-semibold tabular-nums outline-none"
      />
    </label>
  );
}
