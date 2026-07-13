/**
 * Trigger-alert evaluator. Runs on the institutional DB (no IRESS session
 * needed) and compares each approved research note's `triggers` JSONB against
 * the most recent `quote_snapshot_c.last_price` we ingested. Whenever a
 * trigger is breached, a row is written to `alert_log_c` (idempotent per
 * note+trigger+date) and a worker event is recorded.
 *
 * The Cockpit banner + /api/alerts route read from `alert_log_c`; an
 * operator acknowledges via POST /api/alerts/[id]/ack. Email delivery is
 * best-effort — the worker's webhook target is `ALERT_EMAIL_WEBHOOK_URL`;
 * if unset we record the alert and skip the email (the UI still surfaces
 * the unacked row).
 */

import type { WorkerEnv } from "./env";
import type { WorkerSupabase } from "./supabase";
import { recordWorkerEvent } from "./events";

type TriggerKind = "buy_below" | "add_below" | "trim_above" | "sell_above" | "stop_loss";

interface TriggerRow {
  price: number;
  note?: string | null;
}

interface ResearchNoteRow {
  id: string;
  symbol: string;
  status: string;
  triggers: Partial<Record<TriggerKind, TriggerRow>> | null;
}

export interface AlertsResult {
  notes: number;
  breached: number;
  inserted: number;
  skipped: number;
  emailed: number;
  emailWebhooksTried: number;
  errors: string[];
}

const KINDS: TriggerKind[] = ["buy_below", "add_below", "trim_above", "sell_above", "stop_loss"];

/** Returns true if the trigger has been breached at the observed price.
 * `buy_below` / `add_below` / `stop_loss` fire when price ≤ level.
 * `trim_above` / `sell_above` fire when price ≥ level. */
function isBreached(kind: TriggerKind, level: number, observed: number): boolean {
  if (kind === "buy_below" || kind === "add_below" || kind === "stop_loss") {
    return observed <= level;
  }
  return observed >= level;
}

/** POST the alert JSON to the operator's email/notification webhook.
 * Best-effort: a non-2xx response is logged but doesn't fail the cycle. */
async function dispatchEmail(
  env: WorkerEnv,
  payload: Record<string, unknown>,
): Promise<{ ok: boolean; status?: number }> {
  const url = process.env.ALERT_EMAIL_WEBHOOK_URL;
  if (!url) return { ok: false };
  const headers: Record<string, string> = { "content-type": "application/json" };
  const token = process.env.ALERT_EMAIL_WEBHOOK_TOKEN;
  if (token) headers.authorization = `Bearer ${token}`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
    return { ok: res.ok, status: res.status };
  } catch {
    return { ok: false };
  }
}

/**
 * Walk every approved note with triggers, compare to the latest snapshot,
 * and write any breaches to alert_log_c. Safe to call on every quote sync
 * tick — the unique index `(note_id, trigger_kind, breached_at::date)`
 * collapses same-day duplicates.
 */
