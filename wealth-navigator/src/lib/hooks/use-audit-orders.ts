"use client";

import { useQuery } from "@tanstack/react-query";
import type { Order, OrderState } from "@/types/iress";
import { isRealDataOnlyClient } from "@/lib/data-policy";
import { queryOpts } from "@/lib/store/query-provider";
import type { BffUnavailableReason } from "@/lib/bff-reasons";
import type { BlotterScope } from "@/lib/orders/blotter-filters";

interface OrdersResponse {
  orders: Order[];
  count: number;
  source: "supabase" | "unavailable";
  reason?: BffUnavailableReason;
  migration?: string;
  error?: string;
  scope: BlotterScope;
}

async function fetchAuditOrders(state?: OrderState | "ALL", scope: BlotterScope = "LIVE"): Promise<OrdersResponse> {
  const params = new URLSearchParams();
  if (state && state !== "ALL") params.set("state", state);
  params.set("scope", scope);
  const res = await fetch(`/api/orders?${params.toString()}`);
  const data = (await res.json()) as OrdersResponse;
  if (!res.ok) throw new Error(data.error ?? `orders ${res.status}`);
  return data;
}

/**
 * Audit orders from `oems_order_audit` when real-data mode is on.
 *
 * The second arg is **not** React Query's `enabled` (use the call-site
 * wrapper to gate by route, not by query). It is the "real-data-only"
 * gate: when the client is in mock mode we don't fire this query at
 * all, and the `seedOrdersQ` in the page picks up the deterministic
 * seed. UAT is allowed to request the real audit tape even when the surrounding
 * client is in demo mode, because the scope itself is explicitly test-only.
 * Audit #36.
 */
export function useAuditOrders(
  state?: OrderState | "ALL",
  enabled = true,
  scope: BlotterScope = "LIVE",
) {
  const realDataOnly = isRealDataOnlyClient();
  return useQuery({
    queryKey: ["audit-orders", scope, state ?? "ALL"],
    queryFn: () => fetchAuditOrders(state, scope),
    enabled: enabled && (realDataOnly || scope === "UAT"),
    ...queryOpts("live"),
  });
}
