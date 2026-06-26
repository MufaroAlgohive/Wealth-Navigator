"use client";

/**
 * Analysis sub-tabs — fiscal.ai-style sections, richer, all real Yahoo data or
 * honest "—". Financials, Estimates, Research (analyst consensus), Ownership
 * (insiders + institutions), Dividends, and a client-side valuation model.
 * Every tab shares ONE /deep query (react-query dedupes), so switching tabs
 * never refetches.
 */

import { useQuery } from "@tanstack/react-query";
import { CalendarDays, ExternalLink, Globe, Scale, TrendingDown, TrendingUp } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { EmptyDataState } from "@/components/oems/primitives/empty-data-state";
import { GlassSection } from "@/components/oems/primitives/glass";
import { PanelSkeleton } from "@/components/oems/primitives/panel-skeleton";
import { Pill } from "@/components/oems/primitives/pill";
import type { CompanyAnalysis, CompanyDeep, EstimateRow, StatementTable as TStmt } from "@/lib/company-analysis/yahoo";
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

const BOLD_ROWS = new Set([
  // timeseries keys (current)
  "TotalRevenue", "GrossProfit", "OperatingIncome", "NetIncome", "TotalAssets", "StockholdersEquity", "OperatingCashFlow", "FreeCashFlow", "TotalLiabilitiesNetMinorityInterest",
  // legacy quoteSummary keys (fallback)
  "totalRevenue", "grossProfit", "operatingIncome", "netIncome", "totalAssets", "totalStockholderEquity", "totalCashFromOperatingActivities", "freeCashFlow",
]);

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

            {o.insiders.length ? (
              <GlassSection title="Insider roster" subtitle="Officers and directors, reported holdings" dataSource="yahoo">
                <div className="glass-inset overflow-hidden rounded-xl">
                  <div className="overflow-x-auto scrollbar-thin">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b border-[hsl(var(--glass-border))] bg-[hsl(var(--foreground)/0.02)] text-muted-foreground">
                          {["Insider", "Title", "Shares held", "Market value", "% owned"].map((h, i) => (
                            <th key={h} className={cn("px-3 py-2.5 font-medium", i <= 1 ? "text-left" : "text-right")}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {o.insiders.map((it, i) => {
                          const val = it.shares != null && d.research.currentPrice != null ? it.shares * d.research.currentPrice : null;
                          const owned = it.shares != null && o.sharesOutstanding != null && o.sharesOutstanding > 0 ? it.shares / o.sharesOutstanding : null;
                          return (
                            <tr key={i} className="border-b border-[hsl(var(--glass-border))]/50">
                              <td className="px-3 py-2 font-medium">{it.name}</td>
                              <td className="px-3 py-2 text-muted-foreground">{it.title ?? "—"}</td>
                              <td className="px-3 py-2 text-right font-mono tabular-nums">{intFmt(it.shares)}</td>
                              <td className="px-3 py-2 text-right font-mono tabular-nums">{money(val, d.currency)}</td>
                              <td className="px-3 py-2 text-right font-mono tabular-nums text-muted-foreground">{owned != null ? `${(owned * 100).toFixed(4)}%` : "—"}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              </GlassSection>
            ) : null}

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

interface DivPayment { date: string; amount: number; changePct: number | null }

export function DividendsTab({ sym }: { sym: string }) {
  const dq = useDeep(sym);
  const hq = useQuery<{ ok: boolean; currency: string; payments: DivPayment[]; error?: string }>({
    queryKey: ["company-dividends", sym],
    queryFn: async () => {
      const r = await fetch(`/api/company-analysis/${encodeURIComponent(sym)}/dividends`, { cache: "no-store" });
      if (!r.ok) throw new Error(`dividends ${r.status}`);
      return r.json();
    },
    ...queryOpts("reference"),
    enabled: Boolean(sym),
    staleTime: 30 * 60_000,
  });

  if (dq.isLoading) return <PanelSkeleton rows={5} height="h-[320px]" />;
  const d = dq.data;
  const dv = d?.dividends;
  const ccy = d?.currency ?? "USD";
  const none = !dv || (dv.yield == null && dv.rate == null);
  const payments = hq.data?.payments ?? [];

  return (
    <div className="space-y-4">
      <GlassSection title="Dividend profile" subtitle="Yahoo Finance" dataSource="yahoo">
        {none ? (
          <EmptyDataState reason="empty" message={`${sym} does not currently pay a dividend.`} hint="No dividend rate or yield reported." badgeLabel="yahoo" />
        ) : (
          <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-[hsl(var(--glass-border))] sm:grid-cols-3">
            <Stat k="Annual rate (DPS)" v={price(dv!.rate, ccy)} />
            <Stat k="Yield" v={pct(dv!.yield)} />
            <Stat k="Payout ratio" v={pct(dv!.payout)} />
            <Stat k="Ex-dividend date" v={fmtDate(dv!.exDate)} />
            <Stat k="5-yr avg yield" v={dv!.fiveYrAvgYield != null ? `${dv!.fiveYrAvgYield.toFixed(2)}%` : "—"} />
          </div>
        )}
      </GlassSection>

      <GlassSection title="Dividend history" subtitle="Per-payment record" dataSource="yahoo">
        {hq.isLoading ? (
          <PanelSkeleton rows={4} />
        ) : !payments.length ? (
          <EmptyDataState reason="empty" message="No dividend payment history." hint={hq.data?.error ?? "No dividend events returned for this security."} badgeLabel="yahoo" />
        ) : (
          <div className="glass-inset overflow-hidden rounded-xl">
            <div className="max-h-[420px] overflow-y-auto scrollbar-thin">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-[hsl(var(--background))]">
                  <tr className="border-b border-[hsl(var(--glass-border))] bg-[hsl(var(--foreground)/0.02)] text-muted-foreground">
                    <th className="px-3 py-2.5 text-left font-medium">Pay date</th>
                    <th className="px-3 py-2.5 text-right font-medium">Amount</th>
                    <th className="px-3 py-2.5 text-right font-medium">Change</th>
                  </tr>
                </thead>
                <tbody>
                  {payments.map((p, i) => (
                    <tr key={i} className="border-b border-[hsl(var(--glass-border))]/50">
                      <td className="px-3 py-2 font-mono text-muted-foreground">{fmtDate(p.date)}</td>
                      <td className="px-3 py-2 text-right font-mono font-semibold tabular-nums">{price(p.amount, hq.data?.currency ?? ccy)}</td>
                      <td className={cn("px-3 py-2 text-right font-mono tabular-nums", p.changePct == null ? "text-muted-foreground" : p.changePct > 0 ? "text-up" : p.changePct < 0 ? "text-down" : "text-muted-foreground")}>
                        {p.changePct == null ? "—" : `${p.changePct > 0 ? "+" : ""}${p.changePct.toFixed(1)}%`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </GlassSection>
    </div>
  );
}

// ── Financial Modeling (client-side DCF / DDM sandbox) ───────────────────

export function ModelingTab({ sym }: { sym: string }) {
  const dq = useDeep(sym);
  const aq = useAnalysis(sym);
  const d = dq.data;
  const ccy = d?.currency ?? "USD";

  const rowVal = (t: TStmt | undefined, key: string): number | null => t?.rows.find((r) => r.key === key)?.values?.[0] ?? null;
  const inc = d?.statements.income.annual;
  const bal = d?.statements.balance.annual;
  const cf = d?.statements.cashflow.annual;

  const rev0 = rowVal(inc, "TotalRevenue");
  const ebit0 = rowVal(inc, "OperatingIncome");
  const ebitda0 = rowVal(inc, "EBITDA");
  const pretax0 = rowVal(inc, "PretaxIncome");
  const taxProv0 = rowVal(inc, "TaxProvision");
  const capex0 = rowVal(cf, "CapitalExpenditure");
  const cash0 = rowVal(bal, "CashAndCashEquivalents");
  const ltDebt0 = rowVal(bal, "LongTermDebt");
  const shares = d?.ownership.sharesOutstanding ?? null;
  const currentPrice = d?.research.currentPrice ?? null;
  const marketCap = aq.data?.groups?.Profile?.["Market Cap"]?.value ?? null;
  const netDebt = aq.data?.groups?.["Financial Health"]?.["Net Debt"]?.value ?? null;

  const taxRate = pretax0 != null && pretax0 > 0 && taxProv0 != null ? Math.min(Math.max(taxProv0 / pretax0, 0), 0.5) : 0.2;
  const ebitMargin = rev0 != null && rev0 > 0 && ebit0 != null ? ebit0 / rev0 : null;
  const daRate = rev0 != null && rev0 > 0 && ebitda0 != null && ebit0 != null ? (ebitda0 - ebit0) / rev0 : 0.05;
  const capexRate = rev0 != null && rev0 > 0 && capex0 != null ? capex0 / rev0 : -0.05;

  const estRev = d?.estimates.revenue ?? [];
  const cyRev = estRev.find((e) => e.period === "Current Year")?.avg ?? null;
  const nyRev = estRev.find((e) => e.period === "Next Year")?.avg ?? null;
  const defGrowth = cyRev != null && nyRev != null && cyRev > 0 ? Math.round(((nyRev - cyRev) / cyRev) * 1000) / 10 : 10;

  const [growth, setGrowth] = useState(defGrowth);
  const [years, setYears] = useState(5);
  const [riskFree, setRiskFree] = useState(4.3);
  const [mrp, setMrp] = useState(5);
  const [beta, setBeta] = useState(1.1);
  const [costOfDebt, setCostOfDebt] = useState(4);
  const [exitMult, setExitMult] = useState(20);

  const model = useMemo(() => {
    if (rev0 == null || ebitMargin == null || shares == null || shares <= 0) return null;
    const g = growth / 100;
    const costOfEquity = (riskFree + beta * mrp) / 100;
    const afterTaxKd = (costOfDebt / 100) * (1 - taxRate);
    const debt = ltDebt0 != null ? ltDebt0 : netDebt != null && cash0 != null ? netDebt + cash0 : 0;
    const equity = marketCap ?? (currentPrice != null ? currentPrice * shares : 0);
    const totalCap = equity + debt;
    const wD = totalCap > 0 ? debt / totalCap : 0;
    const wE = 1 - wD;
    const wacc = wE * costOfEquity + wD * afterTaxKd;
    if (!(wacc > 0)) return null;
    const rows: Array<{ year: number; rev: number; ebit: number; nopat: number; da: number; capex: number; ufcf: number; pv: number }> = [];
    let sumPV = 0;
    for (let i = 1; i <= years; i++) {
      const rev = rev0 * Math.pow(1 + g, i);
      const ebit = rev * ebitMargin;
      const nopat = ebit * (1 - taxRate);
      const da = rev * daRate;
      const capex = rev * capexRate;
      const ufcf = nopat + da + capex;
      const pv = ufcf / Math.pow(1 + wacc, i);
      sumPV += pv;
      rows.push({ year: i, rev, ebit, nopat, da, capex, ufcf, pv });
    }
    const termUfcf = rows[rows.length - 1]?.ufcf ?? 0;
    const pvTV = (exitMult * termUfcf) / Math.pow(1 + wacc, years);
    const ev = sumPV + pvTV;
    const nd = netDebt ?? debt - (cash0 ?? 0);
    const equityValue = ev - nd;
    const implied = equityValue / shares;
    const upside = currentPrice != null && currentPrice > 0 ? implied / currentPrice - 1 : null;
    return { rows, wacc, costOfEquity, afterTaxKd, wD, wE, sumPV, pvTV, ev, equityValue, implied, upside };
  }, [rev0, ebitMargin, daRate, capexRate, taxRate, shares, currentPrice, marketCap, netDebt, ltDebt0, cash0, growth, years, riskFree, mrp, beta, costOfDebt, exitMult]);

  if (dq.isLoading) return <PanelSkeleton rows={8} height="h-[420px]" />;
  if (!d || !d.ok || rev0 == null || ebitMargin == null) {
    return (
      <GlassSection title="Valuation model (DCF)" subtitle="Discounted cash flow" dataSource="code-gap">
        <EmptyDataState reason="empty" message={`Not enough statement data to model ${sym}.`} hint="A DCF needs revenue, operating income and cash-flow history, which the free feed did not return for this security." badgeLabel="yahoo" />
      </GlassSection>
    );
  }

  const BUILD: Array<[string, "rev" | "ebit" | "nopat" | "da" | "capex" | "ufcf" | "pv"]> = [
    ["Revenue", "rev"], ["EBIT", "ebit"], ["NOPAT", "nopat"], ["D&A", "da"], ["Capex", "capex"], ["Unlevered FCF", "ufcf"], ["PV of UFCF", "pv"],
  ];

  return (
    <GlassSection title="Valuation model (DCF)" subtitle="Unlevered FCF built from the reported statements. Indicative, not a recommendation." dataSource="code-gap">
      <div className="mb-4 grid grid-cols-2 gap-2.5 sm:grid-cols-4 lg:grid-cols-7">
        <NumInput label="Rev growth %" value={growth} step={0.5} onChange={setGrowth} icon={<TrendingUp className="h-3.5 w-3.5" />} />
        <NumInput label="Years" value={years} step={1} onChange={(n) => setYears(Math.max(3, Math.min(10, n)))} icon={<CalendarDays className="h-3.5 w-3.5" />} />
        <NumInput label="Risk-free %" value={riskFree} step={0.1} onChange={setRiskFree} icon={<Scale className="h-3.5 w-3.5" />} />
        <NumInput label="Mkt prem %" value={mrp} step={0.25} onChange={setMrp} icon={<Scale className="h-3.5 w-3.5" />} />
        <NumInput label="Beta" value={beta} step={0.05} onChange={setBeta} icon={<Scale className="h-3.5 w-3.5" />} />
        <NumInput label="Cost of debt %" value={costOfDebt} step={0.25} onChange={setCostOfDebt} icon={<Scale className="h-3.5 w-3.5" />} />
        <NumInput label="Exit x UFCF" value={exitMult} step={1} onChange={setExitMult} icon={<Scale className="h-3.5 w-3.5" />} />
      </div>

      {model ? (
        <>
          <div className="glass-inset overflow-hidden rounded-xl">
            <div className="overflow-x-auto scrollbar-thin">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-[hsl(var(--glass-border))] bg-[hsl(var(--foreground)/0.02)] text-muted-foreground">
                    <th className="px-3 py-2 text-left font-medium">Build-up ({ccySym(ccy)})</th>
                    {model.rows.map((r) => (
                      <th key={r.year} className="px-3 py-2 text-right font-mono font-medium">Y{r.year}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {BUILD.map(([label, key]) => {
                    const strong = label === "Unlevered FCF" || label === "PV of UFCF";
                    return (
                      <tr key={label} className="border-b border-[hsl(var(--glass-border))]/50">
                        <td className={cn("px-3 py-1.5", strong ? "font-semibold" : "text-muted-foreground")}>{label}</td>
                        {model.rows.map((r) => (
                          <td key={r.year} className={cn("px-3 py-1.5 text-right font-mono tabular-nums", key === "capex" && "text-down", strong && "font-semibold")}>
                            {money(r[key], ccy)}
                          </td>
                        ))}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
            <div>
              <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Discount rate (WACC)</div>
              <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-[hsl(var(--glass-border))]">
                <Stat k="Cost of equity" v={pct(model.costOfEquity)} />
                <Stat k="After-tax cost of debt" v={pct(model.afterTaxKd)} />
                <Stat k="Equity / debt weight" v={`${(model.wE * 100).toFixed(0)}% / ${(model.wD * 100).toFixed(0)}%`} />
                <Stat k="WACC" v={pct(model.wacc)} tone="up" />
              </div>
            </div>
            <div>
              <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Valuation</div>
              <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-[hsl(var(--glass-border))]">
                <Stat k="PV of UFCF" v={money(model.sumPV, ccy)} />
                <Stat k="PV of terminal" v={money(model.pvTV, ccy)} />
                <Stat k="Enterprise value" v={money(model.ev, ccy)} />
                <Stat k="Equity value" v={money(model.equityValue, ccy)} />
                <Stat k="Implied share price" v={price(model.implied, ccy)} tone="up" />
                <Stat k="Upside vs current" v={model.upside != null ? pct(model.upside) : "—"} tone={model.upside == null ? "none" : model.upside >= 0 ? "up" : "down"} />
              </div>
            </div>
          </div>
          <p className="mt-3 text-[10.5px] leading-snug text-muted-foreground/80">
            Unlevered FCF = NOPAT + D&A + capex, projected at the revenue growth above with margins held at the latest reported year, discounted at WACC; terminal value = exit multiple times terminal-year UFCF. Editable desk assumptions, indicative, not investment advice.
          </p>
        </>
      ) : (
        <EmptyDataState reason="empty" message="Model inputs incomplete." hint="Adjust the assumptions; some base figures were unavailable." badgeLabel="yahoo" />
      )}
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

// ── shared overview query (deduped with the page + Company statistics) ────

function useAnalysis(sym: string) {
  return useQuery<CompanyAnalysis>({
    queryKey: ["company-analysis", sym],
    queryFn: async () => {
      const r = await fetch(`/api/company-analysis/${encodeURIComponent(sym)}`, { cache: "no-store" });
      if (!r.ok) throw new Error(`analysis ${r.status}`);
      return r.json();
    },
    ...queryOpts("reference"),
    enabled: Boolean(sym),
    staleTime: 5 * 60_000,
  });
}

const STAT_GRID = "grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-[hsl(var(--glass-border))] sm:grid-cols-3";

// ── News ───────────────────────────────────────────────────────────────

interface NewsItem { title: string; url: string; publisher: string | null; publishedAt: string | null }

export function NewsTab({ sym }: { sym: string }) {
  const a = useAnalysis(sym);
  const name = a.data?.overview.name ?? sym;
  const q = useQuery<{ ok: boolean; items: NewsItem[]; error?: string }>({
    queryKey: ["company-news", sym, name],
    queryFn: async () => {
      const r = await fetch(`/api/company-analysis/${encodeURIComponent(sym)}/news?q=${encodeURIComponent(name)}`, { cache: "no-store" });
      if (!r.ok) throw new Error(`news ${r.status}`);
      return r.json();
    },
    ...queryOpts("reference"),
    enabled: Boolean(sym),
    staleTime: 5 * 60_000,
  });
  const items = q.data?.items ?? [];
  return (
    <GlassSection title="News" subtitle="Recent company news" dataSource="external">
      {q.isLoading ? (
        <PanelSkeleton rows={5} />
      ) : !items.length ? (
        <EmptyDataState reason="empty" message={`No recent news for ${sym}.`} hint={q.data?.error ?? "No headlines from the news feed for this security."} badgeLabel="external" />
      ) : (
        <ul className="glass-inset divide-y divide-[hsl(var(--glass-border))]/50 overflow-hidden rounded-xl">
          {items.slice(0, 20).map((n, i) => (
            <li key={i} className="px-4 py-3 transition-colors hover:bg-[hsl(var(--primary)/0.04)]">
              <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                <span className="font-mono">{n.publisher ?? "News"}</span>
                {n.publishedAt ? <span>· {fmtDate(n.publishedAt)}</span> : null}
              </div>
              {n.url ? (
                <a href={n.url} target="_blank" rel="noopener noreferrer" className="mt-0.5 block text-sm font-medium hover:text-primary hover:underline">
                  {n.title} <ExternalLink className="inline h-3 w-3 align-baseline" />
                </a>
              ) : (
                <p className="mt-0.5 text-sm font-medium">{n.title}</p>
              )}
            </li>
          ))}
        </ul>
      )}
    </GlassSection>
  );
}

// ── Filings (SEC EDGAR) ──────────────────────────────────────────────────

interface FilingRow { form: string; date: string | null; title: string; url: string | null }

export function FilingsTab({ sym }: { sym: string }) {
  const q = useQuery<{ ok: boolean; source: string; filings: FilingRow[]; note?: string; error?: string }>({
    queryKey: ["company-filings", sym],
    queryFn: async () => {
      const r = await fetch(`/api/company-analysis/${encodeURIComponent(sym)}/filings`, { cache: "no-store" });
      if (!r.ok) throw new Error(`filings ${r.status}`);
      return r.json();
    },
    ...queryOpts("reference"),
    enabled: Boolean(sym),
    staleTime: 30 * 60_000,
  });
  const [cat, setCat] = useState("All");
  const [search, setSearch] = useState("");
  const filings = q.data?.filings ?? [];
  const cats = ["All", "Annual & Quarterly", "News", "Proxy", "Ownership", "Registrations", "Other"];
  const filtered = filings.filter(
    (f) => (cat === "All" || filingCategory(f.form) === cat) && (!search || `${f.form} ${f.title}`.toLowerCase().includes(search.toLowerCase())),
  );
  return (
    <GlassSection
      title="Filings"
      subtitle="SEC EDGAR (US-listed)"
      dataSource="external"
      right={
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search filings…"
          className="glass-inset h-7 w-44 rounded-lg px-2.5 text-[11px] outline-none placeholder:text-muted-foreground/60"
        />
      }
    >
      {q.isLoading ? (
        <PanelSkeleton rows={5} />
      ) : q.data?.source === "none" || !filings.length ? (
        <EmptyDataState reason="empty" message={`No SEC filings for ${sym}.`} hint={q.data?.note ?? q.data?.error ?? "No EDGAR filings returned for this ticker."} badgeLabel="external" />
      ) : (
        <>
          <div className="mb-3 flex flex-wrap gap-1">
            {cats.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setCat(c)}
                className={cn(
                  "rounded-md border px-2 py-0.5 text-[10.5px] transition-colors",
                  cat === c ? "border-primary/40 bg-primary/10 text-primary" : "border-[hsl(var(--glass-border))] text-muted-foreground hover:text-foreground",
                )}
              >
                {c}
              </button>
            ))}
          </div>
          <div className="glass-inset overflow-hidden rounded-xl">
            <div className="max-h-[560px] overflow-y-auto scrollbar-thin">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-[hsl(var(--background))]">
                  <tr className="border-b border-[hsl(var(--glass-border))] bg-[hsl(var(--foreground)/0.02)] text-muted-foreground">
                    <th className="px-3 py-2.5 text-left font-medium">Form</th>
                    <th className="px-3 py-2.5 text-left font-medium">Date</th>
                    <th className="px-3 py-2.5 text-left font-medium">Description</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((f, i) => (
                    <tr key={i} className="border-b border-[hsl(var(--glass-border))]/50">
                      <td className="px-3 py-2"><Pill tone="info" size="xs">{f.form}</Pill></td>
                      <td className="px-3 py-2 font-mono text-muted-foreground">{fmtDate(f.date)}</td>
                      <td className="px-3 py-2">
                        {f.url ? (
                          <a href={f.url} target="_blank" rel="noopener noreferrer" className="hover:text-primary hover:underline">
                            {f.title} <ExternalLink className="inline h-3 w-3 align-baseline" />
                          </a>
                        ) : (
                          f.title
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </GlassSection>
  );
}

function filingCategory(form: string): string {
  const f = (form ?? "").toUpperCase().trim();
  if (f.startsWith("10-K") || f.startsWith("10-Q")) return "Annual & Quarterly";
  if (f.startsWith("8-K")) return "News";
  if (f.includes("14A") || f.startsWith("DEF")) return "Proxy";
  if (f === "3" || f === "4" || f === "5" || f.startsWith("SC ")) return "Ownership";
  if (f.startsWith("S-") || f.startsWith("424") || f.startsWith("F-")) return "Registrations";
  return "Other";
}

// ── Industry ───────────────────────────────────────────────────────────

function PeerRow({ sym, base, onRemove }: { sym: string; base: boolean; onRemove?: () => void }) {
  const a = useAnalysis(sym);
  const d = a.data;
  const g = d?.groups;
  const mcap = g?.Profile?.["Market Cap"]?.value ?? null;
  const gm = g?.Margins?.Gross?.value ?? null;
  const pe = g?.["Valuation (TTM)"]?.["P/E"]?.value ?? null;
  const fpe = g?.["Valuation (NTM)"]?.["P/E"]?.value ?? null;
  const ccy = d?.currency ?? "USD";
  return (
    <tr className="border-b border-[hsl(var(--glass-border))]/50">
      <td className="px-3 py-2">
        <span className="font-mono font-semibold">{d?.symbol ?? sym}</span>
        {base ? <span className="ml-1.5 rounded bg-primary/15 px-1 py-0.5 text-[8.5px] uppercase tracking-wider text-primary">this</span> : null}
      </td>
      <td className="max-w-[180px] truncate px-3 py-2 text-muted-foreground">{a.isLoading ? "…" : d?.overview.name ?? "—"}</td>
      <td className="px-3 py-2 text-right font-mono tabular-nums">{money(mcap, ccy)}</td>
      <td className="px-3 py-2 text-right font-mono tabular-nums">{gm != null ? `${(gm * 100).toFixed(1)}%` : "—"}</td>
      <td className="px-3 py-2 text-right font-mono tabular-nums">{pe != null ? `${pe.toFixed(1)}x` : "—"}</td>
      <td className="px-3 py-2 text-right font-mono tabular-nums">{fpe != null ? `${fpe.toFixed(1)}x` : "—"}</td>
      <td className="px-2 py-2 text-right">
        {onRemove ? (
          <button type="button" onClick={onRemove} className="text-muted-foreground transition-colors hover:text-down" aria-label="Remove">
            ×
          </button>
        ) : null}
      </td>
    </tr>
  );
}

export function IndustryTab({ sym }: { sym: string }) {
  const a = useAnalysis(sym);
  const o = a.data?.overview;
  const [extra, setExtra] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  useEffect(() => {
    setExtra([]);
    setDraft("");
  }, [sym]);
  const add = () => {
    const v = draft.trim().toUpperCase();
    if (v && v !== sym && !extra.includes(v)) setExtra((e) => [...e, v]);
    setDraft("");
  };
  const peers = [sym, ...extra];
  return (
    <div className="space-y-4">
      <GlassSection title="Industry" subtitle="Sector and industry classification" dataSource="yahoo">
        <div className={STAT_GRID}>
          <Stat k="Sector" v={o?.sector ?? "—"} />
          <Stat k="Industry" v={o?.industry ?? "—"} />
          <Stat k="Country" v={o?.country ?? "—"} />
        </div>
      </GlassSection>

      <GlassSection
        title="Peer comparison"
        subtitle="Add any ticker to compare key metrics"
        dataSource="yahoo"
        right={
          <form
            onSubmit={(e) => {
              e.preventDefault();
              add();
            }}
            className="flex items-center gap-1"
          >
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Add ticker (AAPL, NPN.JO)"
              className="glass-inset h-7 w-44 rounded-lg px-2.5 text-[11px] uppercase outline-none placeholder:text-muted-foreground/60"
            />
            <button type="submit" className="h-7 rounded-lg bg-primary px-2.5 text-[11px] font-medium text-primary-foreground">
              Add
            </button>
          </form>
        }
      >
        <div className="glass-inset overflow-hidden rounded-xl">
          <div className="overflow-x-auto scrollbar-thin">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-[hsl(var(--glass-border))] bg-[hsl(var(--foreground)/0.02)] text-muted-foreground">
                  <th className="px-3 py-2.5 text-left font-medium">Ticker</th>
                  <th className="px-3 py-2.5 text-left font-medium">Company</th>
                  <th className="px-3 py-2.5 text-right font-medium">Market cap</th>
                  <th className="px-3 py-2.5 text-right font-medium">Gross margin</th>
                  <th className="px-3 py-2.5 text-right font-medium">P/E</th>
                  <th className="px-3 py-2.5 text-right font-medium">Fwd P/E</th>
                  <th className="px-2 py-2.5" />
                </tr>
              </thead>
              <tbody>
                {peers.map((p, i) => (
                  <PeerRow key={p} sym={p} base={i === 0} onRemove={i === 0 ? undefined : () => setExtra((e) => e.filter((x) => x !== p))} />
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <p className="mt-2 text-[10.5px] text-muted-foreground/80">
          Each peer is pulled through the shared cache, so comparisons reuse data already loaded. An automatic
          curated peer list needs a classification vendor.
        </p>
      </GlassSection>
    </div>
  );
}

// ── Investor relations ───────────────────────────────────────────────────

export function InvestorRelationsTab({ sym }: { sym: string }) {
  const a = useAnalysis(sym);
  const o = a.data?.overview;
  return (
    <GlassSection title="Investor relations" subtitle="IR resources and upcoming events" dataSource="yahoo">
      {a.isLoading ? (
        <PanelSkeleton rows={2} />
      ) : (
        <div className="space-y-3">
          <div className={STAT_GRID}>
            <Stat k="Next earnings" v={o?.nextEarnings ? fmtDate(o.nextEarnings) : "—"} />
            <Stat k="CEO" v={o?.ceo ?? "—"} />
            <Stat k="Employees" v={o?.employees != null ? o.employees.toLocaleString("en-US") : "—"} />
          </div>
          {o?.website ? (
            <a
              href={o.website}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 rounded-lg border border-[hsl(var(--glass-border))] px-3 py-1.5 text-sm text-primary transition-colors hover:border-primary/40 hover:bg-primary/5"
            >
              <Globe className="h-3.5 w-3.5" />
              Company / IR website
              <ExternalLink className="h-3 w-3" />
            </a>
          ) : null}
          <p className="text-[10.5px] leading-snug text-muted-foreground/80">
            Earnings-call transcripts and investor presentations require an IR vendor feed (planned). The next
            earnings date and the company site are shown above.
          </p>
        </div>
      )}
    </GlassSection>
  );
}
