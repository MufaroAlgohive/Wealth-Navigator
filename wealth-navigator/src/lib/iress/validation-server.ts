import "server-only";

import { computeDivergence } from "@/lib/iress/overlay-policy";
import { isAutoValidated, type ValidationSeverity } from "@/lib/iress/validation";
import { callWorker } from "@/lib/iress/worker-api";
import { createInstitutionalServiceRoleClient, createRetailServiceRoleClient } from "@/lib/supabase/server";

/**
 * Run ONE per-symbol IRESS(PROD)-vs-Yahoo comparison sample and persist it to
 * iress_price_validation_c (institutional). Read-only w.r.t. the money tables:
 * it reads securities_c (Yahoo reference) and the worker's read-only coverage
 * probe (live IRESS via the seat), and writes ONLY the institutional scoreboard.
 *
 * Shared by the admin endpoint and the cron so the maths + upsert live once.
 */

const DEFAULT_SYMBOLS = [
  "AGL", "SOL", "NPN", "MTN", "FSR", "SBK", "BTI", "CFR", "PRX", "GLN",
  "SHP", "CPI", "ANG", "IMP", "GFI", "VOD", "REM", "CLS", "BVT", "WHL",
];

interface CoverageRow {
  symbol: string;
  iressCode: string;
  last: number | null;
  outcome: string;
}

interface ScoreRow {
  symbol: string;
  samples_total: number;
  samples_ok: number;
  consecutive_ok: number;
  max_consecutive_ok: number;
  validated: boolean;
  validated_at: string | null;
  first_seen: string;
}

export interface ValidationSampleResult {
  ok: boolean;
  error?: string;
  generatedAt: string;
  sampled: number;
  covered: number;
  withinTolerance: number;
  validatedNow: number;
  rows: Array<{
    symbol: string;
    iressCents: number | null;
    yahooCents: number | null;
    divergencePct: number | null;
    severity: ValidationSeverity;
    consecutive_ok: number;
    validated: boolean;
  }>;
}

function resolveSymbols(input?: string[]): string[] {
  const fromEnv = (process.env.IRESS_VALIDATION_SYMBOLS ?? "")
    .split(",")
    .map((s) => s.trim().toUpperCase().replace(/\.(JO|JSE)$/i, ""))
    .filter(Boolean);
  const base = input && input.length ? input : fromEnv.length ? fromEnv : DEFAULT_SYMBOLS;
  return [...new Set(base.map((s) => s.trim().toUpperCase().replace(/\.(JO|JSE)$/i, "")).filter(Boolean))].slice(
    0,
    120,
  );
}

