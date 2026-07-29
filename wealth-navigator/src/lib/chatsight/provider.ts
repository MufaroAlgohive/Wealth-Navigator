import type { ChatsightAskRequest, ChatsightAskResponse, ChatsightBuildRequest, ChatsightBuildResponse, CanvasBuildOperation, CanvasBuildProposal } from "./types";
import type { CanvasContextPayload } from "./types";

import { callModel, getResearchAiConfig, isResearchAiConfigured } from "@/lib/research-ai/provider";

import { extractFirstJsonObject } from "./json";
import { buildChatsightAskPrompt, buildChatsightBuildPrompt } from "./prompts";

function asString(v: unknown): string | null {
  return typeof v === "string" && v.trim().length ? v.trim() : null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function coerceOperation(raw: unknown): CanvasBuildOperation | null {
  if (!isRecord(raw)) return null;
  const type = asString(raw.type);

  if (type === "add_edge") {
    const from = asString(raw.from);
    const to = asString(raw.to);
    if (!from || !to) return null;
    return { type, from, to };
  }

  if (type === "remove_edge") {
    const from = asString(raw.from);
    const to = asString(raw.to);
    if (!from || !to) return null;
    return { type, from, to };
  }

  if (type === "update_node") {
    const id = asString(raw.id);
    if (!id) return null;
    const patch = raw.patch;
    if (!isRecord(patch)) return null;
    const title = patch.title;
    const contentText = patch.contentText;
    const patchCoerced: { title?: string; contentText?: string } = {};
    const t = asString(title);
    const c = asString(contentText);
    if (t) patchCoerced.title = t;
    if (c) patchCoerced.contentText = c;
    return { type, id, patch: patchCoerced };
  }

  if (type === "add_node") {
    const node = raw.node;
    if (!isRecord(node)) return null;
    const id = asString(node.id);
    const ntype = asString(node.type);
    const title = asString(node.title);
    const contentText = asString(node.contentText);
    if (!id || !ntype || !title || !contentText) return null;

    // We only accept our known node types (defensive filtering).
    if (!["chart", "fundamentals", "thesis", "notes", "technicals", "news", "engine"].includes(ntype)) {
      return null;
    }

    const positionRaw = node.position;
    let position: { x: number; y: number } | undefined;
    if (isRecord(positionRaw)) {
      const x = Number(positionRaw.x);
      const y = Number(positionRaw.y);
      if (Number.isFinite(x) && Number.isFinite(y)) position = { x, y };
    }

    return {
      type,
      node: {
        id,
        type: ntype as CanvasContextPayload["nodes"][number]["type"],
        title,
        contentText,
        position,
      },
    };
  }

  return null;
}

function parseAsk(text: string): { answer: string } | null {
  const parsed = extractFirstJsonObject(text);
  if (!parsed || !isRecord(parsed)) return null;
  const answer = asString(parsed.answer);
  if (!answer) return null;
  return { answer };
}

function parseBuild(text: string): CanvasBuildProposal | null {
  const parsed = extractFirstJsonObject(text);
  if (!parsed || !isRecord(parsed)) return null;

  const summary = asString(parsed.summary);
  if (!summary) return null;

  const ops = Array.isArray(parsed.operations) ? parsed.operations : [];
  const operations: CanvasBuildOperation[] = [];
  for (const rawOp of ops) {
    const op = coerceOperation(rawOp);
    if (op) operations.push(op);
  }

  return { summary, operations };
}

export async function chatsightAsk(req: ChatsightAskRequest): Promise<ChatsightAskResponse> {
  if (!isResearchAiConfigured()) {
    return { ok: true, configured: false, error: "AI provider not configured" };
  }

  const cfg = getResearchAiConfig();
  if (!cfg.apiKey) return { ok: true, configured: false, error: "AI provider not configured" };

  const { system, prompt } = buildChatsightAskPrompt({
    symbol: req.symbol,
    question: req.question,
    context: req.context,
  });

  try {
    const text = await callModel({
      base: cfg.base,
      apiKey: cfg.apiKey,
      authStyle: cfg.authStyle,
      model: cfg.model,
      system,
      prompt,
      maxTokens: 4096,
    });

    const parsed = parseAsk(text);
    if (!parsed) return { ok: false, configured: true, provider: cfg.provider, model: cfg.model, error: "Unparseable model output" };

    return { ok: true, configured: true, provider: cfg.provider, model: cfg.model, answer: parsed.answer };
  } catch (e) {
    return {
      ok: false,
      configured: true,
      provider: cfg.provider,
      model: cfg.model,
      error: e instanceof Error ? e.message : "Chatsight ask failed",
    };
  }
}

export async function chatsightBuild(req: ChatsightBuildRequest): Promise<ChatsightBuildResponse> {
  if (!isResearchAiConfigured()) {
    return { ok: true, configured: false, error: "AI provider not configured" };
  }

  const cfg = getResearchAiConfig();
  if (!cfg.apiKey) return { ok: true, configured: false, error: "AI provider not configured" };

  const { system, prompt } = buildChatsightBuildPrompt({
    symbol: req.symbol,
    instruction: req.instruction,
    context: req.context,
  });

  try {
    const text = await callModel({
      base: cfg.base,
      apiKey: cfg.apiKey,
      authStyle: cfg.authStyle,
      model: cfg.model,
      system,
      prompt,
    });

    const proposal = parseBuild(text);
    if (!proposal) return { ok: false, configured: true, provider: cfg.provider, model: cfg.model, error: "Unparseable model output" };

    return { ok: true, configured: true, provider: cfg.provider, model: cfg.model, proposal };
  } catch (e) {
    return {
      ok: false,
      configured: true,
      provider: cfg.provider,
      model: cfg.model,
      error: e instanceof Error ? e.message : "Chatsight build failed",
    };
  }
}

