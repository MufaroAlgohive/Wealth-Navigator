/**
 * Server-only Supabase clients. Never import from client components.
 *
 * Service role bypasses RLS — use only in API routes, workers, and cron jobs.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

/** Service-role client for workers and trusted server jobs. */
export function createServiceRoleClient(): SupabaseClient {
  return createClient(requireEnv("SUPABASE_URL"), requireEnv("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** Anon client for server-side reads that respect RLS (future auth migration). */
export function createAnonServerClient(): SupabaseClient {
  const url = requireEnv("NEXT_PUBLIC_SUPABASE_URL");
  const key = requireEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** True when Supabase URL + service key are present (does not imply writes are enabled). */
export function isSupabaseConfigured(): boolean {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}
