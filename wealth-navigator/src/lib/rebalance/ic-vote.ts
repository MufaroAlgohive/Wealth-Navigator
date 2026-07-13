/**
 * IC vote arithmetic for rebalance proposals.
 *
 * A rebalance proposal is promoted from `pending` → `ic_approved` (and thus
 * becomes eligible for release to the order book) once the committee's YES
 * votes cross the approval threshold. This mirrors the committee charter:
 * quorum is 3 members and a proposal needs ≥ 60% to pass — i.e. 2 of 3 YES.
 *
 * Both the vote route (server, authoritative) and the requests list route
 * (which enriches each row with its tally) import this so the maths lives in
 * exactly one place. The UI only ever renders a tally the server computed.
 */

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
  /** Approval fraction, e.g. 0.6. */
  threshold: number;
  /** Minimum YES votes needed to pass (derived from quorum × threshold). */
  requiredYes: number;
  /** yes / quorum, clamped to [0, 1] for the progress bar. */
  ratio: number;
  /** True once YES votes reach `requiredYes`. */
  passed: boolean;
}

/** Committee size (env-tunable; charter default is 3). */
export const IC_QUORUM = Math.max(1, Number(process.env.IC_QUORUM ?? "") || 3);
/** Approval fraction (env-tunable; charter default is 60%). */
export const IC_APPROVE_THRESHOLD = (() => {
  const n = Number(process.env.IC_APPROVE_THRESHOLD ?? "");
  return n > 0 && n <= 1 ? n : 0.6;
})();

/** Minimum YES votes to pass: ceil(quorum × threshold), at least 1. */
export function requiredYesVotes(
  quorum: number = IC_QUORUM,
  threshold: number = IC_APPROVE_THRESHOLD,
): number {
  return Math.max(1, Math.ceil(quorum * threshold));
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
