import {
  buildHoldings,
  computeSectors,
  computeTotals,
  type RawHolding,
  type SecurityRef,
} from "@/lib/research-lab/compose-basket";
import type { BasketTotals, HoldingRow, SectorSlice, SessionProposal } from "@/lib/research-lab/types";

const bare = (sym: string) => sym.replace(/\.(JO|JSE)$/i, "").toUpperCase();

/** Apply session proposals on top of published holdings. */
export function projectHoldingsFromProposals(
  base: HoldingRow[],
  proposals: SessionProposal[],
  basketMin: number,
  secMap: Map<string, SecurityRef>,
): { holdings: HoldingRow[]; totals: BasketTotals; sectors: SectorSlice[] } {
  const shareMap = new Map<string, { shares: number; name: string; pending?: boolean }>();
  for (const h of base) {
    shareMap.set(h.ticker, { shares: h.shares, name: h.name });
  }

  for (const p of proposals) {
    const existing = shareMap.get(p.ticker);
    if (p.action === "add") {
      const nextShares = (existing?.shares ?? 0) + p.shares;
      shareMap.set(p.ticker, {
        shares: nextShares,
        name: p.name || existing?.name || p.ticker,
        pending: true,
      });
    } else {
      const nextShares = Math.max(0, (existing?.shares ?? 0) - p.shares);
      if (nextShares <= 0) shareMap.delete(p.ticker);
      else shareMap.set(p.ticker, { shares: nextShares, name: existing?.name || p.name || p.ticker });
    }
  }

  const raw: RawHolding[] = [...shareMap.entries()].map(([ticker, v]) => ({
    ticker,
    symbol: ticker,
    shares: v.shares,
    name: v.name,
    pending: v.pending,
  }));

  const holdings = buildHoldings(raw, secMap, basketMin, { includePending: true });
  const totals = computeTotals(holdings, basketMin);
  const sectors = computeSectors(holdings, totals.cashPct);
  return { holdings, totals, sectors };
}

/** Preview a single in-flight change before it is added to the session list. */
export function previewProposalImpact(
  base: HoldingRow[],
  draft: Pick<SessionProposal, "action" | "ticker" | "name" | "shares">,
  basketMin: number,
  secMap: Map<string, SecurityRef>,
  existingProposals: SessionProposal[] = [],
): {
  before: HoldingRow | null;
  after: HoldingRow | null;
  holdings: HoldingRow[];
  totals: BasketTotals;
  weightDelta: number;
} {
  const temp: SessionProposal = {
    id: "__draft__",
    action: draft.action,
    ticker: draft.ticker,
    name: draft.name,
    shares: draft.shares,
    thesis: "",
    status: "draft",
    createdAt: new Date().toISOString(),
  };
  const { holdings, totals } = projectHoldingsFromProposals(
    base,
    [...existingProposals, temp],
    basketMin,
    secMap,
  );
  const before = base.find((h) => h.ticker === draft.ticker) ?? null;
  const after = holdings.find((h) => h.ticker === draft.ticker) ?? null;
  const weightDelta = (after?.basketWeight ?? 0) - (before?.basketWeight ?? 0);
  return { before, after, holdings, totals, weightDelta };
}

export function securitiesMapFromEquities(
  securities: Array<{
    symbol: string;
    name: string | null;
    sector: string | null;
    industry?: string | null;
    last_price: number | null;
    pe?: number | null;
    eps?: number | null;
    dividend_yield?: number | null;
    beta?: number | null;
    market_cap?: number | null;
    ytd_performance?: number | null;
    price_source?: "iress" | "yahoo";
  }>,
): Map<string, SecurityRef> {
  const m = new Map<string, SecurityRef>();
  for (const s of securities) {
    m.set(bare(s.symbol), {
      symbol: s.symbol,
      name: s.name,
      sector: s.sector,
      industry: s.industry ?? null,
      last_price: s.last_price,
      pe: s.pe ?? null,
      eps: s.eps ?? null,
      dividend_yield: s.dividend_yield ?? null,
      beta: s.beta ?? null,
      market_cap: s.market_cap ?? null,
      ytd_performance: s.ytd_performance ?? null,
      price_source: s.price_source,
    });
  }
  return m;
}

export function filterStockCandidates(
  securities: Array<{ symbol: string; name: string | null }>,
  query: string,
  opts?: { exclude?: Set<string>; limit?: number },
): Array<{ ticker: string; name: string }> {
  const q = query.trim().toUpperCase();
  if (q.length < 1) return [];
  const exclude = opts?.exclude ?? new Set<string>();
  return securities
    .map((s) => ({
      ticker: bare(s.symbol),
      name: s.name ?? s.symbol,
    }))
    .filter(
      (s) =>
        !exclude.has(s.ticker) &&
        (s.ticker.includes(q) || s.name.toUpperCase().includes(q)),
    )
    .slice(0, opts?.limit ?? 8);
}
