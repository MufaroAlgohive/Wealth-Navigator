import type { SupabaseClient } from "@supabase/supabase-js";

export type StrategyScopeRow = {
  id: string;
  investor_environment?: string | null;
  name?: string | null;
  short_name?: string | null;
  slug?: string | null;
  status?: string | null;
};

export type RetailLiveScope = {
  excludedUserIds: Set<string>;
  excludedStrategyIds: Set<string>;
};

function normalized(value: unknown): string {
  return String(value ?? "").trim().toUpperCase();
}

/**
 * LIVE money classification. `investor_environment` is authoritative; the
 * narrow name/slug/status checks cover historical Test Strategy rows created
 * before that column was populated. They deliberately do not match arbitrary
 * names merely containing the word "test".
 */
export function isUatStrategy(row: StrategyScopeRow): boolean {
  const environment = normalized(row.investor_environment);
  const status = normalized(row.status);
  const name = normalized(row.name);
  const shortName = normalized(row.short_name);
  const slug = normalized(row.slug);
  return (
    environment === "UAT" ||
    environment === "TEST" ||
    status === "UAT" ||
    status === "TEST" ||
    name === "TEST STRATEGY" ||
    shortName === "TEST STRATEGY" ||
    slug === "TEST-STRATEGY" ||
    slug.startsWith("UAT-")
  );
}

async function required<T>(
  label: string,
  query: PromiseLike<{ data: T | null; error: { message: string } | null }>,
): Promise<T> {
  const { data, error } = await query;
  if (error) throw new Error(`${label}: ${error.message}`);
  if (data == null) throw new Error(`${label}: no data`);
  return data;
}

/** Fail closed: if any LIVE/UAT classifier is unavailable, no AUM is shown. */
export async function loadRetailLiveScope(db: SupabaseClient): Promise<RetailLiveScope> {
  const [strategies, testProfiles, testWallets] = await Promise.all([
    required<StrategyScopeRow[]>(
      "strategy LIVE/UAT classification",
      db
        .from("strategies_c")
        .select("id,investor_environment,name,short_name,slug,status"),
    ),
    required<Array<{ id: string }>>(
      "test profile classification",
      db.from("profiles").select("id").eq("is_test", true),
    ),
    required<Array<{ user_id: string }>>(
      "test wallet classification",
      db.from("wallets").select("user_id").eq("status", "test"),
    ),
  ]);

  return {
    excludedStrategyIds: new Set(strategies.filter(isUatStrategy).map((row) => row.id)),
    excludedUserIds: new Set([
      ...testProfiles.map((row) => row.id),
      ...testWallets.map((row) => row.user_id),
    ]),
  };
}
