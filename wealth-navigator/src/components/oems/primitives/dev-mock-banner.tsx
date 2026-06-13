"use client";

import { FlaskConical } from "lucide-react";
import { isMockOverrideActive } from "@/lib/data-policy";

/**
 * Yellow #24 — the visual "DEV · MOCK" banner. Renders when the
 * URL carries `?mock=1` and we're not in a production build.
 * On production Vercel the override is honoured but the banner
 * is suppressed.
 */
export function DevMockBanner() {
  if (typeof window === "undefined") return null;
  if (process.env.NODE_ENV === "production") return null;
  if (!isMockOverrideActive()) return null;
  return (
    <div className="flex items-center justify-center gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-warning">
      <FlaskConical className="h-3.5 w-3.5" />
      DEV · MOCK
      <span className="ml-2 text-warning/80">
        ?mock=1 forced the seed path. Remove the query param to revert to real data.
      </span>
    </div>
  );
}
