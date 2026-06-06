export type BusinessType = "employer" | "stokvel";

export interface InsuranceProduct {
  id: string;
  name: string;
  category: "life" | "funeral" | "disability" | "group_cover" | "income_protection";
  basePremium: number; // monthly per member
  mintPremium: number; // 200% markup — what the client pays
  coverAmount: number;
  description: string;
  features: string[];
  underwriter: string;
  status: "available" | "coming_soon";
}

export interface Member {
  id: string;
  name: string;
  email: string;
  phone: string;
  idNumber: string;
  role: "employee" | "member";
  status: "active" | "pending_kyc" | "onboarding" | "suspended";
  joinedDate: string;
  salary?: number; // for employees
  contribution?: number; // for stokvel members
  strategiesAllocated: string[];
  insuranceProducts: string[];
  totalInvested: number;
  currentValue: number;
}

export interface BusinessEntity {
  id: string;
  name: string;
  type: BusinessType;
  registrationNumber: string;
  contactPerson: string;
  email: string;
  phone: string;
  totalAUM: number;
  totalMembers: number;
  activeMembers: number;
  monthlyContribution: number;
  status: "active" | "pending" | "suspended";
  joinedDate: string;
}

// ── Markup multiplier: 250% margin = client pays 3.5× base ──
export const MARKUP_MULTIPLIER = 3.5;

export const insuranceProducts: InsuranceProduct[] = [
  {
    id: "ins1",
    name: "Group Life Cover",
    category: "life",
    basePremium: 45,
    mintPremium: Math.round(45 * MARKUP_MULTIPLIER),
    coverAmount: 500000,
    description: "Comprehensive group life cover for employees and members. Pays out a lump sum to beneficiaries on death.",
    features: ["No medical underwriting up to R500k", "24-month waiting period waived for accidents", "Spouse & child cover optional", "Monthly premium deducted"],
    underwriter: "Sanlam Group Risk",
    status: "available",
  },
  {
    id: "ins2",
    name: "Funeral Cover",
    category: "funeral",
    basePremium: 25,
    mintPremium: Math.round(25 * MARKUP_MULTIPLIER),
    coverAmount: 50000,
    description: "Dignity funeral cover with immediate payout within 48 hours of claim submission.",
    features: ["48-hour payout guarantee", "Cover for member + 6 dependants", "Grocery & tombstone benefit", "No waiting period for accidents"],
    underwriter: "Hollard Life",
    status: "available",
  },
  {
    id: "ins3",
    name: "Income Protection",
    category: "income_protection",
    basePremium: 85,
    mintPremium: Math.round(85 * MARKUP_MULTIPLIER),
    coverAmount: 0,
    description: "Replaces up to 75% of monthly income if member is unable to work due to illness or injury.",
    features: ["75% income replacement", "Covers illness & injury", "Benefit period up to retirement", "1-month waiting period"],
    underwriter: "Discovery Life",
    status: "available",
  },
  {
    id: "ins4",
    name: "Group Disability",
    category: "disability",
    basePremium: 60,
    mintPremium: Math.round(60 * MARKUP_MULTIPLIER),
    coverAmount: 300000,
    description: "Lump sum payout on permanent disability enabling financial security during recovery.",
    features: ["Permanent & temporary disability", "Lump sum or monthly benefit", "Occupational & functional assessment", "Return-to-work programme"],
    underwriter: "Liberty Group",
    status: "available",
  },
  {
    id: "ins5",
    name: "Group Critical Illness",
    category: "group_cover",
    basePremium: 55,
    mintPremium: Math.round(55 * MARKUP_MULTIPLIER),
    coverAmount: 250000,
    description: "Pays out on diagnosis of specified critical illnesses including cancer, stroke, and heart attack.",
    features: ["Covers 30+ critical conditions", "Lump sum on diagnosis", "No waiting period for cancer", "Wellness programme included"],
    underwriter: "Old Mutual",
    status: "coming_soon",
  },
];

// ── Funeral Cover Tiers (dynamic pricing with 250% margin) ──
export interface FuneralCoverTier {
  id: string;
  label: string;
  coverAmount: number;
  basePremium: number;
  mintPremium: number;
  maxDependants: number;
  dependantBasePremium: number;
  dependantMintPremium: number;
  childBasePremium: number;
  childMintPremium: number;
  features: string[];
}

export const funeralCoverTiers: FuneralCoverTier[] = [
  {
    id: "fc_basic",
    label: "Basic",
    coverAmount: 15000,
    basePremium: 15,
    mintPremium: Math.round(15 * MARKUP_MULTIPLIER),
    maxDependants: 4,
    dependantBasePremium: 10,
    dependantMintPremium: Math.round(10 * MARKUP_MULTIPLIER),
    childBasePremium: 5,
    childMintPremium: Math.round(5 * MARKUP_MULTIPLIER),
    features: ["48-hour payout", "Grocery benefit R2,000", "Tombstone benefit R3,000"],
  },
  {
    id: "fc_standard",
    label: "Standard",
    coverAmount: 30000,
    basePremium: 25,
    mintPremium: Math.round(25 * MARKUP_MULTIPLIER),
    maxDependants: 6,
    dependantBasePremium: 15,
    dependantMintPremium: Math.round(15 * MARKUP_MULTIPLIER),
    childBasePremium: 8,
    childMintPremium: Math.round(8 * MARKUP_MULTIPLIER),
    features: ["48-hour payout", "Grocery benefit R5,000", "Tombstone benefit R5,000", "Repatriation benefit"],
  },
  {
    id: "fc_premium",
    label: "Premium",
    coverAmount: 50000,
    basePremium: 40,
    mintPremium: Math.round(40 * MARKUP_MULTIPLIER),
    maxDependants: 8,
    dependantBasePremium: 22,
    dependantMintPremium: Math.round(22 * MARKUP_MULTIPLIER),
    childBasePremium: 12,
    childMintPremium: Math.round(12 * MARKUP_MULTIPLIER),
    features: ["48-hour payout", "Grocery benefit R10,000", "Tombstone benefit R8,000", "Repatriation benefit", "Airtime & data benefit", "Memorial service cover"],
  },
];

