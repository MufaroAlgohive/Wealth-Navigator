export type UserRole = "strategist" | "wealth_manager" | "admin" | "business" | "funeral_cover" | "oems";

export interface Strategist {
  id: string;
  name: string;
  email: string;
  initials: string;
  strategies: string[]; // strategy IDs
}

export interface Client {
  id: string;
  name: string;
  email: string;
  phone: string;
  aum: number;
  cashBalance: number;
  status: "active" | "pending_kyc" | "onboarding" | "suspended";
  joinedDate: string;
  strategies: ClientStrategy[];
  tier: "standard" | "custom";
  wealthManagerId: string;
}

export interface ClientStrategy {
  strategyId: string;
  strategyName: string;
  allocated: number;
  currentValue: number;
  returnPct: number;
  allocatedDate: string;
}

export interface Strategy {
  id: string;
  name: string;
  managerIds: string[]; // strategist IDs
  type: "live" | "paper" | "custom";
  ytdReturn: number;
  sharpeRatio: number;
  maxDrawdown: number;
  volatility: number;
  aum: number;
  instruments: number;
  status: "approved" | "pending" | "restricted";
  description: string;
  sectorExposure: { sector: string; weight: number }[];
  investorCount: number;
}

export interface ComplianceItem {
  id: string;
  clientName: string;
  clientId: string;
  wealthManagerName: string;
  wealthManagerId: string;
  type: "kyc" | "aml" | "document_review";
  status: "pending" | "approved" | "rejected" | "requires_info";
  submittedDate: string;
  documents: { name: string; status: "uploaded" | "verified" | "rejected" }[];
  notes?: string;
}

// ── Strategists ──
export const strategists: Strategist[] = [
  { id: "st1", name: "Andile Khumalo", email: "andile@mint.co.za", initials: "AK", strategies: ["s2"] },
  { id: "st2", name: "Sarah Chen", email: "sarah@mint.co.za", initials: "SC", strategies: ["s3"] },
  { id: "st3", name: "Lisa Botha", email: "lisa@mint.co.za", initials: "LB", strategies: ["s5"] },
  { id: "st4", name: "Kagiso Mthembu", email: "kagiso@mint.co.za", initials: "KM", strategies: ["s6"] },
  { id: "st5", name: "Mint Quant Team", email: "quant@mint.co.za", initials: "MQ", strategies: ["s1"] },
  { id: "st6", name: "Mint Custom Desk", email: "custom@mint.co.za", initials: "MC", strategies: ["s4"] },
];

// ── Clients ──
export const clients: Client[] = [
  {
    id: "c1", name: "Thandi Nkosi", email: "thandi@nkosicorp.co.za", phone: "+27 82 123 4567",
    aum: 82500000, cashBalance: 4250000, status: "active", joinedDate: "2025-06-15", tier: "custom", wealthManagerId: "wm1",
    strategies: [
      { strategyId: "s1", strategyName: "MINT ETF Basket", allocated: 35000000, currentValue: 36750000, returnPct: 5.0, allocatedDate: "2025-07-01" },
      { strategyId: "s2", strategyName: "SA Equity Growth", allocated: 25000000, currentValue: 26200000, returnPct: 4.8, allocatedDate: "2025-07-15" },
      { strategyId: "s4", strategyName: "Custom High Yield", allocated: 18000000, currentValue: 18540000, returnPct: 3.0, allocatedDate: "2025-09-01" },
    ],
  },
  {
    id: "c2", name: "David van der Merwe", email: "david@vdmwealth.co.za", phone: "+27 83 234 5678",
    aum: 45200000, cashBalance: 2100000, status: "active", joinedDate: "2025-08-20", tier: "standard", wealthManagerId: "wm1",
    strategies: [
      { strategyId: "s1", strategyName: "MINT ETF Basket", allocated: 20000000, currentValue: 20800000, returnPct: 4.0, allocatedDate: "2025-09-01" },
      { strategyId: "s3", strategyName: "Global Balanced", allocated: 23000000, currentValue: 23460000, returnPct: 2.0, allocatedDate: "2025-09-15" },
    ],
  },
  {
    id: "c3", name: "Naledi Molefe", email: "naledi@molefe.co.za", phone: "+27 84 345 6789",
    aum: 67800000, cashBalance: 8500000, status: "active", joinedDate: "2025-05-10", tier: "custom", wealthManagerId: "wm1",
    strategies: [
      { strategyId: "s2", strategyName: "SA Equity Growth", allocated: 30000000, currentValue: 31800000, returnPct: 6.0, allocatedDate: "2025-06-01" },
      { strategyId: "s5", strategyName: "Income Fund", allocated: 29000000, currentValue: 29580000, returnPct: 2.0, allocatedDate: "2025-07-01" },
    ],
  },
  {
    id: "c4", name: "Sipho Dlamini", email: "sipho@dlaminicap.co.za", phone: "+27 85 456 7890",
    aum: 12300000, cashBalance: 1200000, status: "pending_kyc", joinedDate: "2026-03-28", tier: "standard", wealthManagerId: "wm1",
    strategies: [],
  },
  {
    id: "c5", name: "Fatima Patel", email: "fatima@patelinvest.co.za", phone: "+27 86 567 8901",
    aum: 0, cashBalance: 0, status: "onboarding", joinedDate: "2026-04-02", tier: "standard", wealthManagerId: "wm1",
    strategies: [],
  },
];

