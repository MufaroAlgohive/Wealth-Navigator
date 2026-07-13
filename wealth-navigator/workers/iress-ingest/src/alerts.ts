/**
 * Trigger-alert evaluator. Runs on the institutional DB (no IRESS session
 * needed) and compares each approved research note's `triggers` JSONB against
 * the most recent live retail price we ingested. Whenever a trigger is
 * breached, a row is written to `alert_log_c` (idempotent per note+trigger+date
 * via the `breached_date` generated column) and a worker event is recorded.
 *
 * Price source: the RETAIL DB's `stock_intraday_c` (live ticks in cents)
 * with a fallback to `securities_c.last_price`. Triggers are stored in
 * Rands (e.g. NPN BUY BELOW R4,000), so cents are converted before the
 * comparison. The institutional `quote_snapshot_c` table is treated as a
 * tertiary source — its schema differs (keyed by `security_code`, not
 * `symbol`) and is not the canonical price path the desk reads.
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
 * Both `level` and `observed` are in RANDS. `buy_below` / `add_below` /
 * `stop_loss` fire when observed ≤ level; `trim_above` / `sell_above`
 * fire when observed ≥ level. */
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

interface LatestPrice {
  last_rands: number;
  observed_at: string;
  source: "intraday" | "securities" | "snapshot";
}

interface PriceRow {
  symbol: string;
  last_cents: number;
  as_of: string;
}

/**
 * Walk every approved note with triggers, compare to the latest retail price,
 * and write any breaches to alert_log_c. Safe to call on every quote sync
 * tick — the generated `breached_date` column + unique index make the write
 * idempotent (same note + trigger on the same day never fires twice).
 *
 * @param retailSupabase  Supabase client bound to the RETAIL prod DB
 *   (where `stock_intraday_c` / `securities_c` live). Optional — if missing,
 *   the evaluator falls back to the institutional `quote_snapshot_c.last`
 *   (cents) so the path still works on a fresh deploy.
 */
