"use client";

import * as React from "react";

/**
 * Space-switcher state — separates the Admin CRM surface (client-confidential)
 * from the Marketing surface (campaigns / emailers / triggers). Persisted to
 * localStorage so the sidebar respects it across reloads and route changes.
 *
 * "both" is the default for full-privilege admins; the sidebar still renders
 * every item they have page-access to in this mode.
 */
export type SpaceId = "admin-crm" | "marketing" | "both";

export const SPACE_STORAGE_KEY = "mint.platform.space";

export const SPACE_LABEL: Record<SpaceId, { label: string; short: string }> = {
  "admin-crm": { label: "Admin CRM", short: "CRM" },
  marketing: { label: "Marketing", short: "MKT" },
  both: { label: "All surfaces", short: "ALL" },
};

const VALID: readonly SpaceId[] = ["admin-crm", "marketing", "both"];

function readSpace(): SpaceId {
  if (typeof window === "undefined") return "admin-crm";
  try {
    const raw = window.localStorage.getItem(SPACE_STORAGE_KEY);
    if (raw && (VALID as readonly string[]).includes(raw)) return raw as SpaceId;
  } catch {
    /* localStorage blocked — fall back silently */
  }
  return "admin-crm";
}

/** Subscribable space id — emits on localStorage writes from any tab/window. */
export function useSpace(): {
  space: SpaceId;
  setSpace: (s: SpaceId) => void;
} {
  const [space, setSpaceState] = React.useState<SpaceId>("admin-crm");

  // Hydrate from localStorage after mount (avoids SSR mismatch).
  React.useEffect(() => {
    setSpaceState(readSpace());
  }, []);

  // Cross-tab sync.
  React.useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === SPACE_STORAGE_KEY) setSpaceState(readSpace());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const setSpace = React.useCallback((s: SpaceId) => {
    setSpaceState(s);
    try {
      window.localStorage.setItem(SPACE_STORAGE_KEY, s);
    } catch {
      /* no-op */
    }
  }, []);

  return { space, setSpace };
}

/** Read the current space synchronously (client only). Useful for nav filtering. */
export function getSpace(): SpaceId {
  return readSpace();
}

/**
 * Decide whether a nav item is visible in the current (space, role) pair.
 * Marketing items are hidden in admin-crm mode; admin items are hidden in
 * marketing mode. "both" exposes every item (subject to existing role gating).
 */
export function isItemVisible(item: { spaces?: SpaceId[] } | undefined, space: SpaceId): boolean {
  if (!item) return true;
  if (space === "both") return true;
  const allowed = (item as { spaces?: SpaceId[] }).spaces;
  if (!allowed || allowed.length === 0) return true;
  return allowed.includes(space);
}
