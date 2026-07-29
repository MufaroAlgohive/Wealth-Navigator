import type { Order, OrderState } from "@/types/iress";

export type BlotterStatusFilter = "WORKING" | "FILLED" | "CANCELLED" | "REJECTED";
export type BlotterDateMode = "ALL" | "DATE" | "MONTH" | "YEAR";

export function isLiveBlotterAuditRow(row: {
  source?: string | null;
  payload?: Record<string, unknown> | null;
}): boolean {
  if (String(row.source ?? "").toUpperCase() === "UAT_ADHOC_ORDER") return false;
  return row.payload?.uat_test !== true;
}

export function matchesBlotterStatus(state: OrderState, selected: ReadonlySet<BlotterStatusFilter>): boolean {
  if (selected.size === 0) return true;
  if (selected.has("WORKING") && (state === "WORKING" || state === "PARTIAL")) return true;
  return selected.has(state as BlotterStatusFilter);
}

export function matchesBlotterDate(ts: number, mode: BlotterDateMode, value: string): boolean {
  if (mode === "ALL" || !value) return true;
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return false;
  const day = date.toISOString().slice(0, 10);
  if (mode === "DATE") return day === value;
  if (mode === "MONTH") return day.slice(0, 7) === value;
  return day.slice(0, 4) === value;
}

export function filterBlotterOrders(
  orders: Order[],
  options: {
    statuses: ReadonlySet<BlotterStatusFilter>;
    dateMode: BlotterDateMode;
    dateValue: string;
    query: string;
  },
): Order[] {
  const query = options.query.trim().toLowerCase();
  return orders.filter(
    (order) =>
      matchesBlotterStatus(order.state, options.statuses) &&
      matchesBlotterDate(order.ts, options.dateMode, options.dateValue) &&
      (query === "" ||
        order.symbol.toLowerCase().includes(query) ||
        order.strategy.toLowerCase().includes(query) ||
        order.id.toLowerCase().includes(query)),
  );
}
