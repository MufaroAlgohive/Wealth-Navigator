import type {
  FundamentalMetric,
  HoldingRow,
  MetricTone,
  SectorSlice,
  BasketTotals,
  Verdict,
} from "@/lib/research-lab/types";

export interface RawHolding {
  name?: string;
  symbol?: string;
  ticker?: string;
  shares?: number;
  quantity?: number;
  weight?: number;
  pending?: boolean;
}

export interface SecurityRef {
  symbol: string;
  name: string | null;
  sector: string | null;
  industry: string | null;
  last_price: number | null;
  pe: number | null;
  eps: number | null;
  dividend_yield: number | null;
  beta: number | null;
  market_cap: number | null;
  ytd_performance: number | null;
  price_source?: "iress" | "yahoo";
}

const bare = (sym: string) => sym.replace(/\.(JO|JSE)$/i, "").toUpperCase();

export function parseHoldingsJson(raw: unknown): RawHolding[] {
  if (!Array.isArray(raw)) return [];
  return raw as RawHolding[];
}

function assetClassFromSector(sector: string | null, industry: string | null): string {
  const s = `${sector ?? ""} ${industry ?? ""}`.toLowerCase();
  if (s.includes("reit") || s.includes("real estate") || s.includes("property")) return "Real estate";
  if (s.includes("etf") || s.includes("fund")) return "Fund";
  return "Equities";
}

function formatMktCap(v: number | null): string | null {
  if (v == null || !Number.isFinite(v)) return null;
  if (v >= 1_000_000_000) return `R ${(v / 1_000_000_000).toFixed(1)}bn`;
  if (v >= 1_000_000) return `R ${(v / 1_000_000).toFixed(1)}m`;
  return `R ${Math.round(v).toLocaleString("en-ZA")}`;
}

function tonePe(pe: number | null): MetricTone {
  if (pe == null) return null;
  if (pe < 8) return "good";
  if (pe > 20) return "concern";
  return "neutral";
}

function toneDiv(y: number | null): MetricTone {
  if (y == null) return null;
  if (y >= 6) return "good";
  if (y < 2) return "concern";
  return "neutral";
}

function toneYtd(y: number | null): MetricTone {
  if (y == null) return null;
  if (y >= 5) return "good";
  if (y < -5) return "concern";
  return "neutral";
}

function heuristicVerdict(sec: SecurityRef): Verdict {
  const pe = sec.pe;
  const div = sec.dividend_yield;
  const ytd = sec.ytd_performance;
  if (pe != null && pe > 25 && (div == null || div < 3)) return "SELL";
  if (div != null && div >= 7 && (pe == null || pe < 15)) return "BUY";
  if (ytd != null && ytd < -15) return "SELL";
  return "HOLD";
}

export function buildHoldings(
  raw: RawHolding[],
  securities: Map<string, SecurityRef>,
  basketMin: number,
  opts?: { includePending?: boolean },
): HoldingRow[] {
  const filtered = opts?.includePending === false ? raw.filter((h) => !h.pending) : raw;
  const rows: HoldingRow[] = [];

  for (const h of filtered) {
    const sym = bare(String(h.symbol ?? h.ticker ?? ""));
    if (!sym) continue;
    const sec = securities.get(sym);
    const shares = Number(h.quantity ?? h.shares ?? 0);
    const priceCents = sec?.last_price;
    const price = priceCents != null && priceCents > 0 ? priceCents / 100 : 0;
    const weightPct = Number(h.weight ?? 0);
    let value = shares > 0 && price > 0 ? shares * price : 0;
    if (value <= 0 && weightPct > 0 && basketMin > 0) {
      value = (weightPct / 100) * basketMin;
    }
    rows.push({
      ticker: sym,
      name: h.name ?? sec?.name ?? sym,
      assetClass: assetClassFromSector(sec?.sector ?? null, sec?.industry ?? null),
      sector: sec?.sector ?? sec?.industry ?? "Unclassified",
      shares,
      price,
      value,
      constWeight: 0,
      basketWeight: 0,
      pending: Boolean(h.pending),
      rating: h.pending ? "BUY" : undefined,
      priceSource:
        priceCents == null || priceCents <= 0
          ? "unavailable"
          : (sec?.price_source ?? "yahoo"),
    });
  }

  const constituent = rows.reduce((s, r) => s + r.value, 0);
  for (const r of rows) {
    r.constWeight = constituent > 0 ? (r.value / constituent) * 100 : Number(raw.find(
      (h) => bare(String(h.symbol ?? h.ticker ?? "")) === r.ticker,
    )?.weight ?? 0);
    r.basketWeight = basketMin > 0 ? (r.value / basketMin) * 100 : 0;
  }
  return rows;
}

