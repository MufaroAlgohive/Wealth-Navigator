// ── Mint Funeral Cover – Operating System Data Layer ──

export const MARKUP_MULTIPLIER = 3.5; // 250% margin

// ── Types ──

export type GroupType = "employer" | "stokvel" | "church" | "parlour" | "community";
export type GroupStatus = "active" | "pending_approval" | "suspended" | "incomplete";
export type MemberStatus = "active" | "pending_kyc" | "draft" | "submitted" | "missing_documents" | "in_review" | "approved" | "rejected" | "lapsed" | "unpaid";
export type PolicyStatus = "active" | "waiting_period" | "lapsed" | "cancelled" | "upgraded";
export type ClaimStage = "submitted" | "documents_pending" | "under_review" | "approved" | "paid" | "rejected";
export type DocStatus = "uploaded" | "verified" | "rejected" | "missing";
export type OnboardingStatus = "draft" | "submitted" | "missing_documents" | "in_review" | "approved" | "rejected" | "active";
export type PaymentMethod = "debit_order" | "manual" | "eft" | "cash";
export type CoverType = "single" | "single_children" | "family" | "society";

export interface ContactPerson {
  name: string;
  email: string;
  phone: string;
  role: string;
}

export interface FCGroup {
  id: string;
  name: string;
  type: GroupType;
  status: GroupStatus;
  contactPersons: ContactPerson[];
  registrationNumber: string;
  billingMethod: PaymentMethod;
  schemeType: CoverType;
  principalMembers: number;
  coveredLives: number;
  monthlyPremium: number;
  lastPaymentDate: string;
  joinedDate: string;
  collectionRate: number;
  arrears: number;
  notes: string[];
}

export interface Dependant {
  id: string;
  name: string;
  relationship: "spouse" | "child" | "parent" | "extended";
  dob: string;
  age: number;
  coverAmount: number;
  waitingPeriod: { status: "completed" | "in_progress" | "not_started"; endsDate: string };
  documents: { name: string; status: DocStatus }[];
}

export interface FCMember {
  id: string;
  groupId: string;
  name: string;
  idNumber: string;
  email: string;
  phone: string;
  dob: string;
  age: number;
  coverType: CoverType;
  coverAmount: number;
  premium: number;
  costPrice: number;
  status: MemberStatus;
  onboardingStatus: OnboardingStatus;
  policyStatus: PolicyStatus;
  paymentMethod: PaymentMethod;
  joinedDate: string;
  waitingPeriod: { status: "completed" | "in_progress" | "not_started"; endsDate: string };
  dependants: Dependant[];
  documents: { name: string; status: DocStatus }[];
  lastPaymentDate: string;
  arrears: number;
}

export interface FCClaim {
  id: string;
  memberId: string;
  memberName: string;
  groupId: string;
  groupName: string;
  claimType: "death" | "funeral" | "repatriation" | "grocery" | "tombstone";
  amount: number;
  stage: ClaimStage;
  submittedDate: string;
  requiredDocuments: { name: string; status: DocStatus }[];
  payoutStatus: "pending" | "processing" | "paid" | "declined";
  payoutDate?: string;
  turnaroundDays: number;
  notes?: string;
}

export interface FCPaymentRecord {
  id: string;
  groupId: string;
  month: string;
  premiumDue: number;
  amountCollected: number;
  arrears: number;
  method: PaymentMethod;
  successRate: number;
  membersOutstanding: number;
  membersRecovered: number;
}

export interface FCDistributor {
  id: string;
  name: string;
  type: "parlour" | "agent" | "broker";
  region: string;
  membersOnboarded: number;
  activePremiumBook: number;
  retainedMembers: number;
  lapsedMembers: number;
  commissionsEarned: number;
  monthlyTrend: { month: string; members: number; commission: number }[];
  pendingApplications: number;
}

export interface ComplianceApplication {
  id: string;
  memberId: string;
  memberName: string;
  groupName: string;
  groupType: GroupType;
  submittedDate: string;
  status: "pending" | "approved" | "rejected" | "requires_info";
  documents: { name: string; status: DocStatus }[];
  riskFlags: string[];
  duplicateAlert: boolean;
  notes?: string;
}

