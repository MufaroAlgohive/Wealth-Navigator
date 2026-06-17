export type Verdict = "BUY" | "HOLD" | "SELL" | null;
export type MetricTone = "good" | "neutral" | "concern" | null;
export type ResearchRole = "strategist" | "head";

export interface HoldingRow {
  ticker: string;
  name: string;
  assetClass: string;
  sector: string;
  shares: number;
  price: number;
  value: number;
  constWeight: number;
  basketWeight: number;
  rating?: Verdict;
  pending?: boolean;
  priceSource?: "iress" | "yahoo" | "unavailable";
}

export interface FundamentalMetric {
  id: string;
  group: string;
  label: string;
  hint?: string;
  values: Record<string, string | null>;
  tones?: Record<string, MetricTone>;
  unavailable?: boolean;
}

export interface SectorSlice {
  sector: string;
  weight: number;
}

export interface ResearchStrategyMeta {
  id: string;
  name: string;
  description: string | null;
  benchmark: string;
  manager: string;
  status: string;
  inception: string | null;
  minInvestment: number;
  investorCount: number;
  aum: number;
  asOf: string;
}

export interface BasketTotals {
  constituent: number;
  cash: number;
  cashPct: number;
  basketMin: number;
}

export interface ResearchLabPayload {
  source: "retail-supabase" | "unavailable";
  reason?: string;
  strategy: ResearchStrategyMeta;
  current: {
    holdings: HoldingRow[];
    totals: BasketTotals;
    sectors: SectorSlice[];
  };
  proposed: {
    holdings: HoldingRow[];
    totals: BasketTotals;
    sectors: SectorSlice[];
  } | null;
  fundamentals: FundamentalMetric[];
  tickers: string[];
  gaps: string[];
  iressOverlay?: number;
}

export interface ResearchLabListItem {
  id: string;
  name: string;
  benchmark: string;
  holdingsCount: number;
  minInvestment: number;
  status: string;
}

export type ProposalAction = "add" | "remove";
export type ProposalStatus = "draft" | "submitted";

/** Session-scoped strategist proposal — persisted to Supabase in a later phase. */
export interface SessionProposal {
  id: string;
  action: ProposalAction;
  ticker: string;
  name: string;
  shares: number;
  thesis: string;
  /** Required for removals — what would trigger the sale. */
  saleTrigger?: string;
  status: ProposalStatus;
  createdAt: string;
}