// ── Strategies ──
export const strategies: Strategy[] = [
  {
    id: "s1", name: "MINT ETF Basket", managerIds: ["st5"], type: "live",
    ytdReturn: 1.63, sharpeRatio: 1.30, maxDrawdown: -4.56, volatility: 12.0,
    aum: 124160000, instruments: 5, status: "approved", investorCount: 42,
    description: "Diversified ETF basket tracking JSE sectors with systematic rebalancing.",
    sectorExposure: [
      { sector: "Financials", weight: 30 }, { sector: "Resources", weight: 25 },
      { sector: "Industrials", weight: 20 }, { sector: "Technology", weight: 15 },
      { sector: "Consumer", weight: 10 },
    ],
  },
  {
    id: "s2", name: "SA Equity Growth", managerIds: ["st1"], type: "live",
    ytdReturn: 8.42, sharpeRatio: 1.55, maxDrawdown: -6.20, volatility: 15.3,
    aum: 210000000, instruments: 18, status: "approved", investorCount: 67,
    description: "Active SA equity strategy focused on mid-to-large cap growth stocks.",
    sectorExposure: [
      { sector: "Financials", weight: 35 }, { sector: "Consumer", weight: 25 },
      { sector: "Industrials", weight: 20 }, { sector: "Technology", weight: 12 },
      { sector: "Healthcare", weight: 8 },
    ],
  },
  {
    id: "s3", name: "Global Balanced", managerIds: ["st2"], type: "live",
    ytdReturn: 3.21, sharpeRatio: 1.10, maxDrawdown: -3.10, volatility: 8.5,
    aum: 450000000, instruments: 32, status: "approved", investorCount: 124,
    description: "Multi-asset global strategy with balanced risk exposure.",
    sectorExposure: [
      { sector: "US Equity", weight: 30 }, { sector: "EU Equity", weight: 20 },
      { sector: "Bonds", weight: 25 }, { sector: "EM Equity", weight: 15 },
      { sector: "Commodities", weight: 10 },
    ],
  },
  {
    id: "s4", name: "Custom High Yield", managerIds: ["st6", "st1"], type: "custom",
    ytdReturn: 5.67, sharpeRatio: 0.95, maxDrawdown: -8.40, volatility: 18.2,
    aum: 75000000, instruments: 12, status: "approved", investorCount: 8,
    description: "Custom high-yield strategy for clients with R50mn+ AUM.",
    sectorExposure: [
      { sector: "High Yield Bonds", weight: 40 }, { sector: "EM Debt", weight: 25 },
      { sector: "Equity", weight: 20 }, { sector: "Alt. Credit", weight: 15 },
    ],
  },
  {
    id: "s5", name: "Income Fund", managerIds: ["st3"], type: "live",
    ytdReturn: 2.10, sharpeRatio: 1.80, maxDrawdown: -1.20, volatility: 4.5,
    aum: 320000000, instruments: 8, status: "approved", investorCount: 203,
    description: "Conservative income-generating strategy with low volatility.",
    sectorExposure: [
      { sector: "Bonds", weight: 50 }, { sector: "Money Market", weight: 25 },
      { sector: "Property", weight: 15 }, { sector: "Preference Shares", weight: 10 },
    ],
  },
  {
    id: "s6", name: "Momentum Alpha", managerIds: ["st4"], type: "live",
    ytdReturn: 12.34, sharpeRatio: 1.72, maxDrawdown: -9.80, volatility: 20.1,
    aum: 95000000, instruments: 15, status: "pending", investorCount: 31,
    description: "High-conviction momentum strategy with systematic alpha generation.",
    sectorExposure: [
      { sector: "Technology", weight: 35 }, { sector: "Financials", weight: 25 },
      { sector: "Resources", weight: 20 }, { sector: "Industrials", weight: 20 },
    ],
  },
];

