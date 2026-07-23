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
    <div
      className="flex items-center justify-center gap-2 border-b border-warning/40 bg-warning/10 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-warning"
      title="Mock mode is on via ?mock=1 or NEXT_PUBLIC_USE_SUPABASE_QUOTES=0. Set the flag to 1 (or remove it) to serve live data."
    >
      <FlaskConical className="h-3.5 w-3.5" />
      Demo mode
      <span className="ml-2 normal-case text-warning/80">
        Live market quotes are switched off in this environment, so price panels show seed values.
        Company analysis and fundamentals are live.
      </span>
    </div>
  );
}
