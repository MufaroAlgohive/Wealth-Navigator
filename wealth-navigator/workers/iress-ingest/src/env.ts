export interface WorkerEnv {
  workerId: string;
  iressMode: string;
  dryRun: boolean;
  allowWrites: boolean;
  heartbeatSec: number;
  quoteIntervalSec: number;
  orderPollIntervalSec: number;
  watchlistSymbols: string[];
  instrumentSync: boolean;
  supabaseUrl: string;
  supabaseServiceKey: string;
  iressAccountCode: string;
  applicationLabel: string;
}

function parseBool(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined || value === "") return defaultValue;
  return value === "1" || value.toLowerCase() === "true";
}

function parseList(value: string | undefined, fallback: string[]): string[] {
  const raw = (value ?? "").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
  return raw.length > 0 ? raw : fallback;
}

/** Default JSE Top-40 watchlist — sane for a live deploy. */
const DEFAULT_WATCHLIST = [
  "NPN", "PRX", "FSR", "SBK", "AGL", "BHG", "MTN", "SOL", "SHP", "CPI",
  "REM", "BID", "ABG", "SLM", "AMS", "WHL", "TBS", "GRT", "CLS", "MNP",
];

export function loadWorkerEnv(): WorkerEnv {
  const supabaseUrl = process.env.SUPABASE_URL ?? "";
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

  return {
    workerId: process.env.WORKER_ID ?? "iress-ingest-1",
    iressMode: process.env.IRESS_MODE ?? "mock",
    dryRun: parseBool(process.env.IRESS_WORKER_DRY_RUN, true),
    allowWrites: parseBool(process.env.SUPABASE_ALLOW_WRITES, false),
    heartbeatSec: Number(process.env.IRESS_WORKER_HEARTBEAT_SEC ?? "30"),
    quoteIntervalSec: Number(process.env.IRESS_WORKER_QUOTE_INTERVAL_SEC ?? "15"),
    orderPollIntervalSec: Number(process.env.IRESS_WORKER_ORDER_POLL_SEC ?? "60"),
    watchlistSymbols: parseList(process.env.IRESS_WATCHLIST_SYMBOLS, DEFAULT_WATCHLIST),
    instrumentSync: parseBool(process.env.IRESS_WORKER_INSTRUMENT_SYNC, false),
    supabaseUrl,
    supabaseServiceKey,
    iressAccountCode: process.env.IRESS_ACCOUNT_CODE ?? "",
    applicationLabel: process.env.IRESS_APPLICATION_LABEL ?? "Mint-OEMS-Worker",
  };
}