export async function runValidationSample(inputSymbols?: string[]): Promise<ValidationSampleResult> {
  const generatedAt = new Date().toISOString();
  const bare = resolveSymbols(inputSymbols);
  if (bare.length === 0) {
    return { ok: false, error: "no symbols", generatedAt, sampled: 0, covered: 0, withinTolerance: 0, validatedNow: 0, rows: [] };
  }
  const jo = bare.map((s) => `${s}.JO`);

  // Yahoo reference (cents) from securities_c.
  let retail;
  try {
    retail = createRetailServiceRoleClient();
  } catch (e) {
    return { ok: false, error: `RETAIL DB not configured: ${(e as Error).message}`, generatedAt, sampled: 0, covered: 0, withinTolerance: 0, validatedNow: 0, rows: [] };
  }
  const yahooBy = new Map<string, number>();
  {
    const { data, error } = await retail.from("securities_c").select("symbol,last_price").in("symbol", jo);
    if (error) {
      return { ok: false, error: `securities_c: ${error.message}`, generatedAt, sampled: 0, covered: 0, withinTolerance: 0, validatedNow: 0, rows: [] };
    }
    for (const s of data ?? []) {
      yahooBy.set(String(s.symbol).replace(/\.(JO|JSE)$/i, ""), Number(s.last_price) || 0);
    }
  }

  // Live IRESS via the worker's read-only coverage probe (mapped `last` in rands).
  const cov = await callWorker<{ ok: boolean; rows: CoverageRow[] }>({
    method: "POST",
    path: "/debug/coverage",
    body: { symbols: jo, exchange: "JSE" },
    timeoutMs: 90_000,
  });
  if (!cov.ok) {
    return { ok: false, error: `worker coverage probe failed: ${cov.error ?? "unknown"}`, generatedAt, sampled: 0, covered: 0, withinTolerance: 0, validatedNow: 0, rows: [] };
  }
  const iressBy = new Map<string, number | null>(
    (cov.body.rows ?? []).map((r) => [r.iressCode.replace(/\.(JO|JSE)$/i, ""), r.last]),
  );

  // Institutional scoreboard (existing counters).
  let inst;
  try {
    inst = createInstitutionalServiceRoleClient();
  } catch (e) {
    return { ok: false, error: `INSTITUTIONAL DB not configured: ${(e as Error).message}`, generatedAt, sampled: 0, covered: 0, withinTolerance: 0, validatedNow: 0, rows: [] };
  }
  const prevBy = new Map<string, ScoreRow>();
  {
    const { data } = await inst
      .from("iress_price_validation_c")
      .select("symbol, samples_total, samples_ok, consecutive_ok, max_consecutive_ok, validated, validated_at, first_seen")
      .in("symbol", bare);
    for (const r of (data ?? []) as ScoreRow[]) prevBy.set(r.symbol, r);
  }

  const upserts: Array<Record<string, unknown>> = [];
  const outRows: ValidationSampleResult["rows"] = [];
  let covered = 0;
  let withinTolerance = 0;
  let validatedNow = 0;

  for (const code of bare) {
    const iressRands = iressBy.get(code); // mapped, rands
    const yahooCents = yahooBy.get(code) ?? 0;
    const iressCents = iressRands != null && iressRands > 0 ? Math.round(iressRands * 100) : null;
    const isCovered = iressCents != null;
    const d = iressCents != null ? computeDivergence(iressCents, yahooCents) : null;
    const severity: ValidationSeverity = isCovered ? (d ? d.severity : "ok") : "no-data";
    const inTol = Boolean(isCovered && d && d.withinTolerance && yahooCents > 0);

    const prev = prevBy.get(code);
    const samples_total = (prev?.samples_total ?? 0) + 1;
    const samples_ok = (prev?.samples_ok ?? 0) + (inTol ? 1 : 0);
    const consecutive_ok = inTol ? (prev?.consecutive_ok ?? 0) + 1 : 0;
    const max_consecutive_ok = Math.max(prev?.max_consecutive_ok ?? 0, consecutive_ok);

    const validated = isAutoValidated({ covered: isCovered, last_severity: severity, consecutive_ok });
    const wasValidated = prev?.validated ?? false;
    const validated_at = validated ? (wasValidated ? prev?.validated_at ?? generatedAt : generatedAt) : null;

    if (isCovered) covered += 1;
    if (inTol) withinTolerance += 1;
    if (validated && !wasValidated) validatedNow += 1;

    upserts.push({
      symbol: code,
      last_iress_cents: iressCents,
      last_yahoo_cents: yahooCents > 0 ? yahooCents : null,
      last_divergence_pct: d ? Number(d.pct.toFixed(3)) : null,
      last_severity: severity,
      samples_total,
      samples_ok,
      consecutive_ok,
      max_consecutive_ok,
      covered: isCovered,
      validated,
      validated_at,
      first_seen: prev?.first_seen ?? generatedAt,
      last_checked: generatedAt,
      updated_at: generatedAt,
      // `approved` / approved_by / approved_at are intentionally omitted so a
      // manual approval is never reset by a routine sample (upsert merges).
    });
    outRows.push({
      symbol: code,
      iressCents,
      yahooCents: yahooCents > 0 ? yahooCents : null,
      divergencePct: d ? Number(d.pct.toFixed(2)) : null,
      severity,
      consecutive_ok,
      validated,
    });
  }

  const { error: upErr } = await inst
    .from("iress_price_validation_c")
    .upsert(upserts, { onConflict: "symbol" });
  if (upErr) {
    return { ok: false, error: `iress_price_validation_c upsert: ${upErr.message}`, generatedAt, sampled: bare.length, covered, withinTolerance, validatedNow, rows: outRows };
  }

  return { ok: true, generatedAt, sampled: bare.length, covered, withinTolerance, validatedNow, rows: outRows };
}
