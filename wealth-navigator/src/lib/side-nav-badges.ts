export interface SideNavBadgeCounts {
  blotterOrders?: number;
}

/**
 * Resolves side-nav count badges. Seed mode keeps demo counts; real-data mode
 * shows audit order totals for Blotter and hides unconfigured feeds.
 */
export function resolveSideNavBadge(
  route: string,
  realDataOnly: boolean,
  seedBadge: string | number | undefined,
  counts: SideNavBadgeCounts,
): string | number | undefined {
  if (!realDataOnly) return seedBadge;

  if (route === "/oems/blotter" && counts.blotterOrders != null) {
    return counts.blotterOrders;
  }

  return undefined;
}