// ── Groups ──
export const fcGroups: FCGroup[] = [
  {
    id: "g1", name: "Nkosi Holdings (Pty) Ltd", type: "employer", status: "active",
    contactPersons: [
      { name: "Thabo Ndlovu", email: "thabo@nkosiholdings.co.za", phone: "+27 11 234 5678", role: "HR Manager" },
      { name: "Nomsa Khumalo", email: "nomsa@nkosiholdings.co.za", phone: "+27 11 234 5679", role: "Finance Director" },
    ],
    registrationNumber: "2019/456789/07", billingMethod: "debit_order", schemeType: "family",
    principalMembers: 156, coveredLives: 423, monthlyPremium: 84240, lastPaymentDate: "2026-04-01",
    joinedDate: "2024-06-15", collectionRate: 97.2, arrears: 4680, notes: ["Preferred client", "Annual review due May 2026"],
  },
  {
    id: "g2", name: "Masakhane Community Stokvel", type: "stokvel", status: "active",
    contactPersons: [
      { name: "Lindiwe Mahlangu", email: "lindiwe.m@gmail.com", phone: "+27 72 345 6789", role: "Chairperson" },
    ],
    registrationNumber: "STK-2024-0891", billingMethod: "manual", schemeType: "society",
    principalMembers: 42, coveredLives: 98, monthlyPremium: 15960, lastPaymentDate: "2026-03-28",
    joinedDate: "2024-11-01", collectionRate: 89.5, arrears: 3200, notes: ["Monthly meetings last Saturday"],
  },
  {
    id: "g3", name: "Grace Fellowship Church", type: "church", status: "active",
    contactPersons: [
      { name: "Pastor David Moloi", email: "pastor@gracefellowship.org.za", phone: "+27 73 456 7890", role: "Senior Pastor" },
      { name: "Sister Precious Sithole", email: "precious@gracefellowship.org.za", phone: "+27 73 456 7891", role: "Admin Secretary" },
    ],
    registrationNumber: "NPO-2023-0567", billingMethod: "eft", schemeType: "family",
    principalMembers: 87, coveredLives: 234, monthlyPremium: 41760, lastPaymentDate: "2026-04-03",
    joinedDate: "2025-01-15", collectionRate: 93.8, arrears: 5120, notes: ["Weekly contributions via church office"],
  },
  {
    id: "g4", name: "Dignity First Funeral Services", type: "parlour", status: "active",
    contactPersons: [
      { name: "Bongani Cele", email: "bongani@dignityfirst.co.za", phone: "+27 74 567 8901", role: "Owner" },
    ],
    registrationNumber: "2021/789012/07", billingMethod: "debit_order", schemeType: "single_children",
    principalMembers: 312, coveredLives: 645, monthlyPremium: 124800, lastPaymentDate: "2026-04-01",
    joinedDate: "2023-08-20", collectionRate: 91.3, arrears: 18720, notes: ["Largest distribution partner", "Commission tier 2"],
  },
  {
    id: "g5", name: "Ubuntu Community Scheme", type: "community", status: "pending_approval",
    contactPersons: [
      { name: "Sipho Zulu", email: "sipho.z@ubuntu.org.za", phone: "+27 75 678 9012", role: "Coordinator" },
    ],
    registrationNumber: "CBO-2026-0123", billingMethod: "cash", schemeType: "society",
    principalMembers: 0, coveredLives: 0, monthlyPremium: 0, lastPaymentDate: "",
    joinedDate: "2026-04-05", collectionRate: 0, arrears: 0, notes: ["New application - pending compliance review"],
  },
  {
    id: "g6", name: "SafeGuard Mining Corp", type: "employer", status: "active",
    contactPersons: [
      { name: "Johan van Wyk", email: "johan@safeguardmining.co.za", phone: "+27 11 987 6543", role: "Benefits Manager" },
    ],
    registrationNumber: "2018/345678/07", billingMethod: "debit_order", schemeType: "family",
    principalMembers: 234, coveredLives: 612, monthlyPremium: 128520, lastPaymentDate: "2026-04-01",
    joinedDate: "2024-02-10", collectionRate: 98.5, arrears: 1920, notes: ["Platinum tier employer"],
  },
  {
    id: "g7", name: "Kgotla Traditional Council", type: "community", status: "suspended",
    contactPersons: [
      { name: "Chief Moroke Phiri", email: "kgotla.tc@outlook.com", phone: "+27 76 789 0123", role: "Chief" },
    ],
    registrationNumber: "CBO-2024-0456", billingMethod: "cash", schemeType: "society",
    principalMembers: 28, coveredLives: 64, monthlyPremium: 0, lastPaymentDate: "2026-01-15",
    joinedDate: "2024-09-01", collectionRate: 45.2, arrears: 12800, notes: ["Suspended due to 3 months arrears", "Recovery plan in discussion"],
  },
];

