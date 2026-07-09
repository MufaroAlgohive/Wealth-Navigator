"use client";

/**
 * Space context — single client-side source of truth for the
 * Admin CRM / Marketing / All-surfaces selector.
 *
 * Thin re-export over `lib/platform/space-switcher` so call-sites in the
 * `lib/admin/*` module tree (and the brief-specified `useSpace()` hook) can
 * import from `@/lib/admin/space-context` without reaching across to the
 * platform module. Keeping the implementation in `space-switcher.tsx`
 * preserves the cross-tab localStorage sync + space-filter helpers already
 * consumed by `PlatformNav`.
 *
 * Per the B7 brief:
 *   - State persists to localStorage (`mint.platform.space`).
 *   - `useSpace()` returns `{ space, setSpace }`.
 *   - Non-admin users are locked to `admin-crm` by the SpaceSwitcher in
 *     `components/oems/shell/top-bar.tsx`; this hook is policy-free and
 *     returns whatever is in localStorage so the consumer can decide.
 */

export {
  type SpaceId,
  SPACE_LABEL,
  SPACE_STORAGE_KEY,
  useSpace,
  getSpace,
  isItemVisible,
} from "@/lib/platform/space-switcher";
