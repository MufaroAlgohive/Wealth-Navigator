/**
 * Server-only Supabase clients. Never import from client components.
 *
 * Service role bypasses RLS — use only in API routes, workers, and cron jobs.
 */

import { createServerClient } from "@supabase/ssr";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";

import { getSupabaseAnonKey, getSupabaseUrl } from "./config";

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
    process.env[`${target}_SUPABASE_SERVICE_ROLE_KEY`] ??
    process.env.SUPABASE_SERVICE_ROLE_KEY ??
    // Legacy retail tooling used this lowercase key. Keep the compatibility
    // narrow: it must never silently select the institutional database.
    (target === "RETAIL" ? process.env.service_role_key : undefined);
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

/** `abcdefgh` from `https://abcdefgh.supabase.co` — "" when unparseable. */
function projectRef(url: string | undefined): string {
  if (!url) return "";
  try {
    return new URL(url).hostname.split(".")[0] ?? "";
  } catch {
    return "";
  }
}

/**
 * Service-role client for the project that ISSUES USER SESSIONS — i.e. the one
 * `NEXT_PUBLIC_SUPABASE_URL` points at, which is what `createSupabaseServerClient()`
 * validates JWTs against.
 *
 * USE THIS FOR EVERY `auth.admin.*` CALL THAT CONCERNS A PERSON WHO LOGS INTO
 * THIS APP (staff invites, password recovery, changing a login email).
 *
 * Why this exists: OEMS splits identity from authorization — sessions come from
 * the project in `NEXT_PUBLIC_SUPABASE_URL`, while `admin_team` (roles +
 * permissions) is read from RETAIL and joined by EMAIL. Calling
 * `auth.admin.generateLink()` on the RETAIL client therefore created invited
 * users in a project the app never authenticates against: the person looked
 * fully set up yet could never sign in (2026-08-04 incident — two staff
 * accounts created in the wrong project).
 *
 * The key is chosen by matching the PROJECT REF of `NEXT_PUBLIC_SUPABASE_URL`
 * against the configured pairs, so this keeps working if the projects are ever
 * consolidated or swapped — no code change needed.
 *
 * NOTE: client/investor magic links (`/api/admin/studio`) and the retail
 * user-activity audit (`/api/admin/cyber-compliance`) concern people who log
 * into the CONSUMER app, whose accounts live in RETAIL. Those must keep using
 * `createRetailServiceRoleClient()`.
 */
export function createAuthAdminClient(): SupabaseClient {
  const url = requireEnv("NEXT_PUBLIC_SUPABASE_URL");
  const ref = projectRef(url);
  const pairs: Array<[string, string | undefined, string | undefined]> = [
    ["INSTITUTIONAL", process.env.INSTITUTIONAL_SUPABASE_URL, process.env.INSTITUTIONAL_SUPABASE_SERVICE_ROLE_KEY],
    ["RETAIL", process.env.RETAIL_SUPABASE_URL, process.env.RETAIL_SUPABASE_SERVICE_ROLE_KEY],
    ["legacy SUPABASE", process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY],
  ];
  for (const [, pairUrl, pairKey] of pairs) {
    if (pairKey && ref && projectRef(pairUrl) === ref) return makeServiceClient(url, pairKey);
  }
  throw new Error(
    `No service-role key matches the session project (NEXT_PUBLIC_SUPABASE_URL ref "${ref}"). ` +
      "Set the SERVICE_ROLE_KEY for that project (INSTITUTIONAL_/RETAIL_/legacy SUPABASE_) so staff " +
      "invites and password recovery run against the project that issues sessions.",
  );
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
    process.env[`${target}_SUPABASE_SERVICE_ROLE_KEY`] ??
    process.env.SUPABASE_SERVICE_ROLE_KEY ??
    (target === "RETAIL" ? process.env.service_role_key : undefined);
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