export async function evaluateTriggers({
  env,
  supabase,
  retailSupabase,
}: {
  env: WorkerEnv;
  supabase: WorkerSupabase | null;
  retailSupabase?: WorkerSupabase | null;
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

  // 1. Approved notes with non-null triggers JSONB (institutional DB — `research_note_c`).
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

  const symbols = Array.from(new Set(notes.map((n) => n.symbol.toUpperCase())));
  const latestBySym = new Map<string, LatestPrice>();

  // 2a. Primary source: retail `stock_intraday_c` (live ticks in cents).
  //     Newest tick wins per symbol; we convert cents to Rands so the
  //     trigger comparison is apples-to-apples (triggers store rands).
  if (retailSupabase) {
    try {
      const intradayRes = await retailSupabase
        .from("stock_intraday_c")
        .select("symbol, current_price, timestamp")
        .in("symbol", symbols)
        .order("timestamp", { ascending: false })
        .limit(symbols.length * 8);
      if (intradayRes.error) {
        out.errors.push(`intraday fetch: ${intradayRes.error.message}`);
      } else {
        for (const r of (intradayRes.data ?? []) as Array<{
          symbol: string;
          current_price: number | null;
          timestamp: string;
        }>) {
          const k = String(r.symbol).toUpperCase();
          if (latestBySym.has(k)) continue;
          const cents = Number(r.current_price);
          if (!Number.isFinite(cents) || cents <= 0) continue;
          latestBySym.set(k, {
            last_rands: Math.round(cents) / 100,
            observed_at: r.timestamp,
            source: "intraday",
          });
        }
      }
    } catch (err) {
      out.errors.push(`intraday fetch threw: ${err instanceof Error ? err.message : String(err)}`);
    }

    // 2b. Fallback: retail `securities_c.last_price` (cents, end-of-day
    //     Yahoo parity) — covers symbols that haven't ticked today yet
    //     (pre-open / halt / non-trading day).
    const missing = symbols.filter((s) => !latestBySym.has(s));
    if (missing.length > 0) {
      const secRes = await retailSupabase
        .from("securities_c")
        .select("symbol, last_price")
        .in("symbol", missing)
        .limit(missing.length);
      if (secRes.error) {
        out.errors.push(`securities fetch: ${secRes.error.message}`);
      } else {
        for (const r of (secRes.data ?? []) as Array<{ symbol: string; last_price: number | null }>) {
          const k = String(r.symbol).toUpperCase();
          if (latestBySym.has(k)) continue;
          const cents = Number(r.last_price);
          if (!Number.isFinite(cents) || cents <= 0) continue;
          latestBySym.set(k, {
            last_rands: Math.round(cents) / 100,
            observed_at: new Date().toISOString(),
            source: "securities",
          });
        }
      }
    }
  }

  // 2c. Tertiary: institutional `quote_snapshot_c.last` (cents, IRESS L1
  //     overlay). Schema is keyed by (security_code, exchange). The
  //     worker writes `security_code = <bare symbol>` (e.g. "NPN",
  //     "USDZAR") in `quotes.ts`/`retail-ingest.ts`, so this query is
  //     safe to run on the same `security_code` strings the research
  //     notes carry. Only consulted for symbols the retail side
  //     missed (no intraday tick + no securities_c.last_price).
  if (supabase) {
    const missing = symbols.filter((s) => !latestBySym.has(s));
    if (missing.length > 0) {
      try {
        const snapRes = await supabase
          .from("quote_snapshot_c")
          .select("security_code, last, as_of")
          .in("security_code", missing)
          .order("as_of", { ascending: false })
          .limit(missing.length * 2);
        if (snapRes.error) {
          out.errors.push(`snapshot fetch: ${snapRes.error.message}`);
        } else {
          for (const r of (snapRes.data ?? []) as Array<{
            security_code: string;
            last: number | null;
            as_of: string;
          }>) {
            const k = String(r.security_code).toUpperCase();
            if (latestBySym.has(k)) continue;
            const cents = Number(r.last);
            if (!Number.isFinite(cents) || cents <= 0) continue;
            latestBySym.set(k, {
              last_rands: Math.round(cents) / 100,
              observed_at: r.as_of ?? new Date().toISOString(),
              source: "snapshot",
            });
          }
        }
      } catch (err) {
        out.errors.push(`snapshot fetch threw: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // 3. For each (note, trigger) evaluate the breach and insert into alert_log_c.
  //    The generated `breached_date` column + unique index make the write
  //    idempotent (same note + trigger + day → SQLSTATE 23505 = already fired).
  for (const n of notes) {
    const sym = n.symbol.toUpperCase();
    const snap = latestBySym.get(sym);
    if (!snap) continue;
    for (const kind of KINDS) {
      const t = n.triggers?.[kind];
      if (!t || typeof t.price !== "number" || !Number.isFinite(t.price)) continue;
      if (!isBreached(kind, t.price, snap.last_rands)) continue;
      out.breached += 1;

      if (env.dryRun || !env.allowWrites) {
        out.skipped += 1;
        recordWorkerEvent({
          level: "info",
          event: "alert_trigger_breached_dryrun",
          msg: `Trigger ${kind}@${t.price} breached on ${sym} (last=${snap.last_rands})`,
          data: {
            note_id: n.id,
            symbol: sym,
            kind,
            level: t.price,
            observed: snap.last_rands,
            source: snap.source,
          },
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
          observed_price: snap.last_rands,
          payload: {
            note: t.note ?? null,
            observed_at: snap.observed_at,
            source: snap.source,
          },
        });
      if (insErr) {
        // 23505 = unique_violation on (note_id, trigger_kind, breached_date).
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
          msg: `Trigger ${kind}@${t.price} breached on ${sym} (last=${snap.last_rands})`,
          data: {
            note_id: n.id,
            symbol: sym,
            kind,
            level: t.price,
            observed: snap.last_rands,
            source: snap.source,
          },
        });
        // Best-effort email — the webhook is optional.
        out.emailWebhooksTried += 1;
        const to = process.env.ALERT_EMAIL_TO ?? "";
        const r = await dispatchEmail(env, {
          to,
          subject: `[OEMS] ${sym} ${kind}@${t.price} (last ${snap.last_rands})`,
          body: `${sym} ${kind} trigger fired at ${t.price}; observed ${snap.last_rands} at ${snap.observed_at}.`,
          note_id: n.id,
          symbol: sym,
          kind,
        });
        if (r.ok) out.emailed += 1;
        // Stamp email_sent_at if a webhook fired successfully (best-effort).
        if (r.ok && to) {
          // `breached_date` is the generated-UTC date column on alert_log_c;
          // using it here keeps the predicate IMMUTABLE-friendly.
          const todayUtc = new Date().toISOString().slice(0, 10);
          await supabase
            .from("alert_log_c")
            .update({ email_sent_at: new Date().toISOString(), email_to: to })
            .eq("note_id", n.id)
            .eq("trigger_kind", kind)
            .eq("breached_date", todayUtc);
        }
      }
    }
  }

  return out;
}

/** Worker entry-point helper signature so the test stub matches the eval
 * signature without TypeScript narrowing. */
export type PriceRowForTest = PriceRow;
export type AlertsResultForTest = AlertsResult;