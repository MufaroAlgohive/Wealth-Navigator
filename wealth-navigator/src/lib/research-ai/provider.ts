/**
 * Provider-agnostic AI equity-research synthesis.
 *
 * MiniMax-M3 and Anthropic both speak the Anthropic Messages API, so ONE
 * adapter (`callModel`) serves both — the only differences are the base URL,
 * the auth header style, and the default model. Provider is selected from env
 * (`RESEARCH_AI_PROVIDER`), defaulting to MiniMax.
 *
 * The model is told to return STRICT JSON matching the outlook schema; we parse
 * defensively (strip code fences, isolate the first {...}) and never rely on
 * provider-specific structured-output or web-tool features.
 *
 * No fabricated data: the prompt instructs the model to reason ONLY over the
 * supplied fundamentals + news evidence and to hedge when evidence is thin.
 */

import type {
  AiResearchResponse,
  Call,
  Confidence,
  GatheredEvidence,
  OutlookHorizon,
  ResearchAiProvider,
  ResearchOutlook,
  WebResult,
} from "@/lib/research-ai/types";

// Re-export the shared contract so the frontend can import it from the provider lib.
export type {
  AiResearchResponse,
  CacheStatus,
  Call,
  Confidence,
  GatheredEvidence,
  OutlookHorizon,
  ResearchAiProvider,
  ResearchOutlook,
  ResearchSignal,
  ResearchSource,
  ResearchStep,
  ResearchStepStatus,
  WebResearchOutcome,
  WebResult,
  WebSearchStatus,
} from "@/lib/research-ai/types";

export const RESEARCH_DISCLAIMER =
  "AI-generated research for internal use only — not financial advice. Must be reviewed and signed off by the investment committee before any client-facing use or action.";

export type AuthStyle = "bearer" | "x-api-key";

export interface ResearchAiConfig {
  provider: ResearchAiProvider;
  base: string;
  apiKey: string | null;
  authStyle: AuthStyle;
  model: string;
}

interface ProviderConfig {
  provider: ResearchAiProvider;
  base: string;
  apiKey: string | null;
  authStyle: AuthStyle;
  model: string;
}

