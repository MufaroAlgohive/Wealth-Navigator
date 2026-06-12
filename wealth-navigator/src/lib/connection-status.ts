import type { TickFeedKind } from "@/lib/store/tick-stream-provider";

/** Supabase BFF poll (~15s) + Realtime — stale only after this gap. */
export const SUPABASE_STALE_MS = 20_000;

/** SSE / mock tick stream — tighter freshness window. */
export const STREAM_LIVE_MS = 2_000;
export const STREAM_STALE_MS = 5_000;

export type ConnectionTone = "live" | "lag" | "stale";

export interface ConnectionStatus {
  label: string;
  tone: ConnectionTone;
  stale: boolean;
}

/**
 * Derives ConnectionPill label + tone from last tick age and feed kind.
 * Supabase mode tolerates the 15s poll interval; stream/mock use WS thresholds.
 */
export function deriveConnectionStatus(
  ageMs: number,
  feedKind: TickFeedKind,
  realDataOnly: boolean,
): ConnectionStatus {
  const supabaseMode = realDataOnly || feedKind === "supabase";

  if (supabaseMode) {
    const stale = ageMs > SUPABASE_STALE_MS;
    return {
      label: stale ? "STALE" : "SUPABASE OK",
      tone: stale ? "stale" : "live",
      stale,
    };
  }

  if (feedKind === "stream") {
    const stale = ageMs > STREAM_STALE_MS;
    const live = ageMs < STREAM_LIVE_MS;
    return {
      label: live ? "WS OK" : stale ? "STALE" : "LAG",
      tone: live ? "live" : stale ? "stale" : "lag",
      stale,
    };
  }

  const stale = ageMs > STREAM_STALE_MS;
  const live = ageMs < STREAM_LIVE_MS;
  return {
    label: live ? "MOCK OK" : stale ? "STALE" : "LAG",
    tone: live ? "live" : stale ? "stale" : "lag",
    stale,
  };
}
