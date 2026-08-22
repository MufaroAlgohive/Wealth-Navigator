"use client";

/**
 * useCurrentUser — single hook for the signed-in user's basic profile.
 *
 * Reads from `/api/auth/me`, which returns the Supabase auth.user +
 * profiles row. Polls every 60s so a freshly-updated last_sign_in_at or
 * profile edit surfaces on its own; on sign-out the caller should also call
 * `notifyAuthChange()` so the next render refetches immediately.
 *
 * Returns:
 *   - `user`: null while loading (the server hasn't answered yet), null again
 *     after a 401 (signed out), or the full profile payload otherwise.
 *   - `ready`: true once the first /api/auth/me call has resolved (success OR
 *     401). Caller can use this to delay rendering until we know.
 *
 * The user chip in `TopBar` swaps between this user and the demo persona
 * `useUser()` from `session-provider` automatically — when the real user is
 * present, the persona defaults to `oems` but the chip shows the real name.
 */

import * as React from "react";

import { notifyAuthChange } from "@/lib/auth/store";

export interface CurrentUser {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  fullName: string;
  initials: string;
  role: string | null;
  isAdmin: boolean;
  avatarUrl: string | null;
  lastSignInAt: string | null;
  createdAt: string | null;
}

interface FetchState {
  status: "idle" | "loading" | "authed" | "unauth" | "error";
  user: CurrentUser | null;
  error?: string;
}

const INITIAL: FetchState = { status: "idle", user: null };

const POLL_MS = 60_000;

export function useCurrentUser(): { user: CurrentUser | null; ready: boolean } {
  const [state, setState] = React.useState<FetchState>(INITIAL);

  const fetchMe = React.useCallback(async (signal?: AbortSignal) => {
    try {
      const res = await fetch("/api/auth/me", { cache: "no-store", signal });
      if (res.status === 401) {
        setState({ status: "unauth", user: null });
        return;
      }
      if (!res.ok) {
        setState({ status: "error", user: null, error: `HTTP ${res.status}` });
        return;
      }
      const body = (await res.json()) as { ok: false } | ({ ok: true } & CurrentUser);
      if (!body.ok) {
        setState({ status: "unauth", user: null });
        return;
      }
      setState({ status: "authed", user: body });
    } catch (err) {
      if ((err as { name?: string }).name === "AbortError") return;
      setState({ status: "error", user: null, error: (err as Error).message });
    }
  }, []);

  React.useEffect(() => {
    const ac = new AbortController();
    void fetchMe(ac.signal);
    return () => ac.abort();
  }, [fetchMe]);

  // Light polling — covers last_sign_in_at refresh + same-tab sign-in /
  // sign-out triggered from any other component via notifyAuthChange().
  React.useEffect(() => {
    const id = setInterval(() => {
      void fetchMe();
    }, POLL_MS);
    return () => clearInterval(id);
  }, [fetchMe]);

  return { user: state.user, ready: state.status !== "idle" };
}