export function computeTotals(holdings: HoldingRow[], basketMin: number): BasketTotals {
  const constituent = holdings.reduce((s, r) => s + r.value, 0);
  const cash = Math.max(0, basketMin - constituent);
  const cashPct = basketMin > 0 ? (cash / basketMin) * 100 : 0;
  return { constituent, cash, cashPct, basketMin };
}

export function computeSectors(holdings: HoldingRow[], cashPct: number): SectorSlice[] {
  const bySector = new Map<string, number>();
  const totalWt = holdings.reduce((s, h) => s + h.basketWeight, 0);
  for (const h of holdings) {
    bySector.set(h.sector, (bySector.get(h.sector) ?? 0) + h.basketWeight);
  }
  const slices: SectorSlice[] = [...bySector.entries()]
    .map(([sector, weight]) => ({ sector, weight }))
    .sort((a, b) => b.weight - a.weight);
  if (cashPct > 0.01) slices.push({ sector: "Cash", weight: cashPct });
  // Normalise if weights don't sum to ~100 due to rounding
  const sum = slices.reduce((s, x) => s + x.weight, 0);
  if (sum > 0 && Math.abs(sum - (totalWt + cashPct)) > 2) {
    return slices;
  }
  return slices;
}

export function buildFundamentals(
  tickers: string[],
  securities: Map<string, SecurityRef>,
): { metrics: FundamentalMetric[]; gaps: string[] } {
  const gaps: string[] = [];
  const vals = (fn: (s: SecurityRef) => string | null) =>
    Object.fromEntries(tickers.map((t) => [t, fn(securities.get(t) ?? { symbol: t } as SecurityRef)]));
  const tones = (fn: (s: SecurityRef) => MetricTone) =>
    Object.fromEntries(
      tickers.map((t) => {
        const tone = fn(securities.get(t) ?? ({} as SecurityRef));
        return [t, tone];
      }),
    ) as Record<string, MetricTone>;

  const verdictValues = Object.fromEntries(
    tickers.map((t) => {
      const sec = securities.get(t);
      return [t, sec ? heuristicVerdict(sec) : null];
    }),
  );

  const real: FundamentalMetric[] = [
    {
      id: "verdict",
      group: "Coverage",
      label: "Model verdict",
      hint: "Heuristic from P/E, dividend yield and YTD — not investment advice",
      values: Object.fromEntries(
        tickers.map((t) => [t, verdictValues[t] as string | null]),
      ),
    },
    {
      id: "mktcap",
      group: "Liquidity",
      label: "Market cap",
      hint: "securities_c · Yahoo",
      values: vals((s) => formatMktCap(s.market_cap)),
    },
    {
      id: "pe",
      group: "Valuation",
      label: "Price-to-Earnings (TTM)",
      values: vals((s) => (s.pe == null ? null : `${s.pe.toFixed(1)}x`)),
      tones: tones((s) => tonePe(s.pe)),
    },
    {
      id: "eps",
      group: "Valuation",
      label: "EPS (TTM)",
      values: vals((s) => (s.eps == null ? null : s.eps.toFixed(2))),
    },
    {
      id: "div",
      group: "Quality & income",
      label: "Dividend yield",
      values: vals((s) => (s.dividend_yield == null ? null : `${s.dividend_yield.toFixed(2)}%`)),
      tones: tones((s) => toneDiv(s.dividend_yield)),
    },
    {
      id: "beta",
      group: "Risk",
      label: "Beta (5Y)",
      values: vals((s) => (s.beta == null ? null : s.beta.toFixed(2))),
    },
    {
      id: "ytd",
      group: "Growth & momentum",
      label: "YTD performance",
      values: vals((s) => (s.ytd_performance == null ? null : `${s.ytd_performance.toFixed(2)}%`)),
      tones: tones((s) => toneYtd(s.ytd_performance)),
    },
  ];

  const vendorBlocked: FundamentalMetric[] = [
    { id: "roe", group: "Profitability", label: "Return on Equity", unavailable: true, values: {} },
    { id: "roce", group: "Profitability", label: "Return on Capital (ROCE)", unavailable: true, values: {} },
    { id: "fcfy", group: "Quality & income", label: "Free Cash Flow Yield", unavailable: true, values: {} },
    { id: "nde", group: "Solvency", label: "Net debt / EBITDA", unavailable: true, values: {} },
  ].map((m) => ({
    ...m,
    values: Object.fromEntries(tickers.map((t) => [t, null])),
  }));

  gaps.push(
    "ROE, ROCE, FCF yield and leverage metrics require a fundamentals vendor — not in securities_c or IRESS V4.",
  );

  return { metrics: [...real, ...vendorBlocked], gaps };
}

export function securitiesMap(rows: SecurityRef[]): Map<string, SecurityRef> {
  const m = new Map<string, SecurityRef>();
  for (const r of rows) m.set(bare(r.symbol), r);
  return m;
}
