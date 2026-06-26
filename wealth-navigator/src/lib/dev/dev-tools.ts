"use client";

/**
 * Developer debug overlay gating + a live API-call log.
 *
 * The per-section endpoint/method labels and the floating debug HUD exist so the
 * IRESS integration developers can see exactly what each page and module calls
 * (which API, GET vs POST, status, timing). They are shown ONLY to an explicit
 * allowlist of users so normal live users never see any debug chrome.
 *
 * Matched case-insensitively on email OR Supabase UID. Email is the robust
 * primary key; the UIDs are a secondary match. These are not secrets (just an
 * allowlist of who sees non-sensitive endpoint labels), so a client-side list
 * is fine.
 */

import { useEffect, useState, useSyncExternalStore } from "react";

import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { isSupabaseAuthConfigured } from "@/lib/supabase/config";

const ALLOWED_EMAILS = new Set<string>(["andre.pietersen@iress.com", "juan@autonama.co.za"]);
const ALLOWED_UIDS = new Set<string>([
  "780844ca-8b4d-4b9c-811a-5e47855b38a8",
  "23be8422-34f6-46de-aa8c-7ae102dc8702",
]);

function isAllowed(uid: string | null, email: string | null): boolean {
  if (email && ALLOWED_EMAILS.has(email.trim().toLowerCase())) return true;
  if (uid && ALLOWED_UIDS.has(uid.trim().toLowerCase())) return true;
  return false;
}

// --- Allowlist resolution (module singleton, resolved once) -----------------

export interface DevUserState {
  uid: string | null;
  email: string | null;
  enabled: boolean;
  ready: boolean;
}

const INITIAL: DevUserState = { uid: null, email: null, enabled: false, ready: false };
let userState: DevUserState = INITIAL;
let resolving = false;
const userListeners = new Set<() => void>();

function emitUser() {
  for (const l of userListeners) l();
}

async function resolveDevUser(): Promise<void> {
  if (resolving || userState.ready) return;
  resolving = true;
  try {
    if (!isSupabaseAuthConfigured()) {
      userState = { ...INITIAL, ready: true };
      emitUser();
      return;
    }
    const sb = createSupabaseBrowserClient();
    const { data } = await sb.auth.getUser();
    const uid = data.user?.id ?? null;
    const email = data.user?.email ?? null;
    userState = { uid, email, enabled: isAllowed(uid, email), ready: true };
    emitUser();
  } catch {
    userState = { ...INITIAL, ready: true };
    emitUser();
  } finally {
    resolving = false;
  }
}

function subscribeUser(cb: () => void): () => void {
  userListeners.add(cb);
  return () => {
    userListeners.delete(cb);
  };
}

/** True only for the allowlisted debug users. Resolves the Supabase user once. */
export function useDevTools(): DevUserState {
  const s = useSyncExternalStore(
    subscribeUser,
    () => userState,
    () => INITIAL,
  );
  useEffect(() => {
    void resolveDevUser();
  }, []);
  return s;
}

// --- Live API-call log ------------------------------------------------------

export interface ApiCall {
  id: number;
  method: string;
  path: string;
  status: number | "ERR";
  ms: number;
  ts: number;
}

const MAX_LOG = 60;
const EMPTY_LOG: ApiCall[] = [];
let apiLog: ApiCall[] = EMPTY_LOG;
let seq = 0;
let interceptorInstalled = false;
const logListeners = new Set<() => void>();

function emitLog() {
  for (const l of logListeners) l();
}

function pushCall(c: ApiCall): void {
  apiLog = [c, ...apiLog].slice(0, MAX_LOG);
  emitLog();
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function methodOf(input: RequestInfo | URL, init?: RequestInit): string {
  if (init?.method) return init.method.toUpperCase();
  if (typeof input === "object" && !(input instanceof URL) && "method" in input) {
    return (input.method || "GET").toUpperCase();
  }
  return "GET";
}

/** Shorten to the app-relative path + search so the log reads cleanly. */
function shortPath(raw: string): string {
  try {
    const u = new URL(raw, typeof window !== "undefined" ? window.location.origin : "http://x");
    return u.pathname + u.search;
  } catch {
    return raw;
  }
}

/**
 * Wrap window.fetch ONCE to record same-origin /api calls. Installed only for
 * allowlisted users (called from the HUD), so non-debug users get the native
 * fetch untouched. Idempotent.
 */
export function installApiInterceptor(): void {
  if (interceptorInstalled || typeof window === "undefined") return;
  interceptorInstalled = true;
  const orig: typeof window.fetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const raw = urlOf(input);
    if (!raw.includes("/api/")) return orig(input, init);
    const method = methodOf(input, init);
    const path = shortPath(raw);
    const id = ++seq;
    const t0 = performance.now();
    try {
      const res = await orig(input, init);
      pushCall({ id, method, path, status: res.status, ms: Math.round(performance.now() - t0), ts: Date.now() });
      return res;
    } catch (err) {
      pushCall({ id, method, path, status: "ERR", ms: Math.round(performance.now() - t0), ts: Date.now() });
      throw err;
    }
  };
}

function subscribeLog(cb: () => void): () => void {
  logListeners.add(cb);
  return () => {
    logListeners.delete(cb);
  };
}

/** The most recent API calls (newest first), for the debug HUD. */
export function useApiLog(): ApiCall[] {
  return useSyncExternalStore(
    subscribeLog,
    () => apiLog,
    () => EMPTY_LOG,
  );
}