/** Resolve the active provider config from env (does not require a key). */
function resolveProviderConfig(): ProviderConfig {
  const selected = (process.env.RESEARCH_AI_PROVIDER ?? "minimax").trim().toLowerCase();
  const provider: ResearchAiProvider = selected === "claude" ? "claude" : "minimax";

  if (provider === "claude") {
    return {
      provider,
      base: (process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com").replace(/\/+$/, ""),
      apiKey: process.env.ANTHROPIC_API_KEY ?? null,
      authStyle: "x-api-key",
      model: process.env.RESEARCH_AI_CLAUDE_MODEL ?? "claude-sonnet-4-6",
    };
  }

  return {
    provider,
    base: (process.env.MINIMAX_BASE_URL ?? "https://api.minimax.io/anthropic").replace(/\/+$/, ""),
    apiKey: process.env.MINIMAX_API_KEY ?? null,
    authStyle: "bearer",
    model: process.env.MINIMAX_MODEL ?? "MiniMax-M3",
  };
}

/** True when the selected provider has an API key in env. */
export function isResearchAiConfigured(): boolean {
  return Boolean(resolveProviderConfig().apiKey);
}

/**
 * Active provider + base URL + api key for server-side model calls.
 *
 * Note: this may return `apiKey: null` when the provider is not configured.
 * Callers should guard with `isResearchAiConfigured()`.
 */
export function getResearchAiConfig(): ResearchAiConfig {
  return resolveProviderConfig();
}

/** Active provider + model labels (for the response, even when deferred). */
export function getResearchAiProvider(): { provider: ResearchAiProvider; model: string } {
  const cfg = resolveProviderConfig();
  return { provider: cfg.provider, model: cfg.model };
}

interface CallModelArgs {
  base: string;
  apiKey: string;
  authStyle: AuthStyle;
  model: string;
  system: string;
  prompt: string;
  /** Override default 2048 when the task needs a longer structured answer. */
  maxTokens?: number;
}

/** Anthropic Messages content-block shape we care about (text blocks). */
interface MessagesResponse {
  content?: Array<{ type?: string; text?: string }>;
}

/**
 * POST to `${base}/v1/messages` with an Anthropic Messages body and return the
 * concatenated assistant text. Throws on non-2xx or empty body.
 */
export async function callModel({
  base,
  apiKey,
  authStyle,
  model,
  system,
  prompt,
  maxTokens = 2048,
}: CallModelArgs): Promise<string> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (authStyle === "bearer") {
    headers.Authorization = `Bearer ${apiKey}`;
  } else {
    headers["x-api-key"] = apiKey;
    headers["anthropic-version"] = "2023-06-01";
  }

  const res = await fetch(`${base}/v1/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: prompt }],
    }),
    cache: "no-store",
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`provider responded ${res.status}: ${detail.slice(0, 300)}`);
  }

  const json = (await res.json()) as MessagesResponse;
  const text = (json.content ?? [])
    .filter((b) => b && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("")
    .trim();

  if (!text) throw new Error("provider returned no assistant text");
  return text;
}

/**
 * Build the analyst prompt. Instructs the model to reason ONLY over the
 * supplied evidence, hedge when thin, and return STRICT JSON matching the
 * outlook schema.
 */
export function buildPrompt(
  symbol: string,
  name: string | null,
  gathered: GatheredEvidence,
  extra: {
    webResults?: WebResult[];
    financials?: Record<string, unknown> | null;
    news?: Array<{ title: string; publishedAt?: string | null }>;
  } = {},
): { system: string; prompt: string } {
  const webResults = extra.webResults ?? [];
  const financials = extra.financials ?? null;
  const news = extra.news ?? [];
  const system =
    "You are a calibrated, conservative equity analyst writing internal research. " +
    "Reason ONLY over the evidence provided in the user message — fundamentals, price, and the " +
    "WEB RESEARCH snippets — and never invent data, prices, earnings, or events that are not present. " +
    "Prefer recent web findings for current developments, but treat snippets as soft signal and do " +
    "not over-read them. When evidence is thin or absent, say so and lower your confidence; prefer a " +
    "'neutral' call over a fabricated conviction. Return ONLY a single JSON object — no prose, no markdown, no code fences.";

  const fundamentalsText = gathered.fundamentals
    ? JSON.stringify(gathered.fundamentals, null, 2)
    : "No fundamentals available.";
  const priceText = gathered.priceSummary
    ? `last=${gathered.priceSummary.last ?? "n/a"}, dayChangePct=${gathered.priceSummary.changePct ?? "n/a"}`
    : "No price summary available.";
  const webText = webResults.length
    ? webResults
        .map((r, i) => `[${i + 1}] ${r.title}\n${r.snippet}\nsource: ${r.url}`)
        .join("\n\n")
    : "No web research available.";
  const financialsText =
    financials && Object.keys(financials).length
      ? JSON.stringify(financials, null, 2)
      : "No financial statements available.";
  const newsText = news.length
    ? news.map((n, i) => `[${i + 1}] ${n.title}${n.publishedAt ? ` (${n.publishedAt.slice(0, 10)})` : ""}`).join("\n")
    : "No recent company news retrieved.";

  const prompt = [
    `Subject security: ${symbol}${name ? ` (${name})` : ""}.`,
    "",
    "=== FUNDAMENTALS (real, from internal securities table; may be partial) ===",
    fundamentalsText,
    "",
    "=== FINANCIAL STATEMENTS & RATIOS (real, from Yahoo; may be partial) ===",
    financialsText,
    "",
    "=== PRICE SUMMARY (real) ===",
    priceText,
    "",
    "=== RECENT COMPANY NEWS (headlines; soft signal — don't over-read) ===",
    newsText,
    "",
    "=== WEB RESEARCH (recent, online; may be noisy — weigh credibility) ===",
    webText,
    "",
    "=== TASK ===",
    "Produce a calibrated outlook. Return STRICT JSON exactly matching this schema (no extra keys):",
    JSON.stringify(
      {
        summary: "string — 2-3 sentence balanced overview grounded in the evidence",
        shortTerm: {
          horizon: "0–3 months",
          call: "bullish | neutral | bearish",
          confidence: "low | medium | high",
          rationale: "string grounded in the evidence",
        },
        mediumTerm: {
          horizon: "3–12 months",
          call: "bullish | neutral | bearish",
          confidence: "low | medium | high",
          rationale: "string grounded in the evidence",
        },
        longTerm: {
          horizon: "1–3 years",
          call: "bullish | neutral | bearish",
          confidence: "low | medium | high",
          rationale: "string grounded in the evidence",
        },
        risks: ["string", "string"],
      },
      null,
      2,
    ),
    "",
    "Keep horizons EXACTLY: shortTerm '0–3 months', mediumTerm '3–12 months', longTerm '1–3 years'.",
    "Output ONLY the JSON object.",
  ].join("\n");

  return { system, prompt };
}

/**
 * Defensively extract a JSON object from model text: strip ```json fences,
 * then isolate the first balanced {...} span. Returns the parsed value or null.
 */
function extractJsonObject(text: string): unknown {
  let s = text.trim();
  // Strip a leading/trailing markdown code fence if present.
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence && typeof fence[1] === "string") s = fence[1].trim();

  const start = s.indexOf("{");
  if (start === -1) return null;

  // Walk to the matching close brace (string-aware).
  let depth = 0;
  let inStr = false;
  let escaped = false;
  for (let i = start; i < s.length; i += 1) {
    const ch = s[i];
    if (inStr) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        const candidate = s.slice(start, i + 1);
        try {
          return JSON.parse(candidate);
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

/** First present, non-null value among candidate keys (tolerates key drift). */
function pick(o: Record<string, unknown>, keys: string[]): unknown {
  for (const k of keys) {
    if (o[k] !== undefined && o[k] !== null) return o[k];
  }
  return undefined;
}

/**
 * Coerce a free-text directional call to the enum. The model is told to use
 * exactly bullish|neutral|bearish, but occasionally drifts ("cautiously
 * bearish", "slightly positive"); we map those rather than reject the whole
 * answer. Anything ambiguous defaults to "neutral" — the conservative choice.
 */
function coerceCall(raw: unknown): Call {
  const s = (asString(raw) ?? "").toLowerCase();
  if (/bull|positive|overweight|\bbuy\b|upside|constructive/.test(s)) return "bullish";
  if (/bear|negative|underweight|\bsell\b|downside|cautious/.test(s)) return "bearish";
  return "neutral";
}

/** Coerce a free-text confidence to the enum (defaults to "medium"). */
function coerceConfidence(raw: unknown): Confidence {
  const s = (asString(raw) ?? "").toLowerCase();
  if (/high|strong/.test(s)) return "high";
  if (/low|weak|limited/.test(s)) return "low";
  return "medium";
}

function coerceHorizon(raw: unknown, fallbackHorizon: string): OutlookHorizon | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  // Only genuinely unusable if there is no rationale at all.
  const rationale = asString(pick(o, ["rationale", "reason", "thesis", "commentary", "summary"]));
  if (!rationale) return null;
  return {
    horizon: asString(o.horizon) ?? fallbackHorizon,
    call: coerceCall(o.call),
    confidence: coerceConfidence(o.confidence),
    rationale,
  };
}

/** Pull a risk string from a string or an object like {risk|text|description}. */
function asRisk(r: unknown): string | null {
  const s = asString(r);
  if (s) return s;
  if (r && typeof r === "object") {
    const ro = r as Record<string, unknown>;
    return asString(ro.risk) ?? asString(ro.text) ?? asString(ro.description) ?? null;
  }
  return null;
}

/**
 * Validate + coerce parsed model JSON into a ResearchOutlook, or null. Tolerant
 * of the small shape/enum drifts a model occasionally produces (key casing,
 * a wrapper object, phrasings like "cautiously bearish") so a single brittle
 * mismatch does not waste a whole generation — while still returning null when
 * the answer is genuinely unusable (so the route can retry / report honestly).
 */
export function parseOutlook(text: string): ResearchOutlook | null {
  const parsed = extractJsonObject(text);
  if (!parsed || typeof parsed !== "object") return null;
  let o = parsed as Record<string, unknown>;

  // Unwrap a top-level wrapper if the model nested the outlook one level deep.
  if (
    o.summary === undefined &&
    pick(o, ["shortTerm", "short_term", "short"]) === undefined
  ) {
    for (const w of ["outlook", "research", "result", "analysis", "data"]) {
      const inner = o[w];
      if (inner && typeof inner === "object" && !Array.isArray(inner)) {
        o = inner as Record<string, unknown>;
        break;
      }
    }
  }

  const summary = asString(pick(o, ["summary", "overview", "thesis"]));
  const shortTerm = coerceHorizon(pick(o, ["shortTerm", "short_term", "short", "shortterm"]), "0–3 months");
  const mediumTerm = coerceHorizon(
    pick(o, ["mediumTerm", "medium_term", "medium", "midTerm", "mid", "mediumterm"]),
    "3–12 months",
  );
  const longTerm = coerceHorizon(pick(o, ["longTerm", "long_term", "long", "longterm"]), "1–3 years");
  if (!summary || !shortTerm || !mediumTerm || !longTerm) return null;

  const risksRaw = pick(o, ["risks", "keyRisks", "key_risks", "risk"]);
  const risks = Array.isArray(risksRaw)
    ? risksRaw.map(asRisk).filter((r): r is string => r !== null)
    : [];

  return { summary, shortTerm, mediumTerm, longTerm, risks };
}

/**
 * Ground-then-synthesize: build the prompt from gathered evidence, call the
 * active provider, and parse a validated outlook. Throws on config/network/
 * parse failure so the route can map it to an honest error response.
 */
export async function synthesizeOutlook(
  symbol: string,
  name: string | null,
  gathered: GatheredEvidence,
  extra: {
    webResults?: WebResult[];
    financials?: Record<string, unknown> | null;
    news?: Array<{ title: string; publishedAt?: string | null }>;
  } = {},
): Promise<{ outlook: ResearchOutlook; provider: ResearchAiProvider; model: string }> {
  const cfg = resolveProviderConfig();
  if (!cfg.apiKey) {
    throw new Error(
      cfg.provider === "claude"
        ? "ANTHROPIC_API_KEY is not set"
        : "MINIMAX_API_KEY is not set",
    );
  }

  const apiKey = cfg.apiKey; // narrowed to string by the guard above
  const { system, prompt } = buildPrompt(symbol, name, gathered, extra);
  const call = (p: string) =>
    callModel({
      base: cfg.base,
      apiKey,
      authStyle: cfg.authStyle,
      model: cfg.model,
      system,
      prompt: p,
    });

  let text = await call(prompt);
  let outlook = parseOutlook(text);

  if (!outlook) {
    // One strict retry — most parse misses are a transient schema/enum drift,
    // and a single re-ask with an explicit reminder recovers nearly all of them.
    const strictPrompt =
      prompt +
      "\n\nIMPORTANT: your previous output could not be parsed. Output ONLY one JSON object — " +
      "no prose, no markdown, no code fences. Use EXACTLY these keys: summary, shortTerm, " +
      'mediumTerm, longTerm, risks. For every horizon, "call" must be exactly one of ' +
      '"bullish" | "neutral" | "bearish" and "confidence" exactly one of "low" | "medium" | "high".';
    text = await call(strictPrompt);
    outlook = parseOutlook(text);
  }

  if (!outlook) {
    throw new Error("model did not return a parseable outlook JSON object");
  }

  return { outlook, provider: cfg.provider, model: cfg.model };
}
