"use client";

/**
 * Thin client-side auth signal backed by the Supabase browser session.
 *
 * Middleware validates the session on every request; this hook exposes the
 * same fact to React for UI that needs to react to sign-in / sign-out.
 */

import { useEffect, useState, useSyncExternalStore } from "react";

import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { isSupabaseAuthConfigured } from "@/lib/supabase/config";

const PERSONA_COOKIE = "mint-persona";

let version = 0;
const listeners = new Set<() => void>();
function bump() {
  version++;
  for (const l of listeners) l();
}
function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function readCookie(name: string): string | null {
  if (typeof document === "undefined") return null;
  const target = `${name}=`;
  for (const part of document.cookie.split("; ")) {
    if (part.startsWith(target)) {
      return decodeURIComponent(part.slice(target.length));
    }
  }
  return null;
}

async function readSupabaseSession(): Promise<boolean> {
  if (!isSupabaseAuthConfigured()) return false;
  const supabase = createSupabaseBrowserClient();
  const { data } = await supabase.auth.getSession();
  return data.session !== null;
}

export function readPersonaCookie(): string | null {
  return readCookie(PERSONA_COOKIE);
}

/**
 * Returns session presence once mounted. Defaults to `true` on protected
 * routes to avoid a signed-out flash — middleware is the real gate.
 */
export function useAuth(): { isAuthenticated: boolean; ready: boolean } {
  useSyncExternalStore(subscribe, () => version, () => 0);

  const [state, setState] = useState<{ authed: boolean; ready: boolean }>({
    authed: true,
    ready: false,
  });

  useEffect(() => {
    let cancelled = false;
    void readSupabaseSession().then((authed) => {
      if (!cancelled) setState({ authed, ready: true });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return { isAuthenticated: state.authed, ready: state.ready };
}

/** Call after sign-in / sign-out so subscribers re-read the session. */
export function notifyAuthChange() {
  bump();
}
