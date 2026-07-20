import type { ProposedHolding, RebalanceRequest, ResearchNote } from "./types";

export type IcAgendaKind = "research" | "rebalance" | "both";

/** Primary IC action label for a research-note agenda row. */
export function icResearchApproveLabel(kind: IcAgendaKind): string {
  if (kind === "both") return "Approve Research & Rebalance";
  if (kind === "rebalance") return "Review Rebalance";
  return "Approve Research";
}

/** Primary IC action label for a rebalance agenda row. */
export function icRebalanceActionLabel(kind: IcAgendaKind): string {
  if (kind === "both") return "Approve Research & Rebalance";
  return "Review Rebalance";
}

export function linkedRebalanceForNote(
  note: ResearchNote,
  pendingReqs: RebalanceRequest[],
): RebalanceRequest | undefined {
  const byId = pendingReqs.find((r) => r.research_note_id === note.id);
  if (byId) return byId;

  const sym = note.symbol.toUpperCase();
  return pendingReqs.find((r) => compositionTouchesSymbol(r.proposed_composition, sym));
}

export function linkedNoteForRebalance(
  req: RebalanceRequest,
  agendaNotes: ResearchNote[],
): ResearchNote | undefined {
  if (req.research_note_id) {
    const byId = agendaNotes.find((n) => n.id === req.research_note_id);
    if (byId) return byId;
  }

  const tickers = compositionTickers(req.proposed_composition);
  return agendaNotes.find((n) => tickers.has(n.symbol.toUpperCase()));
}

export function agendaKindForNote(note: ResearchNote, pendingReqs: RebalanceRequest[]): IcAgendaKind {
  return linkedRebalanceForNote(note, pendingReqs) ? "both" : "research";
}

export function agendaKindForRebalance(req: RebalanceRequest, agendaNotes: ResearchNote[]): IcAgendaKind {
  return linkedNoteForRebalance(req, agendaNotes) ? "both" : "rebalance";
}

function compositionTickers(rows: ProposedHolding[] | null | undefined): Set<string> {
  const out = new Set<string>();
  if (!Array.isArray(rows)) return out;
  for (const row of rows) {
    if (row.ticker) out.add(row.ticker.toUpperCase());
  }
  return out;
}

function compositionTouchesSymbol(rows: ProposedHolding[] | null | undefined, sym: string): boolean {
  if (!Array.isArray(rows)) return false;
  return rows.some(
    (r) =>
      r.ticker?.toUpperCase() === sym &&
      r.action != null &&
      r.action !== "hold",
  );
}
