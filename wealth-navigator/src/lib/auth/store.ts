"use client";

/**
 * Thin client-side auth signal.
 *
 * The middleware sets and reads the `mint-auth` cookie as the canonical
 * session signal; this hook just exposes the same fact to React so the
 * UI can render gated / ungated states without having to ferry state
 * through props.
 *
 * Hydration model:
 *   - On the server (and on the first client render before effects run)
 *     we return `isAuthenticated: true` to avoid a flash of "signed out"
 *     for users who ARE actually signed in. The middleware already
 *     guarantees that if we got this far, the user is authed.
 *   - On mount we read `document.cookie`. If the cookie is missing, we
 *     flip the flag to `false` — useful for a stale tab whose cookie
 *     expired in another window.
 *
 * Components that need to react to login/logout should listen to a
 * `storage` event or call `bumpVersion()` after a manual mutation; the
 * hook subscribes to a tiny in-process version counter.
 */

import { useEffect, useState, useSyncExternalStore } from "react";
import { AUTH_COOKIE } from "@/middleware";

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

export function isAuthedOnClient(): boolean {
  return readCookie(AUTH_COOKIE) === "1";
}

export function readPersonaCookie(): string | null {
  return readCookie(PERSONA_COOKIE);
}

/**
 * Returns `true` once mounted AND the cookie is present. `false` while
 * SSR / pre-mount, and `false` if the cookie is missing on the client.
 *
 * The default value is `true` for the same reason described at the top
 * of this file — we don't want a brief "you're signed out" flash for
 * users who actually are signed in. The middleware already enforces the
 * real gate.
 */
export function useAuth(): { isAuthenticated: boolean; ready: boolean } {
  // Subscribe to version so manual bumps (login/logout) re-render.
  useSyncExternalStore(subscribe, () => version, () => 0);

  const [state, setState] = useState<{ authed: boolean; ready: boolean }>({
    authed: true,
    ready: false,
  });

  useEffect(() => {
    setState({ authed: isAuthedOnClient(), ready: true });
  }, []);

  return { isAuthenticated: state.authed, ready: state.ready };
}

/**
 * Call after a manual `document.cookie` change (e.g. from a test or
 * devtools) so subscribers re-read.
 */
export function notifyAuthChange() {
  bump();
}
