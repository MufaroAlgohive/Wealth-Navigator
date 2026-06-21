/**
 * Helpers for the per-panel data-source labelling (the "where does this data
 * come from" badge). A panel passes its database (`db`) + a source kind to
 * `GlassSection`; `mapSource()` normalises the free-form `source` / `price_source`
 * string a BFF returns into a `DataSourceKind` the badge renders.
 *
 * See the data-source map: docs/DATA_SOURCE_MAP or the published artifact.
 */

import type { DataSourceKind, DbName } from "@/components/oems/primitives/data-source-badge";

export type { DataSourceKind, DbName };

/**
 * Normalise a BFF's `source` / `price_source` string into a badge kind.
 *  - iress / live-iress           → "iress"
 *  - yahoo                        → "yahoo"
 *  - supabase / retail-supabase / wire / db → "supabase"
 *  - rss / sarb / frankfurter / ecb / external → "external"
 *  - seed / *-seed                → "seed"
 *  - mock                         → "mock"
 *  - unavailable / unconfigured   → as-is
 *  - any exact DataSourceKind     → passed through
 *  - unknown / undefined          → fallback (default "supabase")
 */
export function mapSource(
  raw: string | null | undefined,
  fallback: DataSourceKind = "supabase",
): DataSourceKind {
  const s = (raw ?? "").trim().toLowerCase();
  if (!s) return fallback;

  // Exact kind passthrough (covers live, hybrid, worker, stream, blocked-*, code-gap, etc.).
  const exact: DataSourceKind[] = [
    "live", "iress", "yahoo", "external", "mock", "seed", "hybrid", "supabase",
    "stream", "worker", "unconfigured", "unavailable", "blocked-external",
    "blocked-vendor", "code-gap",
  ];
  if ((exact as string[]).includes(s)) return s as DataSourceKind;

  if (s.includes("iress")) return "iress";
  if (s.includes("yahoo")) return "yahoo";
  if (s === "sarb" || s === "frankfurter" || s === "ecb" || s.startsWith("rss") || s === "external")
    return "external";
  if (s.includes("wire") || s.includes("supabase") || s === "db" || s === "retail" || s === "institutional")
    return "supabase";
  if (s.includes("seed")) return "seed";
  if (s.includes("mock")) return "mock";
  if (s.includes("unavail")) return "unavailable";
  if (s.includes("unconfig") || s.includes("not configured")) return "unconfigured";

  return fallback;
}