// ── Compliance ──
export const complianceItems: ComplianceItem[] = [
  {
    id: "comp1", clientName: "Sipho Dlamini", clientId: "c4",
    wealthManagerName: "James Mokoena", wealthManagerId: "wm1",
    type: "kyc", status: "pending", submittedDate: "2026-03-29",
    documents: [
      { name: "ID Document", status: "uploaded" },
      { name: "Proof of Address", status: "uploaded" },
      { name: "Source of Funds", status: "uploaded" },
    ],
  },
  {
    id: "comp2", clientName: "Fatima Patel", clientId: "c5",
    wealthManagerName: "James Mokoena", wealthManagerId: "wm1",
    type: "kyc", status: "requires_info", submittedDate: "2026-04-03",
    documents: [
      { name: "ID Document", status: "verified" },
    ],
    notes: "Missing Proof of Address and Source of Funds documentation.",
  },
  {
    id: "comp3", clientName: "Thandi Nkosi", clientId: "c1",
    wealthManagerName: "James Mokoena", wealthManagerId: "wm1",
    type: "aml", status: "approved", submittedDate: "2025-06-10",
    documents: [
      { name: "ID Document", status: "verified" },
      { name: "Proof of Address", status: "verified" },
      { name: "Source of Funds", status: "verified" },
      { name: "Tax Certificate", status: "verified" },
    ],
  },
  {
    id: "comp4", clientName: "David van der Merwe", clientId: "c2",
    wealthManagerName: "James Mokoena", wealthManagerId: "wm1",
    type: "kyc", status: "approved", submittedDate: "2025-08-15",
    documents: [
      { name: "ID Document", status: "verified" },
      { name: "Proof of Address", status: "verified" },
      { name: "Source of Funds", status: "verified" },
    ],
  },
];

// ── Helpers ──
export function formatCurrency(value: number): string {
  if (value >= 1e9) return `R${(value / 1e9).toFixed(2)}bn`;
  if (value >= 1e6) return `R${(value / 1e6).toFixed(2)}m`;
  if (value >= 1e3) return `R${(value / 1e3).toFixed(0)}k`;
  return `R${value.toFixed(2)}`;
}

export function formatPct(value: number): string {
  const sign = value >= 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}%`;
}

export function getStrategistNames(managerIds: string[]): string {
  return managerIds
    .map((id) => strategists.find((s) => s.id === id)?.name ?? "Unknown")
    .join(", ");
}

// Fee economics helpers
export function calcPerfFee(strategy: Strategy): number {
  return strategy.aum * Math.max(0, strategy.ytdReturn / 100) * 0.20;
}

export function calcStrategistBonus(strategy: Strategy, strategistId: string): number {
  const totalPerfFee = calcPerfFee(strategy);
  const strategistShare = totalPerfFee * 0.13;
  const numManagers = strategy.managerIds.length;
  if (!strategy.managerIds.includes(strategistId)) return 0;
  return strategistShare / numManagers;
}
