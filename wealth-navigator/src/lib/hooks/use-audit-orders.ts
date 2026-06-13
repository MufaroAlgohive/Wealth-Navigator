"use client";

import { useQuery } from "@tanstack/react-query";
import type { Order, OrderState } from "@/types/iress";
import { isRealDataOnlyClient } from "@/lib/data-policy";
import { queryOpts } from "@/lib/store/query-provider";
import type { BffUnavailableReason } from "@/lib/bff-reasons";

interface OrdersResponse {
  orders: Order[];
  count: number;
  source: "supabase" | "unavailable";
  reason?: BffUnavailableReason;
  migration?: string;
  error?: string;
}

async function fetchAuditOrders(state?: OrderState | "ALL"): Promise<OrdersResponse> {
  const params = new URLSearchParams();
  if (state && state !== "ALL") params.set("state", state);
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
 * seed. Audit #36.
 */
export function useAuditOrders(state?: OrderState | "ALL", enabled = true) {
  const realDataOnly = isRealDataOnlyClient();
  return useQuery({
    queryKey: ["audit-orders", state ?? "ALL"],
    queryFn: () => fetchAuditOrders(state),
    enabled: enabled && realDataOnly,
    ...queryOpts("live"),
  });
}
