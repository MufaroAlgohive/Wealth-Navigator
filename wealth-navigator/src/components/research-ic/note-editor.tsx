"use client";

/**
 * Create / edit a research note via a 6-step wizard:
 *
 *   1. Identify         — ticker typeahead (searches JSE IRESS universe + Yahoo
 *                         global), pre-fills company / sector / exchange.
 *   2. Auto-fetch       — fires /api/company-analysis/[sym] + /peers and offers
 *                         a pre-fill card the analyst accepts or skips. Pulls:
 *                           - Valuation block: P/E, EV/EBITDA, ROE, Div yield,
 *                             target price
 *                           - Fundamentals table: Revenue growth (3y CAGR),
 *                             Operating margin, HEPS growth (3y CAGR), ROE,
 *                             Net Debt / EBITDA (derived), EV/Cashflow (derived)
 *                           - Peer comp: peer names + tickers
 *   3. Thesis           — bull, bear, catalysts, risks.
 *   4. Fundamentals     — the per-metric table (auto-fillable from step 2;
 *                         user can edit / add rows).
 *   5. Mgmt & Triggers  — management view + the 5 trigger fields.
 *   6. Submit           — review summary, write to /api/research/notes.
 *
 * Save contract is unchanged: POST creates, PATCH updates. Both still
 * POST /api/research/notes/[id]/transition to move draft → in_review.
 */

import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  Loader2,
  Plus,
  Save,
  Search,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import * as React from "react";

import { GlassSection } from "@/components/oems/primitives/glass";
import { cn } from "@/lib/cn";
import type {
  Esg,
  Fundamental,
  NoteThesis,
  NoteTriggers,
  NoteValuation,
  Peer,
  Rating,
  ResearchNote,
} from "./types";

const INPUT =
  "w-full rounded-md border border-[hsl(var(--glass-border))] bg-[hsl(var(--foreground)/0.03)] px-2.5 py-1.5 text-xs outline-none focus:border-primary/50";
const LABEL = "text-[10px] font-semibold uppercase tracking-wide text-muted-foreground";

function Field({
  label,
  hint,
  children,
  className,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("block space-y-1", className)}>
      <div className="flex items-baseline justify-between gap-2">
        <span className={LABEL}>{label}</span>
        {hint && <span className="text-[9px] font-normal normal-case text-muted-foreground/70">{hint}</span>}
      </div>
      {children}
    </div>
  );
}

// ── wizard steps ────────────────────────────────────────────────────────────
const STEPS: { id: number; title: string; subtitle: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { id: 1, title: "Identify", subtitle: "Pick a ticker or company", icon: Search },
  { id: 2, title: "Auto-fetch", subtitle: "Pull IRESS + Yahoo data", icon: Sparkles },
  { id: 3, title: "Thesis", subtitle: "Bull, bear, catalysts, risks", icon: Sparkles },
  { id: 4, title: "Fundamentals", subtitle: "Multi-year table + peers", icon: Sparkles },
  { id: 5, title: "Management & Triggers", subtitle: "Triggers and people view", icon: Sparkles },
  { id: 6, title: "Submit", subtitle: "Review and save", icon: Save },
];

// ── Yahoo / company-analysis types ─────────────────────────────────────────
interface SymbolHit {
  symbol: string;
  display: string;
  name: string;
  exchange: string;
  type: string;
  source: "iress" | "yahoo";
}
interface SearchResponse {
  ok: boolean;
  query: string;
  results: SymbolHit[];
  saCount: number;
  yahooCount: number;
}
interface AnalysisMetric {
  value: number | null;
  format: "pct" | "pct100" | "x" | "ratio" | "money" | "price" | "int";
  asOf?: string;
  note?: string;
}
interface CompanyAnalysis {
  ok: boolean;
  symbol: string;
  yahooSymbol: string;
  currency: string;
  asOf: string;
  error?: string;
  price: {
    last: number | null;
    change: number | null;
    changePct: number | null;
    marketState: string | null;
    exchange: string | null;
    priceSource?: "iress" | "yahoo";
  };
  overview: {
    name: string | null;
    description: string | null;
    ceo: string | null;
    website: string | null;
    sector: string | null;
    industry: string | null;
    country: string | null;
    employees: number | null;
    nextEarnings: string | null;
  };
  groups: Record<string, Record<string, AnalysisMetric>>;
  series: {
    years: number[];
    revenue: Array<number | null>;
    netIncome: Array<number | null>;
    eps: Array<number | null>;
    fcf: Array<number | null>;
  };
  notes: string[];
}
interface PeersResponse {
  ok: boolean;
  symbol: string;
  peers: string[];
}

const RATINGS: Rating[] = ["BUY", "ACCUMULATE", "HOLD", "SELL"];
const ESGS: (Esg | "")[] = ["", "GREEN", "AMBER", "RED"];

// ── helpers ────────────────────────────────────────────────────────────────
function metricValue(groups: CompanyAnalysis["groups"] | undefined, group: string, key: string): number | null {
  const m = groups?.[group]?.[key];
  if (!m || m.value == null || !Number.isFinite(m.value)) return null;
  return m.value;
}
function pct100(v: number | null): number | null {
  // Yahoo "pct" values are fractions (0.18 for 18%). "pct100" are already %.
  return v == null ? null : v;
}
function fmtPctDisplay(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${v.toFixed(1)}%`;
}
function fmtX(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${v.toFixed(1)}x`;
}

/** Derive Net Debt / EBITDA = Net Debt / (Margins.EBITDA × Profile.Revenue). */
function deriveNetDebtToEbitda(g: CompanyAnalysis["groups"] | undefined): number | null {
  const netDebt = metricValue(g, "Financial Health", "Net Debt");
  const rev = metricValue(g, "Profile", "Revenue");
  const ebitdaMargin = metricValue(g, "Margins", "EBITDA");
  if (netDebt == null || rev == null || ebitdaMargin == null) return null;
  const ebitda = rev * ebitdaMargin;
  if (!Number.isFinite(ebitda) || ebitda === 0) return null;
  return netDebt / ebitda;
}

