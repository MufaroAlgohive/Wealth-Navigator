import type { ReactNode } from "react";

import { PlatformShell } from "@/components/platform/platform-shell";
import { DevMockBanner } from "@/components/oems/primitives/dev-mock-banner";

/** Desk surface — renders inside the unified platform shell (one app). */
export default function OEMSLayout({ children }: { children: ReactNode }) {
  return <PlatformShell banner={<DevMockBanner />}>{children}</PlatformShell>;
}
