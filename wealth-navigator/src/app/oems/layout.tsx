import type { ReactNode } from "react";

import { PlatformShell } from "@/components/platform/platform-shell";

/** Desk surface — renders inside the unified platform shell (one app). The
 *  DEV·MOCK safety banner is mounted globally inside PlatformShell. */
export default function OEMSLayout({ children }: { children: ReactNode }) {
  return <PlatformShell>{children}</PlatformShell>;
}
