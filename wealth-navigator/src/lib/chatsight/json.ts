/**
 * Defensive JSON extraction for LLM outputs.
 *
 * Strategy:
 * - Strip fenced code blocks (```json ... ``` / ``` ... ```).
 * - Locate the first balanced `{ ... }` object and parse it.
 * - Never trust provider-specific structured outputs.
 */

export function extractFirstJsonObject(text: string): unknown | null {
  if (!text) return null;

  let s = text.trim();

  // Strip fenced blocks if present; prefer the first block.
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence && typeof fence[1] === "string") s = fence[1].trim();

  const start = s.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inStr = false;
  let escaped = false;

  for (let i = start; i < s.length; i += 1) {
    const ch = s[i]!;
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

