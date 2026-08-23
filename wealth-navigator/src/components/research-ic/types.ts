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
  /** Optional multi-year forecast (Year 1 / Year 2 / Year 3). When present,
   * the note-detail fundamentals table renders three columns instead of a
   * single Forecast column (Lethabo's ask: "year, year, year"). Stored as
   * strings in the editor (so empty cells don't coerce to 0); the API and
   * the note-detail renderer normalise to numbers when computing trends. */
  forecastYears?: Array<number | string> | null;
  /** Direction hint for the trend arrow. */
  trend?: "up" | "down" | "flat";
  unit?: string;
}

export interface Peer {
  name: string;
  /** Price-to-earnings multiple. */
  pe: number;
  /** Return on equity (percent, e.g. 18.5 for 18.5%). Optional. */
  roe?: number;
  /** Dividend yield (percent, e.g. 3.2 for 3.2%). Optional. */
  divYield?: number;
  /** EV/EBITDA multiple. Optional. */
  evEbitda?: number;
}
/**
 * Direction convention for a peer's metric — higher-is-better (e.g. ROE,
 * dividend yield) vs lower-is-better (e.g. P/E, EV/EBITDA). Drives the
 * green/amber/red signal in the note-detail peer scorecard.
 */
export type PeerMetricKind = "pe" | "roe" | "divYield" | "evEbitda";

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
  /** Subject company's own P/E. */
  pe_multiple?: number;
  /** Subject company's own ROE (percent). */
  roe_pct?: number;
  /** Subject company's own dividend yield (percent). */
  div_yield_pct?: number;
  /** Subject company's own EV/EBITDA multiple. */
  ev_ebitda?: number;
  peers?: Peer[];
}

export interface ResearchNote {
  id: string;
  symbol: string;
  environment_scope?: "live" | "uat";
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

export type RebalanceStatus =
  | "pending"
  | "ic_approved"
  | "rejected"
  | "executed"
  | "completing"
  | "completed"
  | "cancelled";

export type VoteValue = "yes" | "no" | "abstain";

export interface RebalanceVote {
  voter_email: string;
  vote: VoteValue;
  voted_at?: string;
}

export interface VoteTally {
  yes: number;
  no: number;
  abstain: number;
  quorum: number;
  threshold: number;
  requiredYes: number;
  ratio: number;
  passed: boolean;
}

export interface RebalanceRequest {
  id: string;
  strategy_id: string;
  requested_by: string;
  current_composition: ProposedHolding[];
  proposed_composition: ProposedHolding[];
  affected_investors: unknown | null;
  status: RebalanceStatus;
  /** LIVE and UAT rebalance requests are governed independently. */
  environment_scope?: "live" | "uat";
  ic_session_id: string | null;
  research_note_id: string | null;
  executed_at: string | null;
  created_at: string;
  updated_at: string;
  /** IC votes + tally, enriched by /api/rebalance/requests. */
  votes?: RebalanceVote[];
  tally?: VoteTally;
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
