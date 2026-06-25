"use client";

import { FlaskConical } from "lucide-react";
import { isRealDataOnlyClient } from "@/lib/data-policy";

/**
 * The "DEV · MOCK" safety banner. It renders on EVERY build — production
 * included — whenever the mock/seed data path is active, i.e. either `?mock=1`
 * in the URL OR `NEXT_PUBLIC_USE_SUPABASE_QUOTES=0/false` in the environment.
 *
 * The rule is absolute: if any synthetic/seed value can reach the screen, the
 * screen is labelled. There is no configuration — not even a deliberate env flag
 * on a production build — that shows mock data without this banner. It is mounted
 * once in PlatformShell so it covers every surface (desk, admin, analysis, …).
 */
export function DevMockBanner() {
  if (typeof window === "undefined") return null;
  if (isRealDataOnlyClient()) return null; // real-data mode → nothing to flag
  return (
    <div className="flex items-center justify-center gap-2 border-b border-warning/40 bg-warning/10 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-warning">
      <FlaskConical className="h-3.5 w-3.5" />
      DEV · MOCK
      <span className="ml-2 normal-case text-warning/80">
        Synthetic / seed data is active (via <code>?mock=1</code> or{" "}
        <code>NEXT_PUBLIC_USE_SUPABASE_QUOTES=0</code>). This is not live market data.
      </span>
    </div>
  );
}
