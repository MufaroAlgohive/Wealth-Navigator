import { describe, expect, it } from "bun:test";

import {
  agendaKindForNote,
  agendaKindForRebalance,
  icResearchApproveLabel,
  icRebalanceActionLabel,
  linkedRebalanceForNote,
} from "@/components/research-ic/ic-agenda";
import type { RebalanceRequest, ResearchNote } from "@/components/research-ic/types";

const note = (id: string, symbol: string): ResearchNote =>
  ({
    id,
    symbol,
    status: "ic_pending",
    thesis: {},
    author_email: "a@test.com",
    created_at: "",
    updated_at: "",
  }) as ResearchNote;

const req = (id: string, research_note_id: string | null, ticker?: string): RebalanceRequest =>
  ({
    id,
    research_note_id,
    strategy_id: "MINT SA Equity Alpha",
    status: "pending",
    proposed_composition: ticker
      ? [{ ticker, action: "buy", name: ticker, fromWeight: 0, toWeight: 5 }]
      : [],
  }) as RebalanceRequest;

describe("ic-agenda", () => {
  it("labels research-only approval", () => {
    expect(icResearchApproveLabel("research")).toBe("Approve Research");
  });

  it("labels combined approval", () => {
    expect(icResearchApproveLabel("both")).toBe("Approve Research & Rebalance");
    expect(icRebalanceActionLabel("both")).toBe("Approve Research & Rebalance");
  });

  it("links note to rebalance by research_note_id", () => {
    const n = note("n1", "NED");
    const linked = linkedRebalanceForNote(n, [req("r1", "n1")]);
    expect(linked?.id).toBe("r1");
    expect(agendaKindForNote(n, [req("r1", "n1")])).toBe("both");
  });

  it("links note to rebalance by symbol in composition", () => {
    const n = note("n2", "SOL");
    expect(agendaKindForNote(n, [req("r2", null, "SOL")])).toBe("both");
  });

  it("treats standalone rebalance as review-only", () => {
    expect(agendaKindForRebalance(req("r3", null), [])).toBe("rebalance");
    expect(icRebalanceActionLabel("rebalance")).toBe("Review Rebalance");
  });
});