// ── Members (sample across groups) ──
export const fcMembers: FCMember[] = [
  {
    id: "fm1", groupId: "g1", name: "Bongani Sithole", idNumber: "9001015800083",
    email: "bongani@nkosiholdings.co.za", phone: "+27 71 111 2222", dob: "1990-01-01", age: 36,
    coverType: "family", coverAmount: 50000, premium: 140, costPrice: 40, status: "active",
    onboardingStatus: "active", policyStatus: "active", paymentMethod: "debit_order",
    joinedDate: "2024-07-01", lastPaymentDate: "2026-04-01", arrears: 0,
    waitingPeriod: { status: "completed", endsDate: "2025-01-01" },
    dependants: [
      { id: "d1", name: "Nomsa Sithole", relationship: "spouse", dob: "1992-03-15", age: 34, coverAmount: 50000,
        waitingPeriod: { status: "completed", endsDate: "2025-01-01" },
        documents: [{ name: "ID Copy", status: "verified" }, { name: "Marriage Certificate", status: "verified" }] },
      { id: "d2", name: "Thabo Sithole", relationship: "child", dob: "2015-06-20", age: 10, coverAmount: 15000,
        waitingPeriod: { status: "completed", endsDate: "2025-01-01" },
        documents: [{ name: "Birth Certificate", status: "verified" }] },
      { id: "d3", name: "Lerato Sithole", relationship: "child", dob: "2019-11-10", age: 6, coverAmount: 15000,
        waitingPeriod: { status: "completed", endsDate: "2025-01-01" },
        documents: [{ name: "Birth Certificate", status: "verified" }] },
    ],
    documents: [
      { name: "SA ID", status: "verified" }, { name: "Proof of Address", status: "verified" },
      { name: "Bank Statement", status: "verified" },
    ],
  },
  {
    id: "fm2", groupId: "g1", name: "Nomvula Zwane", idNumber: "9203125800081",
    email: "nomvula@nkosiholdings.co.za", phone: "+27 72 222 3333", dob: "1992-03-12", age: 34,
    coverType: "single_children", coverAmount: 30000, premium: 88, costPrice: 25, status: "active",
    onboardingStatus: "active", policyStatus: "active", paymentMethod: "debit_order",
    joinedDate: "2024-07-01", lastPaymentDate: "2026-04-01", arrears: 0,
    waitingPeriod: { status: "completed", endsDate: "2025-01-01" },
    dependants: [
      { id: "d4", name: "Sipho Zwane", relationship: "child", dob: "2018-09-25", age: 7, coverAmount: 15000,
        waitingPeriod: { status: "completed", endsDate: "2025-01-01" },
        documents: [{ name: "Birth Certificate", status: "verified" }] },
    ],
    documents: [
      { name: "SA ID", status: "verified" }, { name: "Proof of Address", status: "verified" },
    ],
  },
  {
    id: "fm3", groupId: "g2", name: "Lindiwe Mahlangu", idNumber: "8805205800087",
    email: "lindiwe.m@gmail.com", phone: "+27 72 345 6789", dob: "1988-05-20", age: 37,
    coverType: "family", coverAmount: 50000, premium: 140, costPrice: 40, status: "active",
    onboardingStatus: "active", policyStatus: "active", paymentMethod: "manual",
    joinedDate: "2024-11-01", lastPaymentDate: "2026-03-28", arrears: 0,
    waitingPeriod: { status: "completed", endsDate: "2025-05-01" },
    dependants: [
      { id: "d5", name: "Tshepo Mahlangu", relationship: "spouse", dob: "1986-08-10", age: 39, coverAmount: 50000,
        waitingPeriod: { status: "completed", endsDate: "2025-05-01" },
        documents: [{ name: "ID Copy", status: "verified" }] },
      { id: "d6", name: "Khanyi Mahlangu", relationship: "child", dob: "2012-02-14", age: 14, coverAmount: 15000,
        waitingPeriod: { status: "completed", endsDate: "2025-05-01" },
        documents: [{ name: "Birth Certificate", status: "verified" }] },
    ],
    documents: [
      { name: "SA ID", status: "verified" }, { name: "Proof of Address", status: "verified" },
    ],
  },
  {
    id: "fm4", groupId: "g3", name: "Precious Ngcobo", idNumber: "9506155800089",
    email: "precious.n@gmail.com", phone: "+27 73 456 7890", dob: "1995-06-15", age: 30,
    coverType: "single", coverAmount: 30000, premium: 88, costPrice: 25, status: "active",
    onboardingStatus: "active", policyStatus: "waiting_period", paymentMethod: "eft",
    joinedDate: "2026-01-15", lastPaymentDate: "2026-04-01", arrears: 0,
    waitingPeriod: { status: "in_progress", endsDate: "2026-07-15" },
    dependants: [],
    documents: [
      { name: "SA ID", status: "verified" }, { name: "Proof of Address", status: "uploaded" },
    ],
  },
  {
    id: "fm5", groupId: "g4", name: "Mandla Dube", idNumber: "8712105800085",
    email: "mandla.d@gmail.com", phone: "+27 75 555 6666", dob: "1987-12-10", age: 38,
    coverType: "family", coverAmount: 50000, premium: 140, costPrice: 40, status: "active",
    onboardingStatus: "active", policyStatus: "active", paymentMethod: "debit_order",
    joinedDate: "2023-09-01", lastPaymentDate: "2026-04-01", arrears: 0,
    waitingPeriod: { status: "completed", endsDate: "2024-03-01" },
    dependants: [
      { id: "d7", name: "Zanele Dube", relationship: "spouse", dob: "1990-04-22", age: 35, coverAmount: 50000,
        waitingPeriod: { status: "completed", endsDate: "2024-03-01" },
        documents: [{ name: "ID Copy", status: "verified" }, { name: "Marriage Certificate", status: "verified" }] },
      { id: "d8", name: "Sihle Dube", relationship: "child", dob: "2016-07-08", age: 9, coverAmount: 15000,
        waitingPeriod: { status: "completed", endsDate: "2024-03-01" },
        documents: [{ name: "Birth Certificate", status: "verified" }] },
      { id: "d9", name: "Ayanda Dube", relationship: "child", dob: "2020-01-30", age: 6, coverAmount: 15000,
        waitingPeriod: { status: "completed", endsDate: "2024-03-01" },
        documents: [{ name: "Birth Certificate", status: "verified" }] },
      { id: "d10", name: "Gogo Dube", relationship: "parent", dob: "1958-11-05", age: 67, coverAmount: 30000,
        waitingPeriod: { status: "completed", endsDate: "2024-03-01" },
        documents: [{ name: "ID Copy", status: "verified" }] },
    ],
    documents: [
      { name: "SA ID", status: "verified" }, { name: "Proof of Address", status: "verified" },
      { name: "Bank Statement", status: "verified" },
    ],
  },
  {
    id: "fm6", groupId: "g1", name: "Thandiwe Mkhize", idNumber: "9108255800082",
    email: "thandiwe.m@nkosiholdings.co.za", phone: "+27 76 666 7777", dob: "1991-08-25", age: 34,
    coverType: "family", coverAmount: 30000, premium: 88, costPrice: 25, status: "pending_kyc",
    onboardingStatus: "submitted", policyStatus: "waiting_period", paymentMethod: "debit_order",
    joinedDate: "2026-03-20", lastPaymentDate: "", arrears: 0,
    waitingPeriod: { status: "not_started", endsDate: "" },
    dependants: [
      { id: "d11", name: "Sbusiso Mkhize", relationship: "spouse", dob: "1989-12-03", age: 36, coverAmount: 30000,
        waitingPeriod: { status: "not_started", endsDate: "" },
        documents: [{ name: "ID Copy", status: "uploaded" }] },
    ],
    documents: [
      { name: "SA ID", status: "uploaded" }, { name: "Proof of Address", status: "missing" },
    ],
  },
  {
    id: "fm7", groupId: "g2", name: "Palesa Motaung", idNumber: "9607125800080",
    email: "palesa.m@outlook.com", phone: "+27 78 888 9999", dob: "1996-07-12", age: 29,
    coverType: "single", coverAmount: 15000, premium: 53, costPrice: 15, status: "pending_kyc",
    onboardingStatus: "missing_documents", policyStatus: "waiting_period", paymentMethod: "manual",
    joinedDate: "2026-03-28", lastPaymentDate: "", arrears: 0,
    waitingPeriod: { status: "not_started", endsDate: "" },
    dependants: [],
    documents: [
      { name: "SA ID", status: "uploaded" }, { name: "Proof of Address", status: "missing" },
      { name: "Bank Statement", status: "missing" },
    ],
  },
  {
    id: "fm8", groupId: "g4", name: "Sifiso Nene", idNumber: "9404015800086",
    email: "sifiso.n@dignityfirst.co.za", phone: "+27 77 777 8888", dob: "1994-04-01", age: 32,
    coverType: "single_children", coverAmount: 30000, premium: 88, costPrice: 25, status: "unpaid",
    onboardingStatus: "active", policyStatus: "lapsed", paymentMethod: "debit_order",
    joinedDate: "2024-01-15", lastPaymentDate: "2026-01-01", arrears: 264,
    waitingPeriod: { status: "completed", endsDate: "2024-07-15" },
    dependants: [
      { id: "d12", name: "Nhlanhla Nene", relationship: "child", dob: "2017-03-18", age: 9, coverAmount: 15000,
        waitingPeriod: { status: "completed", endsDate: "2024-07-15" },
        documents: [{ name: "Birth Certificate", status: "verified" }] },
    ],
    documents: [
      { name: "SA ID", status: "verified" }, { name: "Proof of Address", status: "verified" },
    ],
  },
  {
    id: "fm9", groupId: "g3", name: "Pastor David Moloi", idNumber: "7503105800084",
    email: "pastor@gracefellowship.org.za", phone: "+27 73 456 7890", dob: "1975-03-10", age: 51,
    coverType: "family", coverAmount: 50000, premium: 140, costPrice: 40, status: "active",
    onboardingStatus: "active", policyStatus: "active", paymentMethod: "eft",
    joinedDate: "2025-01-15", lastPaymentDate: "2026-04-03", arrears: 0,
    waitingPeriod: { status: "completed", endsDate: "2025-07-15" },
    dependants: [
      { id: "d13", name: "Grace Moloi", relationship: "spouse", dob: "1978-07-22", age: 47, coverAmount: 50000,
        waitingPeriod: { status: "completed", endsDate: "2025-07-15" },
        documents: [{ name: "ID Copy", status: "verified" }, { name: "Marriage Certificate", status: "verified" }] },
      { id: "d14", name: "Thato Moloi", relationship: "child", dob: "2005-09-14", age: 20, coverAmount: 15000,
        waitingPeriod: { status: "completed", endsDate: "2025-07-15" },
        documents: [{ name: "Birth Certificate", status: "verified" }] },
    ],
    documents: [
      { name: "SA ID", status: "verified" }, { name: "Proof of Address", status: "verified" },
      { name: "Bank Statement", status: "verified" },
    ],
  },
  {
    id: "fm10", groupId: "g6", name: "Johan van Wyk", idNumber: "8201155800088",
    email: "johan@safeguardmining.co.za", phone: "+27 82 123 4567", dob: "1982-01-15", age: 44,
    coverType: "family", coverAmount: 50000, premium: 140, costPrice: 40, status: "active",
    onboardingStatus: "active", policyStatus: "active", paymentMethod: "debit_order",
    joinedDate: "2024-02-10", lastPaymentDate: "2026-04-01", arrears: 0,
    waitingPeriod: { status: "completed", endsDate: "2024-08-10" },
    dependants: [
      { id: "d15", name: "Annelie van Wyk", relationship: "spouse", dob: "1984-05-20", age: 41, coverAmount: 50000,
        waitingPeriod: { status: "completed", endsDate: "2024-08-10" },
        documents: [{ name: "ID Copy", status: "verified" }, { name: "Marriage Certificate", status: "verified" }] },
    ],
    documents: [
      { name: "SA ID", status: "verified" }, { name: "Proof of Address", status: "verified" },
    ],
  },
];

