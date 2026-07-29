import type { CanvasContextPayload } from "./types";

const EVIDENCE_TYPES = ["chart", "fundamentals", "technicals", "thesis", "news", "notes"] as const;

function evidenceSnapshot(context: CanvasContextPayload) {
  const byType: Record<string, string[]> = {};
  for (const n of context.nodes) {
    if (n.type === "engine") continue; // structural hubs — not market evidence
    const bucket = byType[n.type] ?? (byType[n.type] = []);
    bucket.push(`[${n.title}]\n${n.contentText}`.trim());
  }
  return {
    byType,
    notesText: context.notesText?.trim() || "",
    presentTypes: EVIDENCE_TYPES.filter(
      (t) => (byType[t]?.length ?? 0) > 0 || (t === "notes" && Boolean(context.notesText?.trim())),
    ),
    missingTypes: EVIDENCE_TYPES.filter(
      (t) => (byType[t]?.length ?? 0) === 0 && !(t === "notes" && context.notesText?.trim()),
    ),
  };
}

export function buildChatsightAskPrompt({
  symbol,
  question,
  context,
}: {
  symbol: string;
  question: string;
  context: CanvasContextPayload;
}): { system: string; prompt: string } {
  const snap = evidenceSnapshot(context);
  const evidenceNodes = context.nodes
    .filter((n) => n.type !== "engine")
    .map((n) => ({
      id: n.id,
      type: n.type,
      title: n.title,
      contentText: n.contentText,
    }));

  const ctx = {
    symbol,
    nodes: evidenceNodes,
    edges: context.edges,
    notesText: context.notesText,
    evidencePresent: snap.presentTypes,
    evidenceMissingOrEmpty: snap.missingTypes,
  };

  const system =
    "You are a Fynca-style research assistant embedded in a Wealth Navigator canvas. " +
    "Answer using ONLY the provided canvas evidence (chart, fundamentals, technicals, thesis, news, notes). " +
    "Do not invent prices, metrics, events, headlines, or fundamentals that are not in the context. " +
    "If a section is missing, still loading, or marked unavailable/empty, say so explicitly — never fabricate. " +
    "COMPLIANCE: Never give a buy, sell, hold, or allocation recommendation. " +
    "If the user asks whether to buy/sell, refuse the recommendation and instead deliver a complete " +
    "canvas-grounded evidence summary of what is on the board (and what is missing). " +
    "Return ONLY a single STRICT JSON object — no prose, no markdown fences outside the JSON string value.";

  const prompt = [
    `Canvas symbol: ${symbol}`,
    `User question: ${question}`,
    "",
    "=== CANVAS EVIDENCE (JSON) ===",
    JSON.stringify(ctx),
    "",
    "=== TASK ===",
    "Write a COMPLETE answer grounded on the board. Inside the answer string, cover these sections in order when relevant:",
    "1) Price / chart — last close, range change, source if stated",
    "2) Fundamentals — key metrics present (or state missing)",
    "3) Technicals — RSI / momentum if present (or state missing)",
    "4) Thesis — outlook calls/risks if present (or state deferred/missing)",
    "5) News — headlines if present (or state empty)",
    "6) Notes — analyst notes if present",
    "7) Gaps — list any evidence types that are empty, loading, or unavailable",
    "",
    "For buy/sell questions: open with a one-line compliance refusal (not advice), then run sections 1–7 fully.",
    "Keep the answer substantive (typically 8–18 short lines or tight bullets). Do not stop after a single sentence refusal.",
    "",
    "Return ONLY this JSON schema:",
    JSON.stringify(
      {
        answer:
          "string — full multi-section answer (use newlines / concise bullets inside the string)",
      },
      null,
      2,
    ),
    "",
    "Output ONLY the JSON object.",
  ].join("\n");

  return { system, prompt };
}

export function buildChatsightBuildPrompt({
  symbol,
  instruction,
  context,
}: {
  symbol: string;
  instruction: string;
  context: CanvasContextPayload;
}): { system: string; prompt: string } {
  const ctx = {
    symbol,
    nodes: context.nodes.map((n) => ({
      id: n.id,
      type: n.type,
      title: n.title,
      contentText: n.contentText,
    })),
    edges: context.edges,
    notesText: context.notesText,
  };

  const system =
    "You are a Fynca-style AI that edits a research canvas by proposing wiring changes. " +
    "You MUST output STRICT JSON that describes a proposal. " +
    "Use ONLY the node ids provided for any operations referencing existing nodes. " +
    "If you propose adding a node, you MUST choose an id that matches: /^node_[a-z]+_\\d+$/ " +
    "and keep it unique within the current graph. " +
    "If you cannot safely propose changes, return an operation list that is empty. " +
    "Return ONLY a single STRICT JSON object — no prose, no markdown, no code fences.";

  const prompt = [
    `Canvas symbol: ${symbol}`,
    `User change request: ${instruction}`,
    "",
    "=== CANVAS CONTEXT (JSON) ===",
    JSON.stringify(ctx),
    "",
    "=== TASK ===",
    "Propose a set of wiring edits to satisfy the request. " +
      "Wiring edits MUST be expressed as operations using this schema:",
    JSON.stringify(
      {
        summary: "string — short explanation of what and why",
        operations: [
          {
            type: "add_edge",
            from: "existing node id",
            to: "existing node id",
          },
          {
            type: "remove_edge",
            from: "existing node id",
            to: "existing node id",
          },
          {
            type: "update_node",
            id: "existing node id",
            patch: {
              title: "optional string",
              contentText: "optional string",
            },
          },
          {
            type: "add_node",
            node: {
              id: "node_<type>_<n> (unique, deterministic)",
              type: "chart | fundamentals | thesis | notes | technicals | news | engine",
              title: "string",
              contentText: "string",
              position: { x: "number", y: "number" },
            },
          },
        ],
      },
      null,
      2,
    ),
    "",
    "Output ONLY the JSON object.",
  ].join("\n");

  return { system, prompt };
}
