/**
 * Shared contract for the Research & IC surface. The rich note content lives in
 * the flexible `thesis` / `triggers` / `valuation` JSONB columns on
 * `research_note_c` (no schema migration needed for the fields below — they are
 * just JSON). These types are the single source of truth for the four tabs
 * (Research Library, Rebalance Builder, Investment Committee) and the seed SQL.
 */

export type NoteStatus = "draft" | "in_review" | "ic_pending" | "approved" | "rejected";
export type Rating = "BUY" | "SELL" | "HOLD" | "ACCUMULATE";
export type Esg = "GREEN" | "AMBER" | "RED";
export type CompAction = "remove" | "decrease" | "increase" | "add" | "hold";

export interface Fundamental {
  metric: string;
  prior: number | string;
  current: number | string;
  forecast: number | string;
  /** Direction hint for the trend arrow. */
  trend?: "up" | "down" | "flat";
  unit?: string;
}

export interface Peer {
  name: string;
  pe: number;
}

export interface Trigger {
  price: number;
  note?: string;
}

export interface IcLogEntry {
  actor: string;
  initials?: string;
  action: "CREATED" | "EDITED" | "COMMENTED" | "SUBMITTED" | "APPROVED" | "REJECTED";
  /** ISO timestamp or a pre-formatted display string. */
  at: string;
  note?: string;
}

export interface ProposedHolding {
  ticker: string;
  name?: string;
  action?: CompAction;
  /** Weights are percentages (e.g. 34.0 for 34%). */
  fromWeight?: number;
  toWeight?: number;
  weight?: number;
  shares?: number;
  price?: number;
  /** Research note reference code shown in the IC action table (e.g. R-NPN-04). */
  researchRef?: string;
  rating?: Rating;
  rationale?: string;
}

export interface NoteThesis {
  companyName?: string;
  sector?: string;
  isin?: string;
  horizon?: string;
  rating?: Rating;
  /** Freeform tag e.g. "BUY & HOLD". */
  style?: string;
  conviction?: string;
  esg?: Esg | null;
  analystName?: string;
  analystRole?: string;
  reviewerName?: string;
  version?: number;
  nextReview?: string;
  linkedStrategies?: string[];
  /** Target price in Rands (upside is computed vs the live current price). */
  targetPrice?: number;
  bull?: string;
  bear?: string;
  catalysts?: string[];
  risks?: string[];
  fundamentals?: Fundamental[];
  likesManagement?: string;
  dislikesManagement?: string;
  icLog?: IcLogEntry[];
  /** Set by the transition route on approve/reject. */
  _resolution?: { status: string; reason?: string; by?: string; at?: string };
}

export interface NoteTriggers {
  buy_below?: Trigger;
  add_below?: Trigger;
  trim_above?: Trigger;
  sell_above?: Trigger;
  stop_loss?: Trigger;
}

export interface NoteValuation {
  pe_multiple?: number;
  peers?: Peer[];
}

export interface ResearchNote {
  id: string;
  symbol: string;
  author_email: string;
  status: NoteStatus;
  thesis: NoteThesis;
  triggers: NoteTriggers | null;
  valuation: NoteValuation | null;
  ic_session_id: string | null;
  created_at: string;
  updated_at: string;
  submitted_at: string | null;
  approved_at: string | null;
}

export type RebalanceStatus = "pending" | "ic_approved" | "rejected" | "executed" | "cancelled";

export interface RebalanceRequest {
  id: string;
  strategy_id: string;
  requested_by: string;
  current_composition: ProposedHolding[];
  proposed_composition: ProposedHolding[];
  affected_investors: unknown | null;
  status: RebalanceStatus;
  ic_session_id: string | null;
  research_note_id: string | null;
  executed_at: string | null;
  created_at: string;
  updated_at: string;
}

/** Permission booleans resolved server-side (from `can()`) and passed to the client tabs. */
export interface ResearchPerms {
  createNote: boolean;
  approveNote: boolean;
  castVote: boolean;
  raiseRebalance: boolean;
  approveRebalance: boolean;
  pushRebalance: boolean;
}

/** Live quote (from /api/quotes). */
export interface Quote {
  symbol: string;
  last: number | null;
  changePct: number | null;
  source: string | null;
}