// ── Claims ──
export const fcClaims: FCClaim[] = [
  {
    id: "cl1", memberId: "fm5", memberName: "Mandla Dube", groupId: "g4", groupName: "Dignity First Funeral Services",
    claimType: "funeral", amount: 50000, stage: "under_review", submittedDate: "2026-04-05",
    requiredDocuments: [
      { name: "Death Certificate", status: "uploaded" }, { name: "BI-1663", status: "uploaded" },
      { name: "Claimant ID", status: "verified" }, { name: "Bank Details", status: "uploaded" },
    ],
    payoutStatus: "pending", turnaroundDays: 3, notes: "Expedited review requested",
  },
  {
    id: "cl2", memberId: "fm1", memberName: "Bongani Sithole", groupId: "g1", groupName: "Nkosi Holdings (Pty) Ltd",
    claimType: "grocery", amount: 10000, stage: "approved", submittedDate: "2026-03-28",
    requiredDocuments: [
      { name: "Death Certificate", status: "verified" }, { name: "BI-1663", status: "verified" },
      { name: "Claimant ID", status: "verified" },
    ],
    payoutStatus: "processing", turnaroundDays: 8,
  },
  {
    id: "cl3", memberId: "fm3", memberName: "Lindiwe Mahlangu", groupId: "g2", groupName: "Masakhane Community Stokvel",
    claimType: "tombstone", amount: 8000, stage: "paid", submittedDate: "2026-03-10",
    requiredDocuments: [
      { name: "Death Certificate", status: "verified" }, { name: "Quotation", status: "verified" },
      { name: "Claimant ID", status: "verified" },
    ],
    payoutStatus: "paid", payoutDate: "2026-03-12", turnaroundDays: 2,
  },
  {
    id: "cl4", memberId: "fm9", memberName: "Pastor David Moloi", groupId: "g3", groupName: "Grace Fellowship Church",
    claimType: "death", amount: 50000, stage: "documents_pending", submittedDate: "2026-04-07",
    requiredDocuments: [
      { name: "Death Certificate", status: "missing" }, { name: "BI-1663", status: "missing" },
      { name: "Claimant ID", status: "uploaded" }, { name: "Bank Details", status: "uploaded" },
    ],
    payoutStatus: "pending", turnaroundDays: 1, notes: "Awaiting death certificate from Home Affairs",
  },
  {
    id: "cl5", memberId: "fm10", memberName: "Johan van Wyk", groupId: "g6", groupName: "SafeGuard Mining Corp",
    claimType: "repatriation", amount: 25000, stage: "submitted", submittedDate: "2026-04-08",
    requiredDocuments: [
      { name: "Death Certificate", status: "uploaded" }, { name: "Repatriation Quote", status: "missing" },
      { name: "Claimant ID", status: "uploaded" },
    ],
    payoutStatus: "pending", turnaroundDays: 0,
  },
];

