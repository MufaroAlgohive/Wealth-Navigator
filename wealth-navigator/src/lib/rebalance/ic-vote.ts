/**
 * IC vote arithmetic for rebalance proposals.
 *
 * A rebalance proposal is promoted from `pending` → `ic_approved` (and thus
 * becomes eligible for release to the order book) once the committee's YES
 * votes reach a simple majority of the standing roster. Charter:
 *   - Committee size: 3 (Lonwabo, Juan, Lethabo — chair + 2 voting)
 *   - Threshold: strict majority (≥ 2 of 3). Abstentions do NOT lower the bar
 *     — a 2-yes / 1-abstain still passes.
 *
 * Both the vote route (server, authoritative) and the requests list route
 * (which enriches each row with its tally) import this so the maths lives in
 * exactly one place. The UI only ever renders a tally the server computed.
 *
 * The constants below stay env-tunable so a future 4- or 5-member expansion
 * just sets `IC_QUORUM` (the threshold auto-derives as floor(N/2)+1, which is
 * the strict-majority formula).
 */

import {
  IC_COMMITTEE_SIZE,
  IC_MAJORITY_REQUIRED_YES,
  IC_MAJORITY_THRESHOLD,
} from "@/lib/research-ic/committee";

export type VoteValue = "yes" | "no" | "abstain";

export interface RebalanceVote {
  voter_email: string;
  vote: VoteValue;
  rationale?: string | null;
  voted_at?: string;
}

export interface VoteTally {
  yes: number;
  no: number;
  abstain: number;
  /** Committee size the threshold is measured against. */
  quorum: number;
  /** Approval fraction, e.g. 0.667 for majority of 3. */
  threshold: number;
  /** Minimum YES votes needed to pass (derived from quorum × threshold). */
  requiredYes: number;
  /** yes / quorum, clamped to [0, 1] for the progress bar. */
  ratio: number;
  /** True once YES votes reach `requiredYes`. */
  passed: boolean;
}

/** Committee size (env-tunable; charter default is 3). */
export const IC_QUORUM = Math.max(1, Number(process.env.IC_QUORUM ?? "") || IC_COMMITTEE_SIZE);

/**
 * Approval fraction. Charter default is strict majority (floor(N/2)+1 over N).
 * For N=3 this is 2/3 = 0.667. Env-overridable for emergency tightening.
 */
export const IC_APPROVE_THRESHOLD = (() => {
  const n = Number(process.env.IC_APPROVE_THRESHOLD ?? "");
  if (Number.isFinite(n) && n > 0 && n <= 1) return n;
  // Auto-derive strict-majority threshold from current committee size.
  return IC_MAJORITY_THRESHOLD;
})();

/** Minimum YES votes to pass: floor(N/2)+1 (strict majority). */
export function requiredYesVotes(
  quorum: number = IC_QUORUM,
  _threshold: number = IC_APPROVE_THRESHOLD,
): number {
  return Math.max(1, Math.floor(quorum / 2) + 1);
}

/** Count votes and decide whether the proposal has passed the IC gate. */
export function tallyVotes(
  votes: readonly RebalanceVote[],
  quorum: number = IC_QUORUM,
  threshold: number = IC_APPROVE_THRESHOLD,
): VoteTally {
  let yes = 0;
  let no = 0;
  let abstain = 0;
  for (const v of votes) {
    if (v.vote === "yes") yes += 1;
    else if (v.vote === "no") no += 1;
    else abstain += 1;
  }
  const requiredYes = requiredYesVotes(quorum, threshold);
  const ratio = quorum > 0 ? Math.min(1, yes / quorum) : 0;
  return { yes, no, abstain, quorum, threshold, requiredYes, ratio, passed: yes >= requiredYes };
}

/**
 * Re-export the committee size for callers that don't want to import from the
 * committee module directly (keeps existing imports of `IC_QUORUM` working).
 */
export { IC_COMMITTEE_SIZE, IC_MAJORITY_REQUIRED_YES, IC_MAJORITY_THRESHOLD };
