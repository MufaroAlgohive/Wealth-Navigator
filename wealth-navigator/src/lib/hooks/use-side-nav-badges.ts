"use client";

import { useMemo } from "react";
import { isRealDataOnlyClient } from "@/lib/data-policy";
import { useAuditOrders } from "@/lib/hooks/use-audit-orders";
import { resolveSideNavBadge, type SideNavBadgeCounts } from "@/lib/side-nav-badges";

/** Live nav badge counts for SideNav — honest in real-data mode. */
export function useSideNavBadges() {
  const realDataOnly = isRealDataOnlyClient();
  const auditQ = useAuditOrders("ALL", realDataOnly);

  const counts: SideNavBadgeCounts = useMemo(() => {
    if (!realDataOnly) return {};
    return { blotterOrders: auditQ.data?.orders.length ?? undefined };
  }, [realDataOnly, auditQ.data?.orders.length]);

  return { realDataOnly, counts, resolve: (route: string, seedBadge?: string | number) =>
    resolveSideNavBadge(route, realDataOnly, seedBadge, counts) };
}
