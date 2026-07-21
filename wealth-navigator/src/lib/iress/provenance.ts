/**
 * Data provenance registry — single source of truth for what's live vs seed.
 * Used by DATA_PROVENANCE.md (kept in sync manually) and /api/iress/provenance.
 */

export type ProvenanceStatus = "LIVE" | "MOCK" | "SEED" | "HYBRID" | "PENDING";

export interface DataSurface {
  surface: string;
  route: string;
  component: string;
  currentSource: string;
  canBeLive: boolean;
  v4Method: string;
  status: ProvenanceStatus;
  notes?: string;
}

/** Full inventory of OEMS + shared data surfaces. */
export const DATA_SURFACES: DataSurface[] = [
  // ── Cockpit ──────────────────────────────────────────────────────
  { surface: "Cockpit KPIs (AUM, P&L, strategies)", route: "/oems", component: "cockpit-client.tsx", currentSource: "seed.ts → oemsStrategies", canBeLive: false, v4Method: "—", status: "SEED", notes: "Portfolio AUM not in cut-down WSDL" },
  { surface: "Cockpit sector heatmap", route: "/oems", component: "SectorHeatmap", currentSource: "seed.ts → sectorHeatmap", canBeLive: true, v4Method: "PricingQuoteGet (sector indices)", status: "SEED" },
  { surface: "Cockpit ZAR govi curve", route: "/oems", component: "cockpit-client.tsx", currentSource: "seed.ts → zarGoviCurve", canBeLive: true, v4Method: "TimeSeriesGet2 (ZAR_NSS)", status: "SEED" },
  { surface: "Cockpit top movers", route: "/oems", component: "cockpit-client.tsx", currentSource: "seed + tick stream", canBeLive: true, v4Method: "PricingQuoteGet", status: "HYBRID", notes: "Live quote API seeds tick store when IRESS_MODE=live" },
  { surface: "Cockpit ALSI intraday chart", route: "/oems", component: "cockpit-client.tsx", currentSource: "seed indices + synthetic intraday", canBeLive: true, v4Method: "TimeSeriesGet2 (J203/ALSI)", status: "SEED" },
  { surface: "Cockpit open orders table", route: "/oems", component: "cockpit-client.tsx", currentSource: "mock.ts → liveOrders", canBeLive: true, v4Method: "OrderPadGetByAccount", status: "SEED", notes: "Needs IRESS_ACCOUNT_CODE" },
  { surface: "Cockpit SENS feed", route: "/oems", component: "cockpit-client.tsx", currentSource: "/api/iress/news → Railway worker → NewsHeadlineGet (SENSD)", canBeLive: true, v4Method: "NewsHeadlineGet (SENSD)", status: "HYBRID", notes: "Live sub-second path on Vercel; flip IRESS_MODE=live + IRESS_WORKER_URL + USE_SUPABASE_QUOTES=true on Vercel to enable. /oems/news archive also reads institutional news_item_c (worker ingest)." },
  { surface: "Cockpit news flow", route: "/oems", component: "cockpit-client.tsx", currentSource: "seed.ts → newsFeed", canBeLive: false, v4Method: "—", status: "SEED" },
  { surface: "Cockpit macro pulse", route: "/oems", component: "cockpit-client.tsx", currentSource: "seed.ts → macroIndicators", canBeLive: false, v4Method: "—", status: "SEED" },
  { surface: "Cockpit JIBAR / USDZAR KPIs", route: "/oems", component: "KpiTile + NumberCell", currentSource: "seed + tick stream", canBeLive: true, v4Method: "PricingQuoteGet / TimeSeriesGet2", status: "HYBRID" },
  { surface: "Cockpit curve PCA", route: "/oems", component: "cockpit-client.tsx", currentSource: "hardcoded PCA factors", canBeLive: false, v4Method: "—", status: "SEED" },

  // ── Blotter ──────────────────────────────────────────────────────
  { surface: "Blotter orders table", route: "/oems/blotter", component: "blotter/page.tsx", currentSource: "mock.ts → liveOrders", canBeLive: true, v4Method: "OrderPadGetByAccount", status: "SEED" },
  // 2026-07-20: Blotter new order now routes through /api/orders/preflight
  // (worker gate) → /api/orders/submit (worker fan-out). The provenance
  // flipped MOCK → LIVE; the BFF now writes an audit row in the same shape
  // as the admin UAT route, and the worker pre-trade guard runs BEFORE the
  // insert so no phantom working rows survive a blocked verdict.
  { surface: "Blotter new order", route: "/oems/blotter", component: "new-order-dialog.tsx", currentSource: "BFF /api/orders/submit → worker /uat/preflight + /uat/send-to-market", canBeLive: true, v4Method: "OrderCreate3", status: "LIVE", notes: "Routed via BFF since 2026-07-20 — see src/lib/orders/" },
  { surface: "Blotter cancel/amend", route: "/oems/blotter", component: "blotter/page.tsx", currentSource: "mock client", canBeLive: true, v4Method: "OrderDelete / OrderAmend2", status: "MOCK" },

  // ── Security ─────────────────────────────────────────────────────
  { surface: "Security quote header", route: "/oems/security", component: "security/page.tsx", currentSource: "seed + /api/iress/quotes (live)", canBeLive: true, v4Method: "PricingQuoteGet", status: "HYBRID" },
  { surface: "Security intraday chart", route: "/oems/security", component: "SecurityChart", currentSource: "tick stream (/api/ticks)", canBeLive: true, v4Method: "PricingQuoteGetUpdates", status: "HYBRID" },
  { surface: "Security depth L2", route: "/oems/security", component: "DepthLadder", currentSource: "synthetic from seed last", canBeLive: false, v4Method: "—", status: "SEED" },
  { surface: "Security time & sales", route: "/oems/security", component: "TimeAndSales", currentSource: "synthetic", canBeLive: false, v4Method: "—", status: "SEED" },
  { surface: "Security fundamentals grid", route: "/oems/security", component: "security/page.tsx", currentSource: "hardcoded + seed-derived", canBeLive: false, v4Method: "—", status: "SEED" },
  { surface: "Security watchlist", route: "/oems/security", component: "security/page.tsx", currentSource: "seed.ts → jseEquities", canBeLive: true, v4Method: "PricingQuoteGet (batch)", status: "HYBRID" },

  // ── Other OEMS pages ─────────────────────────────────────────────
  { surface: "Equities universe", route: "/oems/equities", component: "equities/page.tsx", currentSource: "seed.ts → jseEquities", canBeLive: true, v4Method: "PricingQuoteGet", status: "SEED" },
  { surface: "Strategies list + holdings", route: "/oems/strategies", component: "strategies/page.tsx", currentSource: "seed.ts", canBeLive: false, v4Method: "—", status: "SEED" },
  { surface: "Fixed income bonds", route: "/oems/fixed-income", component: "fixed-income/page.tsx", currentSource: "seed.ts → bonds", canBeLive: true, v4Method: "PricingQuoteGet", status: "SEED" },
  { surface: "Money market instruments", route: "/oems/money-market", component: "money-market/page.tsx", currentSource: "seed.ts", canBeLive: true, v4Method: "TimeSeriesGet2 (JIBAR)", status: "SEED" },
  { surface: "Curves (govi/swap/real)", route: "/oems/curves", component: "curves/page.tsx", currentSource: "seed.ts", canBeLive: true, v4Method: "TimeSeriesGet2", status: "SEED" },
  { surface: "Macro indicators + calendar", route: "/oems/macro", component: "macro/page.tsx", currentSource: "seed.ts", canBeLive: false, v4Method: "—", status: "SEED" },
  { surface: "News + SENS", route: "/oems/news", component: "news/page.tsx", currentSource: "/api/iress/news (Path B worker passthrough) + /api/news?category=SENS", canBeLive: true, v4Method: "NewsHeadlineGet (SENSD)", status: "HYBRID", notes: "SENS tab → worker passthrough (live); Wires tab → RSS + Alliance; persistence at institutional news_item_c" },
  { surface: "Integration endpoint health", route: "/oems/integration", component: "integration/page.tsx", currentSource: "seed.ts → endpoints + /api/iress/health", canBeLive: true, v4Method: "IRESSSessionStart", status: "HYBRID" },

  // ── Shared infrastructure ────────────────────────────────────────
  { surface: "Ticker bar", route: "(shell)", component: "ticker-bar.tsx", currentSource: "tick stream", canBeLive: true, v4Method: "PricingQuoteGetUpdates", status: "HYBRID" },
  { surface: "Tick stream SSE", route: "/api/ticks", component: "api/ticks/route.ts", currentSource: "local random walk / live updates", canBeLive: true, v4Method: "PricingQuoteGetUpdates", status: "HYBRID" },
  { surface: "IRESS session health", route: "/api/iress/health", component: "api/iress/health", currentSource: "session-manager", canBeLive: true, v4Method: "IRESSSessionStart", status: "LIVE" },
  { surface: "Live quotes API", route: "/api/iress/quotes", component: "api/iress/quotes", currentSource: "live-queries → PricingQuoteGet", canBeLive: true, v4Method: "PricingQuoteGet", status: "LIVE" },

  // ── Persona placeholders ─────────────────────────────────────────
  { surface: "Strategist persona", route: "/strategist", component: "(persona)", currentSource: "seed / placeholder", canBeLive: false, v4Method: "—", status: "SEED" },
  { surface: "Wealth manager persona", route: "/wm", component: "(persona)", currentSource: "seed / placeholder", canBeLive: false, v4Method: "—", status: "SEED" },
  { surface: "Admin / Compliance persona", route: "/compliance", component: "(persona)", currentSource: "seed / placeholder", canBeLive: false, v4Method: "—", status: "SEED" },
  { surface: "Business persona", route: "/business", component: "(persona)", currentSource: "seed / placeholder", canBeLive: false, v4Method: "—", status: "SEED" },
  { surface: "Funeral cover persona", route: "/fc", component: "(persona)", currentSource: "seed / placeholder", canBeLive: false, v4Method: "—", status: "SEED" },
];

export function countByStatus(surfaces: DataSurface[] = DATA_SURFACES): Record<ProvenanceStatus, number> {
  const counts: Record<ProvenanceStatus, number> = { LIVE: 0, MOCK: 0, SEED: 0, HYBRID: 0, PENDING: 0 };
  for (const s of surfaces) counts[s.status]++;
  return counts;
}

export function provenanceSummary() {
  const counts = countByStatus();
  const mode = process.env.IRESS_MODE ?? "mock";
  return {
    mode,
    total: DATA_SURFACES.length,
    counts,
    surfaces: DATA_SURFACES.map((s) => ({
      surface: s.surface,
      route: s.route,
      status: s.status,
      v4Method: s.v4Method,
    })),
  };
}