// ── Members ──
export const members: Member[] = [
  {
    id: "m1", name: "Bongani Sithole", email: "bongani@acmecorp.co.za", phone: "+27 71 111 2222",
    idNumber: "9001015800083", role: "employee", status: "active", joinedDate: "2025-08-01",
    salary: 45000, strategiesAllocated: ["s1", "s5"], insuranceProducts: ["ins1", "ins2"],
    totalInvested: 125000, currentValue: 132500,
  },
  {
    id: "m2", name: "Nomvula Zwane", email: "nomvula@acmecorp.co.za", phone: "+27 72 222 3333",
    idNumber: "9203125800081", role: "employee", status: "active", joinedDate: "2025-08-01",
    salary: 38000, strategiesAllocated: ["s1"], insuranceProducts: ["ins1", "ins2", "ins3"],
    totalInvested: 98000, currentValue: 101920,
  },
  {
    id: "m3", name: "Tshepo Moagi", email: "tshepo@acmecorp.co.za", phone: "+27 73 333 4444",
    idNumber: "8805205800087", role: "employee", status: "active", joinedDate: "2025-09-15",
    salary: 52000, strategiesAllocated: ["s2", "s5"], insuranceProducts: ["ins1"],
    totalInvested: 210000, currentValue: 226800,
  },
  {
    id: "m4", name: "Lindiwe Nkabinde", email: "lindiwe@gmail.com", phone: "+27 74 444 5555",
    idNumber: "9506155800089", role: "member", status: "active", joinedDate: "2025-10-01",
    contribution: 2000, strategiesAllocated: ["s1", "s3"], insuranceProducts: ["ins2"],
    totalInvested: 48000, currentValue: 50400,
  },
  {
    id: "m5", name: "Mandla Dube", email: "mandla@yahoo.co.za", phone: "+27 75 555 6666",
    idNumber: "8712105800085", role: "member", status: "active", joinedDate: "2025-10-01",
    contribution: 3500, strategiesAllocated: ["s2"], insuranceProducts: ["ins1", "ins2", "ins4"],
    totalInvested: 84000, currentValue: 90720,
  },
  {
    id: "m6", name: "Thandiwe Mkhize", email: "thandiwe@outlook.com", phone: "+27 76 666 7777",
    idNumber: "9108255800082", role: "member", status: "pending_kyc", joinedDate: "2026-03-20",
    contribution: 1500, strategiesAllocated: [], insuranceProducts: [],
    totalInvested: 0, currentValue: 0,
  },
  {
    id: "m7", name: "Sifiso Nene", email: "sifiso@acmecorp.co.za", phone: "+27 77 777 8888",
    idNumber: "9404015800086", role: "employee", status: "onboarding", joinedDate: "2026-04-01",
    salary: 35000, strategiesAllocated: [], insuranceProducts: [],
    totalInvested: 0, currentValue: 0,
  },
  {
    id: "m8", name: "Palesa Motaung", email: "palesa@gmail.com", phone: "+27 78 888 9999",
    idNumber: "9607125800080", role: "member", status: "pending_kyc", joinedDate: "2026-03-28",
    contribution: 2500, strategiesAllocated: [], insuranceProducts: [],
    totalInvested: 0, currentValue: 0,
  },
];

export const businessEntities: BusinessEntity[] = [
  {
    id: "biz1", name: "Acme Manufacturing (Pty) Ltd", type: "employer",
    registrationNumber: "2020/123456/07", contactPerson: "Thabo Makgoba",
    email: "hr@acmecorp.co.za", phone: "+27 11 234 5678",
    totalAUM: 1250000, totalMembers: 4, activeMembers: 3,
    monthlyContribution: 85000, status: "active", joinedDate: "2025-07-15",
  },
  {
    id: "biz2", name: "Masakhane Stokvel Group", type: "stokvel",
    registrationNumber: "STK-2025-0042", contactPerson: "Lindiwe Nkabinde",
    email: "masakhane@gmail.com", phone: "+27 74 444 5555",
    totalAUM: 482000, totalMembers: 4, activeMembers: 2,
    monthlyContribution: 9500, status: "active", joinedDate: "2025-09-01",
  },
];

// ── Helpers ──
export function formatInsurancePremium(amount: number): string {
  return `R${amount.toFixed(0)}/pm`;
}

export function calcInsuranceMargin(product: InsuranceProduct): number {
  return product.mintPremium - product.basePremium;
}

export function calcTotalInsuranceRevenue(memberCount: number, products: InsuranceProduct[]): number {
  return products.reduce((sum, p) => sum + calcInsuranceMargin(p) * memberCount, 0);
}

export function getMembersByType(type: "employee" | "member"): Member[] {
  return members.filter(m => m.role === type);
}

export function getActiveMembers(): Member[] {
  return members.filter(m => m.status === "active");
}
