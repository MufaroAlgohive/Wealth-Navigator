import type { Order, OrderState } from "@/types/iress";

export type BlotterStatusFilter = "WORKING" | "FILLED" | "CANCELLED" | "REJECTED";
export type BlotterDateMode = "ALL" | "TODAY" | "DATE" | "MONTH" | "YEAR";

export function isLiveBlotterAuditRow(
  row: {
    source?: string | null;
    payload?: Record<string, unknown> | null;
  },
  testUserIds: ReadonlySet<string> = new Set(),
  testEmails: ReadonlySet<string> = new Set(),
): boolean {
  if (String(row.source ?? "").toUpperCase() === "UAT_ADHOC_ORDER") return false;
  const payload = row.payload ?? {};
  if (payload.uat_test === true) return false;
  const userId = String(payload.user_id ?? "");
  if (userId && testUserIds.has(userId)) return false;
  const email = String(payload.client_email ?? payload.trader ?? "")
    .trim()
    .toLowerCase();
  return !email || !testEmails.has(email);
}

export function matchesBlotterStatus(state: OrderState, selected: ReadonlySet<BlotterStatusFilter>): boolean {
  if (selected.size === 0) return true;
  if (selected.has("WORKING") && (state === "WORKING" || state === "PARTIAL")) return true;
  return selected.has(state as BlotterStatusFilter);
}

export function matchesBlotterDate(ts: number, mode: BlotterDateMode, value: string): boolean {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return false;
  const day = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
  if (mode === "ALL") return true;
  if (mode === "TODAY") {
    const now = new Date();
    const today = [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, "0"),
      String(now.getDate()).padStart(2, "0"),
    ].join("-");
    return day === today;
  }
  if (!value) return true;
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
