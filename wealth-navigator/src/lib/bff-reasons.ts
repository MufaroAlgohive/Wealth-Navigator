/**
 * Shared BFF `reason` taxonomy. Threaded through every BFF that returns
 * `source: "unavailable"` so the UI can render one of the specific
 * cause-based messages instead of a generic "Data feed not configured"
 * banner. Audit #5.
 *
 * Five values, no more:
 *  - supabase_not_configured:  Vercel env is missing SUPABASE_URL /
 *                              SUPABASE_SERVICE_ROLE_KEY.
 *  - supabase_query_failed:    Table doesn't exist yet (migration not
 *                              pasted) or query errored out. The BFF
 *                              payload includes the actual `error` class.
 *  - empty:                    Table exists, query succeeded, zero rows.
 *  - entitlement_blocked:      Worker logs 25014 (or method not on the
 *                              IRESS allowlist) — only the worker can
 *                              surface this; BFFs that proxy the worker
 *                              forward the worker's `reason`.
 *  - worker_not_running:       No recent heartbeats; the BFF is using
 *                              last-known-good data but the worker
 *                              hasn't refreshed in 60s+.
 *
 * The UI's `EmptyDataState` reads this via the `reason` prop. New
 * reasons must be added in two places: here + the `EmptyDataState`
 * renderer. Don't introduce freeform reason strings at call-sites.
 */
export type BffUnavailableReason =
  | "supabase_not_configured"
  | "supabase_query_failed"
  | "empty"
  | "entitlement_blocked"
  | "worker_not_running";

/**
 * Detect the standard "table doesn't exist yet" Supabase error class
 * so the BFF can map it to `supabase_query_failed` with a useful
 * payload message. The BFF still returns 200 so the UI can render
 * the empty state with the migration hint — a 5xx would make the
 * React Query hook retry and the user would see a spinner forever.
 */
export function isSupabaseSchemaMissing(error: { message?: string; code?: string } | null | undefined): boolean {
  if (!error) return false;
  const msg = String(error.message ?? "").toLowerCase();
  const code = String(error.code ?? "");
  // PGRST116 is the generic "no rows" PostgREST code (NOT what we
  // want); 42P01 is Postgres "undefined_table". PostgresMessage
  // strings vary — we match on the canonical substrings.
  if (code === "42P01" || code === "PGRST204" || code === "PGRST205") return true;
  if (msg.includes("does not exist") && msg.includes("relation")) return true;
  if (msg.includes("could not find the table")) return true;
  return false;
}