// ── Payments ──
export const fcPayments: FCPaymentRecord[] = [
  { id: "p1", groupId: "g1", month: "2026-04", premiumDue: 84240, amountCollected: 81900, arrears: 2340, method: "debit_order", successRate: 97.2, membersOutstanding: 4, membersRecovered: 2 },
  { id: "p2", groupId: "g1", month: "2026-03", premiumDue: 84240, amountCollected: 82560, arrears: 1680, method: "debit_order", successRate: 98.0, membersOutstanding: 3, membersRecovered: 3 },
  { id: "p3", groupId: "g2", month: "2026-04", premiumDue: 15960, amountCollected: 14280, arrears: 1680, method: "manual", successRate: 89.5, membersOutstanding: 5, membersRecovered: 1 },
  { id: "p4", groupId: "g2", month: "2026-03", premiumDue: 15960, amountCollected: 13440, arrears: 2520, method: "manual", successRate: 84.2, membersOutstanding: 7, membersRecovered: 2 },
  { id: "p5", groupId: "g3", month: "2026-04", premiumDue: 41760, amountCollected: 39168, arrears: 2592, method: "eft", successRate: 93.8, membersOutstanding: 6, membersRecovered: 3 },
  { id: "p6", groupId: "g4", month: "2026-04", premiumDue: 124800, amountCollected: 113880, arrears: 10920, method: "debit_order", successRate: 91.3, membersOutstanding: 28, membersRecovered: 12 },
  { id: "p7", groupId: "g6", month: "2026-04", premiumDue: 128520, amountCollected: 126592, arrears: 1928, method: "debit_order", successRate: 98.5, membersOutstanding: 3, membersRecovered: 3 },
  { id: "p8", groupId: "g4", month: "2026-03", premiumDue: 124800, amountCollected: 110160, arrears: 14640, method: "debit_order", successRate: 88.3, membersOutstanding: 34, membersRecovered: 8 },
  { id: "p9", groupId: "g6", month: "2026-03", premiumDue: 128520, amountCollected: 127236, arrears: 1284, method: "debit_order", successRate: 99.0, membersOutstanding: 2, membersRecovered: 2 },
  { id: "p10", groupId: "g3", month: "2026-03", premiumDue: 41760, amountCollected: 37584, arrears: 4176, method: "eft", successRate: 90.0, membersOutstanding: 9, membersRecovered: 4 },
  { id: "p11", groupId: "g1", month: "2026-02", premiumDue: 82560, amountCollected: 80928, arrears: 1632, method: "debit_order", successRate: 98.0, membersOutstanding: 2, membersRecovered: 2 },
  { id: "p12", groupId: "g1", month: "2026-01", premiumDue: 82560, amountCollected: 81744, arrears: 816, method: "debit_order", successRate: 99.0, membersOutstanding: 1, membersRecovered: 1 },
];

