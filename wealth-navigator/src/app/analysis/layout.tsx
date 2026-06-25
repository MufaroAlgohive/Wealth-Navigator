import type { ReactNode } from "react";

import { PlatformShell } from "@/components/platform/platform-shell";

/** Company Analysis — fiscal.ai-style deep-dive on any ticker, in the one shell. */
export default function AnalysisLayout({ children }: { children: ReactNode }) {
  return <PlatformShell>{children}</PlatformShell>;
}
