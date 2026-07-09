/**
 * Broker-feed worker env loader.
 *
 * Defaults to the production SAFETY posture (mock + dry-run + writes
 * disabled). Two independent gates must be flipped to enable live writes:
 *   - BROKER_WORKER_DRY_RUN=0  and
 *   - SUPABASE_ALLOW_WRITES=1
 */

export interface WorkerEnv {
  workerId: string;
  brokerMode: "mock" | "live";
  dryRun: boolean;
  allowWrites: boolean;
  pollIntervalMs: number;
  heartbeatSec: number;
  brokerApiUrl: string;
  brokerApiKey: string;
  institutionalSupabaseUrl: string;
  institutionalSupabaseKey: string;
  /** Last-seen fill cursor (ISO timestamp) the worker reads on every poll.
   *  In-memory only — restart resets and the worker re-pulls the most recent
   *  fills. We never trust a broker-side cursor without an upstream
   *  `?since=` cursor contract; once the real broker is wired this should
   *  persist to a Supabase `broker_cursor_c` row. */
  initialCursor: string;
}

function parseBool(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined || value === "") return defaultValue;
  return value === "1" || value.toLowerCase() === "true";
}

export function loadWorkerEnv(): WorkerEnv {
  const supabaseUrl = process.env.SUPABASE_URL ?? "";
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  const institutionalSupabaseUrl = process.env.INSTITUTIONAL_SUPABASE_URL ?? supabaseUrl;
  const institutionalSupabaseKey = process.env.INSTITUTIONAL_SUPABASE_SERVICE_ROLE_KEY ?? supabaseServiceKey;

  const mode = process.env.BROKER_MODE === "live" ? "live" : "mock";

  return {
    workerId: process.env.WORKER_ID ?? "broker-ingest-1",
    brokerMode: mode,
    dryRun: parseBool(process.env.BROKER_WORKER_DRY_RUN, true),
    allowWrites: parseBool(process.env.SUPABASE_ALLOW_WRITES, false),
    pollIntervalMs: Math.max(5_000, Number(process.env.BROKER_POLL_INTERVAL_MS ?? "60000")),
    heartbeatSec: Math.max(5, Number(process.env.BROKER_WORKER_HEARTBEAT_SEC ?? "30")),
    brokerApiUrl: (process.env.BROKER_API_URL ?? "").trim(),
    brokerApiKey: (process.env.BROKER_API_KEY ?? "").trim(),
    institutionalSupabaseUrl,
    institutionalSupabaseKey,
    // Default cursor = now-5min so a fresh boot doesn't replay the whole book.
    initialCursor: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
  };
}
