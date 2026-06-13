/**
 * Server-only Supabase clients. Never import from client components.
 *
 * Service role bypasses RLS — use only in API routes, workers, and cron jobs.
 */

import { createServerClient } from "@supabase/ssr";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";

import { getSupabaseAnonKey, getSupabaseUrl } from "@/lib/supabase/config";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

/** Cookie-backed Supabase client for Server Components and Route Handlers. */
export async function createSupabaseServerClient(): Promise<SupabaseClient> {
  const cookieStore = await cookies();

  return createServerClient(getSupabaseUrl(), getSupabaseAnonKey(), {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // setAll from a Server Component — middleware handles refresh.
        }
      },
    },
  });
}

/**
 * Resolve a service-role target under the 3-DB topology
 * (see wealth-navigator/docs/DB_TOPOLOGY_DECISION.md). Prefers the split env
 * vars; falls back to the legacy single `SUPABASE_*` pair so existing deploys
 * keep working until the split vars are set. Legacy is treated as the
 * INSTITUTIONAL target (the project the worker/BFF point at today).
 */
type ServiceTarget = "RETAIL" | "INSTITUTIONAL";

function resolveServiceTarget(target: ServiceTarget): { url: string; key: string } {
  const url = process.env[`${target}_SUPABASE_URL`] ?? process.env.SUPABASE_URL;
  const key =
    process.env[`${target}_SUPABASE_SERVICE_ROLE_KEY`] ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      `${target}_SUPABASE_URL / ${target}_SUPABASE_SERVICE_ROLE_KEY (or legacy SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY) is not configured`,
    );
  }
  return { url, key };
}

function makeServiceClient(url: string, key: string): SupabaseClient {
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * RETAIL prod (`mfxng…`) service-role client — customer books + the shared
 * price tables `securities_c` / `stock_intraday_c`. Use for quote reads.
 */
export function createRetailServiceRoleClient(): SupabaseClient {
  const { url, key } = resolveServiceTarget("RETAIL");
  return makeServiceClient(url, key);
}

/**
 * INSTITUTIONAL prod (`nnwz…`) service-role client — desk trading book +
 * desk-only analytics (oems_*, curves, indices, sectors, macro, news, worker
 * health). Use for everything that is not a shared price read.
 */
export function createInstitutionalServiceRoleClient(): SupabaseClient {
  const { url, key } = resolveServiceTarget("INSTITUTIONAL");
  return makeServiceClient(url, key);
}

/**
 * @deprecated Back-compat alias → INSTITUTIONAL. Prefer
 * `createInstitutionalServiceRoleClient()` / `createRetailServiceRoleClient()`.
 */
export function createServiceRoleClient(): SupabaseClient {
  return createInstitutionalServiceRoleClient();
}

/** Anon client for server-side reads that respect RLS (future auth migration). */
export function createAnonServerClient(): SupabaseClient {
  const url = requireEnv("NEXT_PUBLIC_SUPABASE_URL");
  const key = requireEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function isTargetConfigured(target: ServiceTarget): boolean {
  const url = process.env[`${target}_SUPABASE_URL`] ?? process.env.SUPABASE_URL;
  const key =
    process.env[`${target}_SUPABASE_SERVICE_ROLE_KEY`] ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  return Boolean(url && key);
}

/** True when the RETAIL prod (`mfxng…`) service-role target is configured. */
export function isRetailSupabaseConfigured(): boolean {
  return isTargetConfigured("RETAIL");
}

/** True when the INSTITUTIONAL prod (`nnwz…`) service-role target is configured. */
export function isInstitutionalSupabaseConfigured(): boolean {
  return isTargetConfigured("INSTITUTIONAL");
}

/**
 * @deprecated Back-compat alias → INSTITUTIONAL (does not imply writes are
 * enabled). Prefer `isInstitutionalSupabaseConfigured()` /
 * `isRetailSupabaseConfigured()`.
 */
export function isSupabaseConfigured(): boolean {
  return isInstitutionalSupabaseConfigured();
}