export async function evaluateTriggers({
  env,
  supabase,
}: {
  env: WorkerEnv;
  supabase: WorkerSupabase | null;
}): Promise<AlertsResult> {
  const out: AlertsResult = {
    notes: 0,
    breached: 0,
    inserted: 0,
    skipped: 0,
    emailed: 0,
    emailWebhooksTried: 0,
    errors: [],
  };
  if (!supabase) {
    out.errors.push("institutional Supabase client not configured");
    return out;
  }

  // 1. Approved notes with non-null triggers JSONB.
  const notesRes = await supabase
    .from("research_note_c")
    .select("id, symbol, status, triggers")
    .eq("status", "approved")
    .not("triggers", "is", null)
    .limit(200);
  if (notesRes.error) {
    out.errors.push(`notes fetch: ${notesRes.error.message}`);
    return out;
  }
  const notes = (notesRes.data ?? []) as ResearchNoteRow[];
  out.notes = notes.length;
  if (notes.length === 0) return out;

  // 2. Latest snapshot price per symbol from the worker's institutional quote
  //    snapshot table (populated by `syncRetailPrices` / `quote_snapshot_c`).
  //    If the snapshot is missing for a symbol we skip silently — quotes are
  //    a separate loop and we shouldn't fail the alerts cycle.
  const symbols = Array.from(new Set(notes.map((n) => n.symbol.toUpperCase())));
  const snapRes = await supabase
    .from("quote_snapshot_c")
    .select("symbol, last_price, observed_at")
    .in("symbol", symbols)
    .order("observed_at", { ascending: false })
    .limit(symbols.length * 2);
  if (snapRes.error) {
    out.errors.push(`snapshot fetch: ${snapRes.error.message}`);
    // Continue — we can still process notes with no snapshot and skip them.
  }
  const latestBySym = new Map<string, { last_price: number; observed_at: string }>();
  for (const r of (snapRes.data ?? []) as Array<{ symbol: string; last_price: number | null; observed_at: string }>) {
    const k = String(r.symbol).toUpperCase();
    if (latestBySym.has(k)) continue;
    if (typeof r.last_price === "number" && Number.isFinite(r.last_price)) {
      latestBySym.set(k, { last_price: r.last_price, observed_at: r.observed_at });
    }
  }

  // 3. For each (note, trigger) evaluate the breach and upsert into alert_log_c.
  //    The unique index `uq_alert_log_daily` makes the write idempotent — same
  //    note + trigger on the same day never fires twice.
  for (const n of notes) {
    const sym = n.symbol.toUpperCase();
    const snap = latestBySym.get(sym);
    if (!snap) continue;
    for (const kind of KINDS) {
      const t = n.triggers?.[kind];
      if (!t || typeof t.price !== "number" || !Number.isFinite(t.price)) continue;
      if (!isBreached(kind, t.price, snap.last_price)) continue;
      out.breached += 1;

      if (env.dryRun || !env.allowWrites) {
        out.skipped += 1;
        recordWorkerEvent({
          level: "info",
          event: "alert_trigger_breached_dryrun",
          msg: `Trigger ${kind}@${t.price} breached on ${sym} (last=${snap.last_price})`,
          data: { note_id: n.id, symbol: sym, kind, level: t.price, observed: snap.last_price },
        });
        continue;
      }

      const { error: insErr } = await supabase
        .from("alert_log_c")
        .insert({
          note_id: n.id,
          symbol: sym,
          trigger_kind: kind,
          trigger_price: t.price,
          observed_price: snap.last_price,
          payload: {
            note: t.note ?? null,
            observed_at: snap.observed_at,
          },
        });
      if (insErr) {
        // 23505 = unique_violation on (note_id, trigger_kind, breached_at::date).
        // Treat as "already fired today" — success-path, not an error.
        if (insErr.code === "23505") {
          out.skipped += 1;
        } else {
          out.errors.push(`alert insert (${sym} ${kind}): ${insErr.message}`);
          continue;
        }
      } else {
        out.inserted += 1;
        recordWorkerEvent({
          level: "warn",
          event: "alert_trigger_breached",
          msg: `Trigger ${kind}@${t.price} breached on ${sym} (last=${snap.last_price})`,
          data: { note_id: n.id, symbol: sym, kind, level: t.price, observed: snap.last_price },
        });
        // Best-effort email — the webhook is optional.
        out.emailWebhooksTried += 1;
        const to = process.env.ALERT_EMAIL_TO ?? "";
        const r = await dispatchEmail(env, {
          to,
          subject: `[OEMS] ${sym} ${kind}@${t.price} (last ${snap.last_price})`,
          body: `${sym} ${kind} trigger fired at ${t.price}; observed ${snap.last_price} at ${snap.observed_at}.`,
          note_id: n.id,
          symbol: sym,
          kind,
        });
        if (r.ok) out.emailed += 1;
        // Stamp email_sent_at if a webhook fired successfully (best-effort).
        if (r.ok && to) {
          await supabase
            .from("alert_log_c")
            .update({ email_sent_at: new Date().toISOString(), email_to: to })
            .eq("note_id", n.id)
            .eq("trigger_kind", kind)
            .gte("breached_at", new Date(new Date().toISOString().slice(0, 10)).toISOString());
        }
      }
    }
  }

  return out;
}