// ── Distributors ──
export const fcDistributors: FCDistributor[] = [
  {
    id: "dist1", name: "Dignity First Funeral Services", type: "parlour", region: "Gauteng",
    membersOnboarded: 312, activePremiumBook: 124800, retainedMembers: 289, lapsedMembers: 23,
    commissionsEarned: 187200, pendingApplications: 14,
    monthlyTrend: [
      { month: "Nov", members: 245, commission: 12800 }, { month: "Dec", members: 258, commission: 13600 },
      { month: "Jan", members: 272, commission: 14400 }, { month: "Feb", members: 289, commission: 15200 },
      { month: "Mar", members: 298, commission: 15800 }, { month: "Apr", members: 312, commission: 16400 },
    ],
  },
  {
    id: "dist2", name: "Mahlasedi Brokers", type: "broker", region: "Limpopo",
    membersOnboarded: 156, activePremiumBook: 62400, retainedMembers: 142, lapsedMembers: 14,
    commissionsEarned: 93600, pendingApplications: 8,
    monthlyTrend: [
      { month: "Nov", members: 112, commission: 5800 }, { month: "Dec", members: 120, commission: 6200 },
      { month: "Jan", members: 128, commission: 6800 }, { month: "Feb", members: 138, commission: 7400 },
      { month: "Mar", members: 148, commission: 7800 }, { month: "Apr", members: 156, commission: 8200 },
    ],
  },
  {
    id: "dist3", name: "Siyakhula Agency", type: "agent", region: "KwaZulu-Natal",
    membersOnboarded: 89, activePremiumBook: 35600, retainedMembers: 78, lapsedMembers: 11,
    commissionsEarned: 53400, pendingApplications: 5,
    monthlyTrend: [
      { month: "Nov", members: 56, commission: 3200 }, { month: "Dec", members: 62, commission: 3600 },
      { month: "Jan", members: 68, commission: 4000 }, { month: "Feb", members: 74, commission: 4400 },
      { month: "Mar", members: 82, commission: 4800 }, { month: "Apr", members: 89, commission: 5200 },
    ],
  },
];

