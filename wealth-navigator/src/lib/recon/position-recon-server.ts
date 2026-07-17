import "server-only";

import { createInstitutionalServiceRoleClient } from "@/lib/supabase/server";

/**
 * Book-level position reconciliation.
 *
 * Compares OUR source of truth (oems_position_c — net of IOS+ fills, see
 * workers/iress-ingest/src/orders.ts::derivePositions) against external position
 * sources staged in position_recon_external_c (iress_portfolio / longmark_statement),
 * per (as_of_date, account_code, security_code, source). Writes ONLY the
 * position_reconciliation_c scoreboard — never oems_position_c or any money table.
 *
 * Longmark nets everything into ONE omnibus account, so this is BOOK-LEVEL: our
 * per-symbol qty on the desk account vs the broker net. The external sources are
 * populated elsewhere (the dormant worker IPSPositionGetAll1 loop once Charles
 * entitles it; a manual Longmark statement import). Until then the external table
 * is empty and every symbol lands status='pending' — the pipeline runs end-to-end
 * and honestly reports "no external source yet". This is the audit/backup layer so
 * a corrupted our-side ledger is caught against the broker's real holdings.
 */

const EXTERNAL_SOURCES = ["iress_portfolio", "longmark_statement"] as const;
type ExternalSource = (typeof EXTERNAL_SOURCES)[number];

export interface PositionReconResult {
  ok: boolean;
  error?: string;
  runId: string;
  asOfDate: string;
  compared: number;
  ok_count: number;
  mismatch: number;
  missing_external: number;
  missing_ours: number;
  pending: number;
}

interface PosRow {
  account_code: string;
  security_code: string;
  quantity: number | null;
  market_value: number | null;
  currency: string | null;
}
interface AggPos {
  account_code: string;
  security_code: string;
  quantity: number;
  market_value: number | null;
  currency: string | null;
}

function bareCode(s: string): string {
  return String(s ?? "")
    .trim()
    .toUpperCase()
    .replace(/\.(JO|JSE)$/i, "");
}

function empty(
  ok: boolean,
  runId: string,
  asOfDate: string,
  error?: string,
): PositionReconResult {
  return {
    ok,
    error,
    runId,
    asOfDate,
    compared: 0,
    ok_count: 0,
    mismatch: 0,
    missing_external: 0,
    missing_ours: 0,
    pending: 0,
  };
}

export async function runPositionReconciliation(opts?: {
  asOfDate?: string;
  sources?: ExternalSource[];
  toleranceQty?: number;
  runId?: string;
}): Promise<PositionReconResult> {
  const asOfDate = opts?.asOfDate ?? new Date().toISOString().slice(0, 10);
  const sources = opts?.sources ?? [...EXTERNAL_SOURCES];
  const tol = opts?.toleranceQty ?? 0;
  const runId = opts?.runId ?? `recon-${asOfDate}-${Math.random().toString(36).slice(2, 8)}`;

  let db: ReturnType<typeof createInstitutionalServiceRoleClient>;
  try {
    db = createInstitutionalServiceRoleClient();
  } catch {
    return empty(false, runId, asOfDate, "institutional DB not configured");
  }

  // OUR side: aggregate oems_position_c per (account_code, bare symbol).
  const ourRes = await db
    .from("oems_position_c")
    .select("account_code, security_code, quantity, market_value, currency");
  if (ourRes.error) {
    return empty(false, runId, asOfDate, `oems_position_c read failed: ${ourRes.error.message}`);
  }
  const ourByKey = new Map<string, AggPos>();
  for (const r of (ourRes.data ?? []) as PosRow[]) {
    const code = bareCode(r.security_code);
    const key = `${r.account_code}|${code}`;
    const qty = Number(r.quantity) || 0;
    const prev = ourByKey.get(key);
    if (prev) prev.quantity += qty;
    else
      ourByKey.set(key, {
        account_code: r.account_code,
        security_code: code,
        quantity: qty,
        market_value: r.market_value,
        currency: r.currency,
      });
  }

  const counts = { ok: 0, mismatch: 0, missing_external: 0, missing_ours: 0, pending: 0 };
  const now = new Date().toISOString();
  const upserts: Record<string, unknown>[] = [];

  for (const source of sources) {
    const extRes = await db
      .from("position_recon_external_c")
      .select("account_code, security_code, quantity, market_value, currency")
      .eq("as_of_date", asOfDate)
      .eq("source", source);
    if (extRes.error) {
      return empty(false, runId, asOfDate, `position_recon_external_c read failed: ${extRes.error.message}`);
    }
    const extByKey = new Map<string, AggPos>();
    for (const r of (extRes.data ?? []) as PosRow[]) {
      const code = bareCode(r.security_code);
      extByKey.set(`${r.account_code}|${code}`, {
        account_code: r.account_code,
        security_code: code,
        quantity: Number(r.quantity) || 0,
        market_value: r.market_value,
        currency: r.currency,
      });
    }
    const externalPresent = extByKey.size > 0;

    // Full outer join over the union of keys for this source.
    for (const key of new Set<string>([...ourByKey.keys(), ...extByKey.keys()])) {
      const our = ourByKey.get(key);
      const ext = extByKey.get(key);
      const [account_code, security_code] = key.split("|");
      const our_qty = our?.quantity ?? 0;
      const external_qty = ext ? ext.quantity : null;

      let status: keyof typeof counts;
      let diff: number | null = null;
      if (!externalPresent || external_qty == null) {
        // Dormant (no external rows for this source/date) vs external-present-but-
        // this-symbol-absent: the former is the honest "not wired yet" state.
        status = externalPresent ? "missing_external" : "pending";
      } else {
        diff = our_qty - external_qty;
        if (Math.abs(diff) <= tol) status = "ok";
        else if (our_qty === 0 && external_qty > 0) status = "missing_ours";
        else status = "mismatch";
      }
      counts[status] += 1;

      upserts.push({
        as_of_date: asOfDate,
        account_code,
        security_code,
        source,
        our_qty,
        external_qty,
        diff,
        our_market_value: our?.market_value ?? null,
        external_market_value: ext?.market_value ?? null,
        currency: our?.currency ?? ext?.currency ?? null,
        tolerance_qty: tol,
        status,
        recon_run_id: runId,
        notes: externalPresent ? null : `no ${source} rows loaded for ${asOfDate} (source dormant)`,
        payload: { our: our ?? null, external: ext ?? null },
        checked_at: now,
        updated_at: now,
      });
    }
  }

  if (upserts.length > 0) {
    const up = await db
      .from("position_reconciliation_c")
      .upsert(upserts, { onConflict: "as_of_date,account_code,security_code,source" });
    if (up.error) {
      return empty(false, runId, asOfDate, `position_reconciliation_c upsert failed: ${up.error.message}`);
    }
  }

  return {
    ok: true,
    runId,
    asOfDate,
    compared: upserts.length,
    ok_count: counts.ok,
    mismatch: counts.mismatch,
    missing_external: counts.missing_external,
    missing_ours: counts.missing_ours,
    pending: counts.pending,
  };
}