/** Derive EV / FCF where FCF = Margins.FCF × Profile.Revenue. */
function deriveEvToCashflow(g: CompanyAnalysis["groups"] | undefined): number | null {
  const ev = metricValue(g, "Profile", "EV");
  const rev = metricValue(g, "Profile", "Revenue");
  const fcfMargin = metricValue(g, "Margins", "FCF");
  if (ev == null || rev == null || fcfMargin == null) return null;
  const fcf = rev * fcfMargin;
  if (!Number.isFinite(fcf) || fcf === 0) return null;
  return ev / fcf;
}

// ── ticker typeahead (mirrors analysis/ticker-search.tsx shape) ─────────────
function TickerTypeahead({
  value,
  onSelect,
  disabled,
}: {
  value: string;
  onSelect: (hit: SymbolHit) => void;
  disabled?: boolean;
}) {
  const [query, setQuery] = React.useState("");
  const [debounced, setDebounced] = React.useState("");
  const [open, setOpen] = React.useState(false);
  const [highlight, setHighlight] = React.useState(0);
  const boxRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    const id = setTimeout(() => setDebounced(query.trim()), 220);
    return () => clearTimeout(id);
  }, [query]);

  React.useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  const q = useQuery<SearchResponse>({
    queryKey: ["wizard-ticker-search", debounced],
    queryFn: async () => {
      const r = await fetch(`/api/company-analysis/search?q=${encodeURIComponent(debounced)}`, {
        cache: "no-store",
      });
      if (!r.ok) throw new Error(`search ${r.status}`);
      return r.json();
    },
    enabled: debounced.length >= 1 && !disabled,
    staleTime: 60_000,
  });

  const results = q.data?.results ?? [];
  React.useEffect(() => setHighlight(0), [debounced]);

  const choose = (hit: SymbolHit) => {
    setQuery("");
    setDebounced("");
    setOpen(false);
    onSelect(hit);
  };

  return (
    <div ref={boxRef} className="relative">
      <div className="glass-inset flex h-10 items-center gap-2 rounded-lg px-3">
        {q.isFetching && debounced ? (
          <Loader2 className="h-4 w-4 animate-spin text-primary" />
        ) : (
          <Search className="h-4 w-4 text-muted-foreground" />
        )}
        <input
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => query && setOpen(true)}
          placeholder="Search any company — NPN, Naspers, SOL, Discovery…"
          aria-label="Search a company or ticker"
          autoComplete="off"
          spellCheck={false}
          disabled={disabled}
          className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground/60"
        />
        {value && (
          <span className="shrink-0 rounded bg-primary/15 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-primary">
            {value}
          </span>
        )}
      </div>

      {open && debounced.length >= 1 ? (
        <div className="glass-panel absolute z-50 mt-1.5 max-h-72 w-full overflow-y-auto rounded-xl border border-[hsl(var(--glass-border))] p-1.5 shadow-2xl">
          {q.isLoading ? (
            <div className="flex items-center gap-2 px-3 py-3 text-[11px] text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Searching SA + global…
            </div>
          ) : results.length === 0 ? (
            <div className="px-3 py-3 text-[11px] text-muted-foreground">
              No match for "{debounced}". You can still save with the raw ticker.
            </div>
          ) : (
            <ul role="listbox">
              {results.map((hit, i) => (
                <li
                  key={`${hit.source}-${hit.symbol}`}
                  role="option"
                  aria-selected={i === highlight}
                >
                  <button
                    type="button"
                    onMouseEnter={() => setHighlight(i)}
                    onClick={() => choose(hit)}
                    className={cn(
                      "flex w-full items-center justify-between gap-3 rounded-md px-3 py-2 text-left transition-colors",
                      i === highlight ? "bg-primary/10" : "hover:bg-[hsl(var(--primary)/0.05)]",
                    )}
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="font-mono text-xs font-semibold">{hit.display}</span>
                      <span className="truncate text-[11px] text-muted-foreground">{hit.name}</span>
                    </span>
                    <span className="shrink-0 rounded border border-[hsl(var(--glass-border))] px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wide text-muted-foreground">
                      {hit.source === "iress" ? "JSE · IRESS" : hit.exchange || "Yahoo"}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}

// ── stepper chrome ─────────────────────────────────────────────────────────
function Stepper({ step }: { step: number }) {
  return (
    <nav className="flex items-center gap-1.5">
      {STEPS.map((s) => {
        const Icon = s.icon;
        const state =
          step === s.id ? "current" : step > s.id ? "done" : "todo";
        return (
          <React.Fragment key={s.id}>
            <div
              className={cn(
                "flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 py-1.5",
                state === "current" && "bg-primary/10 ring-1 ring-primary/30",
                state === "done" && "bg-[hsl(var(--up)/0.08)]",
                state === "todo" && "bg-[hsl(var(--foreground)/0.03)]",
              )}
            >
              <span
                className={cn(
                  "flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[9px] font-semibold",
                  state === "current" && "bg-primary text-primary-foreground",
                  state === "done" && "bg-up text-background",
                  state === "todo" && "bg-[hsl(var(--foreground)/0.1)] text-muted-foreground",
                )}
              >
                {state === "done" ? <Check className="h-3 w-3" /> : s.id}
              </span>
              <div className="min-w-0 flex-1 leading-tight">
                <p
                  className={cn(
                    "truncate text-[10px] font-semibold uppercase tracking-wide",
                    state === "current" && "text-primary",
                    state === "done" && "text-up",
                    state === "todo" && "text-muted-foreground",
                  )}
                >
                  {s.title}
                </p>
                <p className="truncate text-[9px] text-muted-foreground/80">{s.subtitle}</p>
              </div>
            </div>
          </React.Fragment>
        );
      })}
    </nav>
  );
}

// ── main component ─────────────────────────────────────────────────────────
export function NoteEditor({
  note,
  onSaved,
  onCancel,
}: {
  note?: ResearchNote | null;
  onSaved: (noteId: string) => void;
  onCancel: () => void;
}) {
  const editing = !!note;
  const th = note?.thesis ?? {};
  const tr = note?.triggers ?? {};
  const val = note?.valuation ?? {};

  // wizard state
  const [step, setStep] = React.useState<number>(1);

  // form state (the union of what the wizard collects)
  const [symbol, setSymbol] = React.useState<string>(note?.symbol ?? "");
  const [companyName, setCompanyName] = React.useState<string>(th.companyName ?? "");
  const [sector, setSector] = React.useState<string>(th.sector ?? "");
  const [isin, setIsin] = React.useState<string>(th.isin ?? "");
  const [horizon, setHorizon] = React.useState<string>(th.horizon ?? "");
  const [rating, setRating] = React.useState<Rating>(th.rating ?? "BUY");
  const [style, setStyle] = React.useState<string>(th.style ?? "");
  const [conviction, setConviction] = React.useState<string>(th.conviction ?? "");
  const [esg, setEsg] = React.useState<Esg | "">(th.esg ?? "");
  const [targetPrice, setTargetPrice] = React.useState<string>(
    th.targetPrice != null ? String(th.targetPrice) : "",
  );
  const [linkedStrategies, setLinkedStrategies] = React.useState<string>(
    (th.linkedStrategies ?? []).join(", "),
  );
  const [bull, setBull] = React.useState<string>(th.bull ?? "");
  const [bear, setBear] = React.useState<string>(th.bear ?? "");
  const [catalysts, setCatalysts] = React.useState<string>((th.catalysts ?? []).join("\n"));
  const [risks, setRisks] = React.useState<string>((th.risks ?? []).join("\n"));
  const [likes, setLikes] = React.useState<string>(th.likesManagement ?? "");
  const [dislikes, setDislikes] = React.useState<string>(th.dislikesManagement ?? "");

  // valuation
  const [peMultiple, setPeMultiple] = React.useState<string>(
    val.pe_multiple != null ? String(val.pe_multiple) : "",
  );
  const [evEbitda, setEvEbitda] = React.useState<string>(
    val.ev_ebitda != null ? String(val.ev_ebitda) : "",
  );
  const [roePct, setRoePct] = React.useState<string>(val.roe_pct != null ? String(val.roe_pct) : "");
  const [divYieldPct, setDivYieldPct] = React.useState<string>(
    val.div_yield_pct != null ? String(val.div_yield_pct) : "",
  );
  const [peers, setPeers] = React.useState<Peer[]>(val.peers ?? []);

  // fundamentals table
  const [funds, setFunds] = React.useState<Fundamental[]>(th.fundamentals ?? []);

  // triggers
  type TriggerKey = "buy_below" | "add_below" | "trim_above" | "sell_above" | "stop_loss";
  const [triggers, setTriggers] = React.useState<Record<TriggerKey, { price: string; note: string }>>({
    buy_below: {
      price: tr.buy_below?.price != null ? String(tr.buy_below.price) : "",
      note: tr.buy_below?.note ?? "",
    },
    add_below: {
      price: tr.add_below?.price != null ? String(tr.add_below.price) : "",
      note: tr.add_below?.note ?? "",
    },
    trim_above: {
      price: tr.trim_above?.price != null ? String(tr.trim_above.price) : "",
      note: tr.trim_above?.note ?? "",
    },
    sell_above: {
      price: tr.sell_above?.price != null ? String(tr.sell_above.price) : "",
      note: tr.sell_above?.note ?? "",
    },
    stop_loss: {
      price: tr.stop_loss?.price != null ? String(tr.stop_loss.price) : "",
      note: tr.stop_loss?.note ?? "",
    },
  });
  const setTrig = (k: TriggerKey, patch: Partial<{ price: string; note: string }>) =>
    setTriggers((prev) => ({ ...prev, [k]: { ...prev[k], ...patch } }));

  // UX state
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // step 1: ticker pick handler
  const onTickerPick = (hit: SymbolHit) => {
    setSymbol(hit.symbol.replace(/\.(JO|JSE)$/i, ""));
    setCompanyName(hit.name);
    // Sector stays user-editable; hint comes from auto-fetch.
  };

  // step 2: auto-fetch hook
  const fetchSymbol = symbol.replace(/\.(JO|JSE)$/i, "");
  const autoFetch = useQuery<{ analysis: CompanyAnalysis | null; peers: string[] | null }>({
    queryKey: ["wizard-autofetch", fetchSymbol],
    enabled: step === 2 && fetchSymbol.length > 0,
    queryFn: async () => {
      const [a, p] = await Promise.all([
        fetch(`/api/company-analysis/${encodeURIComponent(fetchSymbol)}.JO`, { cache: "no-store" }).then(
          (r) => (r.ok ? r.json() : null),
        ),
        fetch(`/api/company-analysis/${encodeURIComponent(fetchSymbol)}.JO/peers`, { cache: "no-store" }).then(
          (r) => (r.ok ? r.json() : null),
        ),
      ]);
      return {
        analysis: (a as CompanyAnalysis | null) ?? null,
        peers: ((p as PeersResponse | null)?.peers ?? null) as string[] | null,
      };
    },
    staleTime: 60_000,
  });

  const analysis = autoFetch.data?.analysis ?? null;
  const peerSymbols = autoFetch.data?.peers ?? null;

  // prefill derived metrics once analysis arrives
  const prefilledRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (!analysis || !analysis.ok) return;
    if (prefilledRef.current === analysis.symbol + analysis.asOf) return;
    prefilledRef.current = analysis.symbol + analysis.asOf;

    const g = analysis.groups;
    // Valuation block (only fill if currently empty)
    const pe = metricValue(g, "Valuation (TTM)", "P/E");
    const evEbitdaV = metricValue(g, "Valuation (TTM)", "EV/EBITDA");
    const roeV = pct100(metricValue(g, "Returns", "ROE"));
    const divV = pct100(metricValue(g, "Dividends", "Yield"));
    if (peMultiple === "" && pe != null) setPeMultiple(pe.toFixed(2));
    if (evEbitda === "" && evEbitdaV != null) setEvEbitda(evEbitdaV.toFixed(2));
    if (roePct === "" && roeV != null) setRoePct(roeV.toFixed(2));
    if (divYieldPct === "" && divV != null) setDivYieldPct(divV.toFixed(2));

    // Target price
    const tgt = metricValue(g, "Valuation (NTM)", "Price Target");
    if (targetPrice === "" && tgt != null) setTargetPrice(tgt.toFixed(2));

    // Overview fields
    if (companyName === "" && analysis.overview.name) setCompanyName(analysis.overview.name);
    if (sector === "" && analysis.overview.sector) setSector(analysis.overview.sector);

    // Fundamentals table — only fill if user hasn't populated yet
    if (funds.length === 0) {
      const rows: Fundamental[] = [];
      const revGrowth = metricValue(g, "Growth (CAGR)", "Rev 3Yr");
      const opMargin = pct100(metricValue(g, "Margins", "Operating"));
      const hepsGrowth = metricValue(g, "Growth (CAGR)", "Dil EPS 3Yr");
      const roeRow = pct100(metricValue(g, "Returns", "ROE"));
      const ndEbitda = deriveNetDebtToEbitda(g);
      const evCf = deriveEvToCashflow(g);
      const roic = pct100(metricValue(g, "Returns", "ROIC"));

      const cagrLabel = (yrs: number | null) => (yrs == null ? "—" : `${yrs.toFixed(1)}%`);

      rows.push({
        metric: "Revenue growth (3y CAGR)",
        prior: cagrLabel(null),
        current: cagrLabel(revGrowth),
        forecast: "—",
        forecastYears: ["", "", ""],
        trend:
          revGrowth != null ? (revGrowth > 8 ? "up" : revGrowth < 0 ? "down" : "flat") : "flat",
        unit: "%",
      });
      rows.push({
        metric: "Operating margin",
        prior: "—",
        current: fmtPctDisplay(opMargin),
        forecast: "—",
        forecastYears: ["", "", ""],
        trend:
          opMargin != null ? (opMargin > 18 ? "up" : opMargin < 8 ? "down" : "flat") : "flat",
        unit: "%",
      });
      rows.push({
        metric: "HEPS growth (3y CAGR)",
        prior: "—",
        current: cagrLabel(hepsGrowth),
        forecast: "—",
        forecastYears: ["", "", ""],
        trend:
          hepsGrowth != null ? (hepsGrowth > 8 ? "up" : hepsGrowth < 0 ? "down" : "flat") : "flat",
        unit: "%",
      });
      rows.push({
        metric: "ROE",
        prior: "—",
        current: fmtPctDisplay(roeRow),
        forecast: "—",
        forecastYears: ["", "", ""],
        trend:
          roeRow != null ? (roeRow > 18 ? "up" : roeRow < 8 ? "down" : "flat") : "flat",
        unit: "%",
      });
      if (roic != null) {
        rows.push({
          metric: "ROIC",
          prior: "—",
          current: fmtPctDisplay(roic),
          forecast: "—",
          forecastYears: ["", "", ""],
          trend: roic > 15 ? "up" : roic < 6 ? "down" : "flat",
          unit: "%",
        });
      }
      if (ndEbitda != null) {
        rows.push({
          metric: "Net debt / EBITDA",
          prior: "—",
          current: `${ndEbitda.toFixed(2)}x`,
          forecast: "—",
          forecastYears: ["", "", ""],
          trend: ndEbitda < 1.5 ? "up" : ndEbitda > 3 ? "down" : "flat",
          unit: "x",
        });
      }
      if (evCf != null) {
        rows.push({
          metric: "EV / Cashflow",
          prior: "—",
          current: `${evCf.toFixed(1)}x`,
          forecast: "—",
          forecastYears: ["", "", ""],
          trend: evCf < 12 ? "up" : evCf > 22 ? "down" : "flat",
          unit: "x",
        });
      }
      if (rows.length > 0) setFunds(rows);
    }

    // Peers — only fill if empty AND Yahoo returned something
    if (peers.length === 0 && peerSymbols && peerSymbols.length > 0) {
      const limited = peerSymbols.slice(0, 6).map((sym) => ({
        name: sym.replace(/\.(JO|JSE)$/i, ""),
        pe: 0,
      }));
      setPeers(limited);
    }
  }, [
    analysis,
    peerSymbols,
    companyName,
    sector,
    peMultiple,
    evEbitda,
    roePct,
    divYieldPct,
    targetPrice,
    funds.length,
    peers.length,
  ]);

  // navigation
  const canAdvance: Record<number, boolean> = {
    1: symbol.trim().length >= 1,
    2: true, // auto-fetch is advisory; user can skip
    3: true,
    4: true,
    5: true,
    6: true,
  };
  const goNext = () => {
    const target = Math.min(step + 1, STEPS.length);
    setStep(target);
  };
  const goBack = () => {
    setStep(Math.max(1, step - 1));
  };

  // save
  const toList = (s: string) =>
    s
      .split("\n")
      .map((x) => x.trim())
      .filter(Boolean);

  async function save() {
    setError(null);
    const sym = symbol.trim().toUpperCase();
    if (!sym) {
      setError("Pick a ticker before saving.");
      setStep(1);
      return;
    }
    const thesis: NoteThesis = {
      ...th,
      companyName: companyName.trim() || undefined,
      sector: sector.trim() || undefined,
      isin: isin.trim() || undefined,
      horizon: horizon.trim() || undefined,
      rating,
      style: style.trim() || undefined,
      conviction: conviction.trim() || undefined,
      esg: esg || null,
      targetPrice: targetPrice ? Number(targetPrice) : undefined,
      linkedStrategies: linkedStrategies
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean),
      bull: bull.trim() || undefined,
      bear: bear.trim() || undefined,
      catalysts: toList(catalysts),
      risks: toList(risks),
      fundamentals: funds.filter((f) => String(f.metric).trim()),
      likesManagement: likes.trim() || undefined,
      dislikesManagement: dislikes.trim() || undefined,
    };
    const trg: NoteTriggers = {
      buy_below: triggers.buy_below.price
        ? { price: Number(triggers.buy_below.price), note: triggers.buy_below.note.trim() || undefined }
        : undefined,
      add_below: triggers.add_below.price
        ? { price: Number(triggers.add_below.price), note: triggers.add_below.note.trim() || undefined }
        : undefined,
      trim_above: triggers.trim_above.price
        ? { price: Number(triggers.trim_above.price), note: triggers.trim_above.note.trim() || undefined }
        : undefined,
      sell_above: triggers.sell_above.price
        ? { price: Number(triggers.sell_above.price), note: triggers.sell_above.note.trim() || undefined }
        : undefined,
      stop_loss: triggers.stop_loss.price
        ? { price: Number(triggers.stop_loss.price), note: triggers.stop_loss.note.trim() || undefined }
        : undefined,
    };
    const valuation: NoteValuation = {
      pe_multiple: peMultiple ? Number(peMultiple) : undefined,
      ev_ebitda: evEbitda ? Number(evEbitda) : undefined,
      roe_pct: roePct ? Number(roePct) : undefined,
      div_yield_pct: divYieldPct ? Number(divYieldPct) : undefined,
      peers: peers.filter((p) => p.name.trim()),
    };

    setBusy(true);
    try {
      const res = await fetch(note ? `/api/research/notes/${note.id}` : "/api/research/notes", {
        method: editing ? "PATCH" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ symbol: sym, thesis, triggers: trg, valuation }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        note?: { id: string };
        error?: string;
        message?: string;
      };
      if (!res.ok || !json.ok || !json.note?.id) {
        setError(friendlySaveError(res.status, json.error, json.message));
        return;
      }
      onSaved(json.note.id);
    } catch (e) {
      setError(
        `Could not reach the research service. ${(e as Error).message ?? "Check your connection and retry."}`,
      );
    } finally {
      setBusy(false);
    }
  }

  function friendlySaveError(status: number, code?: string, detail?: string): string {
    if (status === 401 || code === "no-session") {
      return "Your session has expired. Sign in again and retry.";
    }
    if (status === 403 || code === "forbidden") {
      return "Your account does not have permission to create research notes yet. Ask an admin to grant research-lab / create_research_note.";
    }
    if (status === 409) {
      return detail ?? "The research_note_c table isn't migrated yet on the institutional DB.";
    }
    if (status === 503) {
      return detail ?? "The institutional database is not configured.";
    }
    return detail ?? code ?? `Save failed (${status}).`;
  }

  // ── step renderers ─────────────────────────────────────────────────────
  const renderStep1 = () => (
    <div className="space-y-4">
      <div>
        <p className={cn(LABEL, "mb-1.5")}>Ticker or company name</p>
        <TickerTypeahead value={symbol} onSelect={onTickerPick} disabled={editing} />
        {editing && (
          <p className="mt-1 text-[10px] text-muted-foreground">
            Ticker is locked while editing — create a new note to switch instruments.
          </p>
        )}
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Ticker">
          <input
            className={INPUT}
            value={symbol}
            onChange={(e) => setSymbol(e.target.value.toUpperCase())}
            placeholder="NPN"
            disabled={editing}
          />
        </Field>
        <Field label="Company" className="sm:col-span-2">
          <input
            className={INPUT}
            value={companyName}
            onChange={(e) => setCompanyName(e.target.value)}
            placeholder="Naspers"
          />
        </Field>
        <Field label="Sector">
          <input className={INPUT} value={sector} onChange={(e) => setSector(e.target.value)} placeholder="Media" />
        </Field>
        <Field label="ISIN" hint="if known">
          <input className={INPUT} value={isin} onChange={(e) => setIsin(e.target.value)} placeholder="ZAE000015889" />
        </Field>
        <Field label="Time horizon">
          <input className={INPUT} value={horizon} onChange={(e) => setHorizon(e.target.value)} placeholder="12M" />
        </Field>
        <Field label="Rating">
          <select className={INPUT} value={rating} onChange={(e) => setRating(e.target.value as Rating)}>
            {RATINGS.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Conviction">
          <input className={INPUT} value={conviction} onChange={(e) => setConviction(e.target.value)} placeholder="HIGH CONVICTION" />
        </Field>
        <Field label="ESG">
          <select className={INPUT} value={esg} onChange={(e) => setEsg(e.target.value as Esg | "")}>
            {ESGS.map((v) => (
              <option key={v || "none"} value={v}>
                {v || "—"}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Style tag">
          <input className={INPUT} value={style} onChange={(e) => setStyle(e.target.value)} placeholder="BUY & HOLD" />
        </Field>
        <Field label="Target price (R)" hint="for upside calc">
          <input
            className={INPUT}
            value={targetPrice}
            onChange={(e) => setTargetPrice(e.target.value)}
            inputMode="decimal"
          />
        </Field>
        <Field label="Linked strategies" className="sm:col-span-3">
          <input
            className={INPUT}
            value={linkedStrategies}
            onChange={(e) => setLinkedStrategies(e.target.value)}
            placeholder="MINT SA Equity Alpha, Income"
          />
        </Field>
      </div>
    </div>
  );

  const renderStep2 = () => {
    const analysisOk = !!analysis && analysis.ok;
    return (
      <div className="space-y-3">
        <div className="rounded-md border border-[hsl(var(--glass-border))] bg-[hsl(var(--foreground)/0.02)] px-3 py-2.5">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-foreground">
                {fetchSymbol || "—"} · Auto-fetch from IRESS + Yahoo
              </p>
              <p className="text-[10px] text-muted-foreground">
                Pulls company overview, 3y CAGRs, margins, returns, valuation, financial
                health, dividends and a peer list. You'll review what to keep.
              </p>
            </div>
            {autoFetch.isFetching ? (
              <Loader2 className="h-4 w-4 animate-spin text-primary" />
            ) : autoFetch.isError ? (
              <span className="text-[10px] text-down">Fetch failed</span>
            ) : analysisOk ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-[hsl(var(--up)/0.12)] px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-up">
                <Check className="h-3 w-3" /> Ready
              </span>
            ) : null}
          </div>
        </div>

        {analysisOk && analysis && (
          <div className="grid gap-3 md:grid-cols-3">
            <PrefillCard title="Overview">
              <PrefillRow label="Company" value={analysis.overview.name ?? "—"} />
              <PrefillRow label="Sector" value={analysis.overview.sector ?? analysis.overview.industry ?? "—"} />
              <PrefillRow label="Country" value={analysis.overview.country ?? "—"} />
              <PrefillRow label="Employees" value={analysis.overview.employees?.toLocaleString() ?? "—"} />
              <PrefillRow label="Live price" value={analysis.price.last != null ? `R${analysis.price.last.toFixed(2)}` : "—"} mono />
              <PrefillRow
                label="Price source"
                value={analysis.price.priceSource === "iress" ? "IRESS (live)" : "Yahoo"}
                mono
              />
            </PrefillCard>

            <PrefillCard title="Valuation (TTM)">
              <PrefillRow label="P/E" value={fmtX(metricValue(analysis.groups, "Valuation (TTM)", "P/E"))} mono />
              <PrefillRow
                label="EV/EBITDA"
                value={fmtX(metricValue(analysis.groups, "Valuation (TTM)", "EV/EBITDA"))}
                mono
              />
              <PrefillRow label="P/FCF" value={fmtX(metricValue(analysis.groups, "Valuation (TTM)", "P/FCF"))} mono />
              <PrefillRow
                label="Target price"
                value={
                  metricValue(analysis.groups, "Valuation (NTM)", "Price Target") != null
                    ? `R${metricValue(analysis.groups, "Valuation (NTM)", "Price Target")!.toFixed(2)}`
                    : "—"
                }
                mono
              />
              <PrefillRow
                label="Net Debt / EBITDA"
                value={fmtX(deriveNetDebtToEbitda(analysis.groups))}
                mono
              />
              <PrefillRow
                label="EV / Cashflow"
                value={fmtX(deriveEvToCashflow(analysis.groups))}
                mono
              />
            </PrefillCard>

            <PrefillCard title="Returns + Growth">
              <PrefillRow label="ROE" value={fmtPctDisplay(pct100(metricValue(analysis.groups, "Returns", "ROE")))} mono />
              <PrefillRow
                label="ROIC"
                value={fmtPctDisplay(pct100(metricValue(analysis.groups, "Returns", "ROIC")))}
                mono
              />
              <PrefillRow
                label="Op margin"
                value={fmtPctDisplay(pct100(metricValue(analysis.groups, "Margins", "Operating")))}
                mono
              />
              <PrefillRow
                label="Rev growth 3y"
                value={fmtPctDisplay(metricValue(analysis.groups, "Growth (CAGR)", "Rev 3Yr"))}
                mono
              />
              <PrefillRow
                label="HEPS growth 3y"
                value={fmtPctDisplay(metricValue(analysis.groups, "Growth (CAGR)", "Dil EPS 3Yr"))}
                mono
              />
              <PrefillRow
                label="Div yield"
                value={fmtPctDisplay(pct100(metricValue(analysis.groups, "Dividends", "Yield")))}
                mono
              />
            </PrefillCard>
          </div>
        )}

        {analysisOk && peerSymbols && peerSymbols.length > 0 && (
          <div className="rounded-md border border-[hsl(var(--glass-border))] bg-[hsl(var(--foreground)/0.02)] px-3 py-2.5">
            <p className={cn(LABEL, "mb-1.5")}>
              Peer comp · Yahoo recommendations
              <span className="ml-1 text-[9px] font-normal text-muted-foreground/70">
                ({peerSymbols.length} ticker{peerSymbols.length === 1 ? "" : "s"} — first 6 will be pre-filled in step 4)
              </span>
            </p>
            <div className="flex flex-wrap gap-1">
              {peerSymbols.slice(0, 8).map((s) => (
                <span
                  key={s}
                  className="rounded border border-[hsl(var(--glass-border))] bg-[hsl(var(--foreground)/0.03)] px-1.5 py-0.5 font-mono text-[10px]"
                >
                  {s.replace(/\.(JO|JSE)$/i, "")}
                </span>
              ))}
            </div>
          </div>
        )}

        {!autoFetch.isFetching && !analysisOk && (
          <div className="rounded-md border border-amber-400/30 bg-amber-400/5 px-3 py-2 text-[11px] text-amber-500">
            Could not pull auto-fetch data for {fetchSymbol}. You can continue manually
            in the next steps.
          </div>
        )}
      </div>
    );
  };

  const renderStep3 = () => (
    <div className="space-y-3">
      <div className="grid gap-3 lg:grid-cols-2">
        <Field label="Bull thesis">
          <textarea
            className={cn(INPUT, "min-h-[120px]")}
            value={bull}
            onChange={(e) => setBull(e.target.value)}
            placeholder="Why we like it"
          />
        </Field>
        <Field label="Bear case / risks">
          <textarea
            className={cn(INPUT, "min-h-[120px]")}
            value={bear}
            onChange={(e) => setBear(e.target.value)}
            placeholder="What could break the thesis"
          />
        </Field>
        <Field label="Catalysts (one per line)">
          <textarea
            className={cn(INPUT, "min-h-[96px]")}
            value={catalysts}
            onChange={(e) => setCatalysts(e.target.value)}
            placeholder="Earnings date&#10;New product launch&#10;Regulatory tailwind"
          />
        </Field>
        <Field label="Risks (one per line)">
          <textarea
            className={cn(INPUT, "min-h-[96px]")}
            value={risks}
            onChange={(e) => setRisks(e.target.value)}
            placeholder="Currency exposure&#10;Key-person risk&#10;Customer concentration"
          />
        </Field>
      </div>
    </div>
  );

  const renderStep4 = () => (
    <div className="space-y-4">
      {/* valuation summary */}
      <div className="grid gap-3 sm:grid-cols-4">
        <Field label="P/E multiple">
          <input
            className={INPUT}
            value={peMultiple}
            onChange={(e) => setPeMultiple(e.target.value)}
            inputMode="decimal"
          />
        </Field>
        <Field label="EV/EBITDA">
          <input
            className={INPUT}
            value={evEbitda}
            onChange={(e) => setEvEbitda(e.target.value)}
            inputMode="decimal"
          />
        </Field>
        <Field label="ROE (%)">
          <input
            className={INPUT}
            value={roePct}
            onChange={(e) => setRoePct(e.target.value)}
            inputMode="decimal"
          />
        </Field>
        <Field label="Div yield (%)">
          <input
            className={INPUT}
            value={divYieldPct}
            onChange={(e) => setDivYieldPct(e.target.value)}
            inputMode="decimal"
          />
        </Field>
      </div>

      {/* fundamentals table */}
      <div>
        <div className="flex items-center justify-between">
          <p className={LABEL}>Fundamentals (Prior / Current / Y1 / Y2 / Y3 + trend)</p>
          <button
            type="button"
            onClick={() =>
              setFunds((p) => [
                ...p,
                { metric: "", prior: "", current: "", forecast: "", forecastYears: ["", "", ""], trend: "flat" },
              ])
            }
            className="inline-flex items-center gap-1 rounded-md border border-[hsl(var(--glass-border))] px-2 py-1 text-[10px] hover:bg-[hsl(var(--foreground)/0.05)]"
          >
            <Plus className="h-3 w-3" /> Add row
          </button>
        </div>
        <div className="mt-2 space-y-1.5">
          {funds.map((f, i) => {
            const y = Array.isArray(f.forecastYears) ? f.forecastYears : ["", "", ""];
            const setY = (idx: 0 | 1 | 2, v: string) => {
              const next = [...y];
              next[idx] = v;
              setFunds((p) => p.map((x, k) => (k === i ? { ...x, forecastYears: next } : x)));
            };
            return (
              <div key={i} className="flex items-center gap-1.5">
                <div className="grid min-w-0 flex-1 grid-cols-[1.4fr_1fr_1fr_1fr_1fr_1fr_70px] gap-1.5">
                  <input
                    className={INPUT}
                    value={String(f.metric)}
                    placeholder="Metric"
                    onChange={(e) =>
                      setFunds((p) => p.map((x, k) => (k === i ? { ...x, metric: e.target.value } : x)))
                    }
                  />
                  <input
                    className={INPUT}
                    value={String(f.prior)}
                    placeholder="Prior"
                    onChange={(e) =>
                      setFunds((p) => p.map((x, k) => (k === i ? { ...x, prior: e.target.value } : x)))
                    }
                  />
                  <input
                    className={INPUT}
                    value={String(f.current)}
                    placeholder="Current"
                    onChange={(e) =>
                      setFunds((p) => p.map((x, k) => (k === i ? { ...x, current: e.target.value } : x)))
                    }
                  />
                  <input className={INPUT} value={y[0] ?? ""} placeholder="Y1" onChange={(e) => setY(0, e.target.value)} />
                  <input className={INPUT} value={y[1] ?? ""} placeholder="Y2" onChange={(e) => setY(1, e.target.value)} />
                  <input className={INPUT} value={y[2] ?? ""} placeholder="Y3" onChange={(e) => setY(2, e.target.value)} />
                  <select
                    className={INPUT}
                    value={f.trend ?? "flat"}
                    onChange={(e) =>
                      setFunds((p) =>
                        p.map((x, k) =>
                          k === i ? { ...x, trend: e.target.value as Fundamental["trend"] } : x,
                        ),
                      )
                    }
                  >
                    <option value="up">up</option>
                    <option value="flat">flat</option>
                    <option value="down">down</option>
                  </select>
                </div>
                <button
                  type="button"
                  onClick={() => setFunds((p) => p.filter((_, idx) => idx !== i))}
                  className="shrink-0 rounded-md p-1.5 text-muted-foreground hover:text-down"
                  aria-label={`Remove ${f.metric}`}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            );
          })}
          {funds.length === 0 && <p className="text-caption">No fundamentals captured.</p>}
        </div>
      </div>

      {/* peer comp */}
      <div>
        <div className="flex items-center justify-between">
          <p className={LABEL}>Peer comp · valuation vs peers</p>
          <button
            type="button"
            onClick={() => setPeers((p) => [...p, { name: "", pe: 0 }])}
            className="inline-flex items-center gap-1 rounded-md border border-[hsl(var(--glass-border))] px-2 py-1 text-[10px] hover:bg-[hsl(var(--foreground)/0.05)]"
          >
            <Plus className="h-3 w-3" /> Add peer
          </button>
        </div>
        <div className="mt-2 space-y-1.5">
          {peers.map((p, i) => (
            <div key={i} className="flex items-center gap-1.5">
              <div className="grid min-w-0 flex-1 grid-cols-[1.4fr_1fr_1fr_1fr_1fr] gap-1.5">
                <input
                  className={INPUT}
                  value={p.name}
                  placeholder="Peer ticker / name"
                  onChange={(e) =>
                    setPeers((prev) => prev.map((x, idx) => (idx === i ? { ...x, name: e.target.value } : x)))
                  }
                />
                <input
                  className={INPUT}
                  value={String(p.pe ?? "")}
                  placeholder="P/E"
                  inputMode="decimal"
                  onChange={(e) =>
                    setPeers((prev) =>
                      prev.map((x, idx) => (idx === i ? { ...x, pe: Number(e.target.value) } : x)),
                    )
                  }
                />
                <input
                  className={INPUT}
                  value={String(p.evEbitda ?? "")}
                  placeholder="EV/EBITDA"
                  inputMode="decimal"
                  onChange={(e) =>
                    setPeers((prev) =>
                      prev.map((x, idx) => (idx === i ? { ...x, evEbitda: Number(e.target.value) } : x)),
                    )
                  }
                />
                <input
                  className={INPUT}
                  value={String(p.roe ?? "")}
                  placeholder="ROE %"
                  inputMode="decimal"
                  onChange={(e) =>
                    setPeers((prev) =>
                      prev.map((x, idx) => (idx === i ? { ...x, roe: Number(e.target.value) } : x)),
                    )
                  }
                />
                <input
                  className={INPUT}
                  value={String(p.divYield ?? "")}
                  placeholder="Div %"
                  inputMode="decimal"
                  onChange={(e) =>
                    setPeers((prev) =>
                      prev.map((x, idx) => (idx === i ? { ...x, divYield: Number(e.target.value) } : x)),
                    )
                  }
                />
              </div>
              <button
                type="button"
                onClick={() => setPeers((prev) => prev.filter((_, idx) => idx !== i))}
                className="shrink-0 rounded-md p-1.5 text-muted-foreground hover:text-down"
                aria-label={`Remove ${p.name}`}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
          {peers.length === 0 && <p className="text-caption">No peer comp yet.</p>}
        </div>
      </div>
    </div>
  );

  const renderStep5 = () => (
    <div className="space-y-4">
      <div className="grid gap-3 lg:grid-cols-2">
        <Field label="Management — what we love">
          <textarea
            className={cn(INPUT, "min-h-[96px]")}
            value={likes}
            onChange={(e) => setLikes(e.target.value)}
          />
        </Field>
        <Field label="Management — what worries us">
          <textarea
            className={cn(INPUT, "min-h-[96px]")}
            value={dislikes}
            onChange={(e) => setDislikes(e.target.value)}
          />
        </Field>
      </div>

      <div>
        <p className={LABEL}>Triggers</p>
        <div className="mt-2 space-y-1.5">
          {(
            [
              ["buy_below", "Buy below", "text-up"],
              ["add_below", "Add below", "text-up"],
              ["trim_above", "Trim above", "text-down"],
              ["sell_above", "Sell above", "text-down"],
              ["stop_loss", "Stop loss", "text-amber-500"],
            ] as const
          ).map(([k, label, tone]) => (
            <div key={k} className="grid grid-cols-[90px_80px_1fr_180px] items-center gap-2">
              <span className={cn("text-[11px] font-semibold uppercase tracking-wide", tone)}>{label}</span>
              <input
                className={INPUT}
                value={triggers[k].price}
                onChange={(e) => setTrig(k, { price: e.target.value })}
                placeholder="price"
                inputMode="decimal"
              />
              <input
                className={INPUT}
                value={triggers[k].note}
                onChange={(e) => setTrig(k, { note: e.target.value })}
                placeholder="note (optional)"
              />
              <span className="text-[10px] text-muted-foreground/70">
                {triggers[k].price ? `at R${Number(triggers[k].price).toFixed(2)}` : "set a price"}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );

  const renderStep6 = () => (
    <div className="space-y-3">
      <div className="rounded-md border border-[hsl(var(--glass-border))] bg-[hsl(var(--foreground)/0.02)] p-3">
        <p className={cn(LABEL, "mb-2")}>Review</p>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px]">
          <ReviewRow k="Ticker" v={symbol} />
          <ReviewRow k="Company" v={companyName || "—"} />
          <ReviewRow k="Sector" v={sector || "—"} />
          <ReviewRow k="ISIN" v={isin || "—"} />
          <ReviewRow k="Horizon" v={horizon || "—"} />
          <ReviewRow k="Rating" v={rating} />
          <ReviewRow k="Conviction" v={conviction || "—"} />
          <ReviewRow k="ESG" v={esg || "—"} />
          <ReviewRow k="Style" v={style || "—"} />
          <ReviewRow k="Target" v={targetPrice ? `R${Number(targetPrice).toFixed(2)}` : "—"} />
          <ReviewRow
            k="Valuation"
            v={`P/E ${peMultiple || "—"} · EV/EBITDA ${evEbitda || "—"} · ROE ${roePct || "—"}% · Div ${divYieldPct || "—"}%`}
          />
          <ReviewRow k="Linked strategies" v={linkedStrategies || "—"} />
          <ReviewRow k="Fundamentals rows" v={String(funds.length)} />
          <ReviewRow k="Peers" v={String(peers.filter((p) => p.name.trim()).length)} />
          <ReviewRow k="Triggers" v={String(Object.values(triggers).filter((t) => t.price).length)} />
        </dl>
      </div>
      <p className="text-[10px] text-muted-foreground">
        Saving creates the note as <b>draft</b>. You can edit and submit to IC afterwards.
      </p>
    </div>
  );

  // ── chrome ─────────────────────────────────────────────────────────────
  return (
    <GlassSection
      title={editing ? `Edit note · ${note?.symbol}` : "New research note"}
      dataSource="hybrid"
      subtitle="Structured workflow · auto-pulls fundamentals & newsflow from the IRESS/repo data layer"
      right={
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md border border-[hsl(var(--glass-border))] px-2.5 py-1 text-[11px] hover:bg-[hsl(var(--foreground)/0.05)]"
          >
            <X className="mr-1 inline h-3 w-3" />
            Cancel
          </button>
          {step > 1 && (
            <button
              type="button"
              onClick={goBack}
              disabled={busy}
              className="rounded-md border border-[hsl(var(--glass-border))] px-2.5 py-1 text-[11px] hover:bg-[hsl(var(--foreground)/0.05)] disabled:opacity-50"
            >
              <ArrowLeft className="mr-1 inline h-3 w-3" />
              Back
            </button>
          )}
          {step < STEPS.length ? (
            <button
              type="button"
              onClick={goNext}
              disabled={!canAdvance[step]}
              className="inline-flex items-center gap-1 rounded-md bg-primary px-2.5 py-1 text-[11px] font-medium text-primary-foreground disabled:opacity-50"
            >
              Next
              <ArrowRight className="h-3 w-3" />
            </button>
          ) : (
            <button
              type="button"
              onClick={save}
              disabled={busy}
              className="inline-flex items-center gap-1 rounded-md bg-primary px-2.5 py-1 text-[11px] font-medium text-primary-foreground disabled:opacity-50"
            >
              <Save className="h-3 w-3" />
              {busy ? "Saving…" : "Save draft"}
            </button>
          )}
        </div>
      }
    >
      <div className="mb-3">
        <Stepper step={step} />
      </div>

      {error && (
        <p className="mb-2.5 rounded-md border border-[hsl(var(--down)/0.35)] bg-[hsl(var(--down)/0.1)] px-2.5 py-1.5 text-[11px] text-down">
          {error}
        </p>
      )}

      {step === 1 && renderStep1()}
      {step === 2 && renderStep2()}
      {step === 3 && renderStep3()}
      {step === 4 && renderStep4()}
      {step === 5 && renderStep5()}
      {step === 6 && renderStep6()}

      <div className="mt-4 flex items-center justify-between border-t border-[hsl(var(--glass-border))] pt-3 text-[10px] text-muted-foreground">
        <span>Step {step} of {STEPS.length} · {STEPS[step - 1]?.title}</span>
        <span>
          <kbd className="rounded border border-[hsl(var(--glass-border))] px-1 font-mono text-[9px]">Back</kbd>
          {" / "}
          <kbd className="rounded border border-[hsl(var(--glass-border))] px-1 font-mono text-[9px]">Next</kbd>
          {" to advance"}
        </span>
      </div>
    </GlassSection>
  );
}

// ── small helpers used above ──────────────────────────────────────────────
function PrefillCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-[hsl(var(--glass-border))] bg-[hsl(var(--foreground)/0.02)] p-3">
      <p className={cn(LABEL, "mb-1.5")}>{title}</p>
      <dl className="space-y-1">{children}</dl>
    </div>
  );
}

function PrefillRow({
  label,
  value,
  mono,
}: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-2 text-[11px]">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={cn("text-right", mono && "font-mono tabular-nums")}>{value}</dd>
    </div>
  );
}

function ReviewRow({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-2 border-b border-[hsl(var(--glass-border)/0.4)] py-1 last:border-0">
      <dt className="text-muted-foreground">{k}</dt>
      <dd className="max-w-[60%] truncate text-right font-medium">{v}</dd>
    </div>
  );
}