// ── Compliance ──
export const fcComplianceQueue: ComplianceApplication[] = [
  {
    id: "ca1", memberId: "fm6", memberName: "Thandiwe Mkhize", groupName: "Nkosi Holdings (Pty) Ltd",
    groupType: "employer", submittedDate: "2026-03-20", status: "pending",
    documents: [{ name: "SA ID", status: "uploaded" }, { name: "Proof of Address", status: "missing" }],
    riskFlags: ["Missing proof of address"], duplicateAlert: false,
  },
  {
    id: "ca2", memberId: "fm7", memberName: "Palesa Motaung", groupName: "Masakhane Community Stokvel",
    groupType: "stokvel", submittedDate: "2026-03-28", status: "requires_info",
    documents: [{ name: "SA ID", status: "uploaded" }, { name: "Proof of Address", status: "missing" }, { name: "Bank Statement", status: "missing" }],
    riskFlags: ["Multiple missing documents", "High risk - incomplete KYC"], duplicateAlert: false,
    notes: "Requested docs via SMS on 2026-04-01",
  },
  {
    id: "ca3", memberId: "fm4", memberName: "Precious Ngcobo", groupName: "Grace Fellowship Church",
    groupType: "church", submittedDate: "2026-01-15", status: "approved",
    documents: [{ name: "SA ID", status: "verified" }, { name: "Proof of Address", status: "verified" }],
    riskFlags: [], duplicateAlert: false,
  },
  {
    id: "ca4", memberId: "fm10", memberName: "Johan van Wyk", groupName: "SafeGuard Mining Corp",
    groupType: "employer", submittedDate: "2024-02-10", status: "approved",
    documents: [{ name: "SA ID", status: "verified" }, { name: "Proof of Address", status: "verified" }],
    riskFlags: [], duplicateAlert: false,
  },
  {
    id: "ca5", memberId: "new1", memberName: "Andile Masondo", groupName: "Ubuntu Community Scheme",
    groupType: "community", submittedDate: "2026-04-05", status: "pending",
    documents: [{ name: "SA ID", status: "uploaded" }, { name: "Proof of Address", status: "uploaded" }, { name: "Community Letter", status: "uploaded" }],
    riskFlags: ["New group - first member"], duplicateAlert: true,
    notes: "Possible duplicate with member in Masakhane Stokvel - verify ID number",
  },
  {
    id: "ca6", memberId: "new2", memberName: "Kagiso Tau", groupName: "Dignity First Funeral Services",
    groupType: "parlour", submittedDate: "2026-04-06", status: "pending",
    documents: [{ name: "SA ID", status: "uploaded" }, { name: "Proof of Address", status: "uploaded" }],
    riskFlags: [], duplicateAlert: false,
  },
];

// ── Activity Feed ──
export interface ActivityItem {
  id: string;
  type: "onboarding" | "payment" | "claim" | "compliance" | "alert";
  message: string;
  timestamp: string;
  severity: "info" | "warning" | "critical" | "success";
}

export const recentActivity: ActivityItem[] = [
  { id: "a1", type: "claim", message: "Claim submitted for Mandla Dube (Dignity First) — R50,000 funeral benefit", timestamp: "2026-04-08T09:30:00", severity: "info" },
  { id: "a2", type: "alert", message: "Kgotla Traditional Council suspended — 3 months arrears outstanding", timestamp: "2026-04-07T16:00:00", severity: "critical" },
  { id: "a3", type: "compliance", message: "Andile Masondo flagged as possible duplicate — manual review required", timestamp: "2026-04-07T14:20:00", severity: "warning" },
  { id: "a4", type: "payment", message: "April collections processed for Nkosi Holdings — 97.2% success rate", timestamp: "2026-04-07T10:00:00", severity: "success" },
  { id: "a5", type: "onboarding", message: "Ubuntu Community Scheme submitted for approval — 1 initial member", timestamp: "2026-04-05T11:00:00", severity: "info" },
  { id: "a6", type: "payment", message: "Masakhane Stokvel March payment R2,520 in arrears — 7 members outstanding", timestamp: "2026-04-04T09:00:00", severity: "warning" },
  { id: "a7", type: "compliance", message: "Precious Ngcobo (Grace Fellowship) KYC approved", timestamp: "2026-04-03T15:30:00", severity: "success" },
  { id: "a8", type: "claim", message: "Tombstone claim for Lindiwe Mahlangu paid — R8,000", timestamp: "2026-03-12T14:00:00", severity: "success" },
];

// ── Aggregation Helpers ──
export function getTotalGroups() { return fcGroups.length; }
export function getActiveGroups() { return fcGroups.filter(g => g.status === "active"); }
export function getTotalPrincipalMembers() { return fcGroups.reduce((s, g) => s + g.principalMembers, 0); }
export function getTotalCoveredLives() { return fcGroups.reduce((s, g) => s + g.coveredLives, 0); }
export function getTotalMonthlyPremium() { return fcGroups.filter(g => g.status === "active").reduce((s, g) => s + g.monthlyPremium, 0); }
export function getTotalArrears() { return fcGroups.reduce((s, g) => s + g.arrears, 0); }
export function getAverageCollectionRate() {
  const active = getActiveGroups();
  return active.length ? active.reduce((s, g) => s + g.collectionRate, 0) / active.length : 0;
}
export function getPendingApplications() { return fcComplianceQueue.filter(a => a.status === "pending").length; }
export function getMissingDocuments() { return fcMembers.filter(m => m.documents.some(d => d.status === "missing")).length; }
export function getActiveClaims() { return fcClaims.filter(c => c.stage !== "paid" && c.stage !== "rejected"); }
export function getClaimsThisMonth() { return fcClaims.filter(c => c.submittedDate.startsWith("2026-04")); }

export function formatCurrency(value: number): string {
  if (value >= 1e6) return `R${(value / 1e6).toFixed(2)}m`;
  if (value >= 1e3) return `R${(value / 1e3).toFixed(0)}k`;
  return `R${value.toLocaleString()}`;
}

export const groupTypeLabels: Record<GroupType, string> = {
  employer: "Employer",
  stokvel: "Stokvel",
  church: "Church",
  parlour: "Funeral Parlour",
  community: "Community Scheme",
};

export const groupTypeColors: Record<GroupType, string> = {
  employer: "bg-primary/10 text-primary",
  stokvel: "bg-warning/10 text-warning",
  church: "bg-success/10 text-success",
  parlour: "bg-destructive/10 text-destructive",
  community: "bg-accent text-accent-foreground",
};

export const statusColors: Record<string, string> = {
  active: "bg-success/10 text-success",
  pending_approval: "bg-warning/10 text-warning",
  suspended: "bg-destructive/10 text-destructive",
  incomplete: "bg-muted text-muted-foreground",
  pending_kyc: "bg-warning/10 text-warning",
  draft: "bg-muted text-muted-foreground",
  submitted: "bg-primary/10 text-primary",
  missing_documents: "bg-destructive/10 text-destructive",
  in_review: "bg-warning/10 text-warning",
  approved: "bg-success/10 text-success",
  rejected: "bg-destructive/10 text-destructive",
  lapsed: "bg-destructive/10 text-destructive",
  unpaid: "bg-warning/10 text-warning",
  waiting_period: "bg-warning/10 text-warning",
  cancelled: "bg-muted text-muted-foreground",
  upgraded: "bg-primary/10 text-primary",
  completed: "bg-success/10 text-success",
  in_progress: "bg-warning/10 text-warning",
  not_started: "bg-muted text-muted-foreground",
  pending: "bg-warning/10 text-warning",
  requires_info: "bg-primary/10 text-primary",
  uploaded: "bg-warning/10 text-warning",
  verified: "bg-success/10 text-success",
  missing: "bg-destructive/10 text-destructive",
};
