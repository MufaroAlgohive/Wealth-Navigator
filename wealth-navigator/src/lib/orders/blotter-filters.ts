import type { Order, OrderState } from "@/types/iress";

export type BlotterStatusFilter = "WORKING" | "FILLED" | "CANCELLED" | "REJECTED";
export type BlotterDateMode = "ALL" | "TODAY" | "YESTERDAY" | "WEEK" | "MONTH" | "DATE" | "YEAR";
export type BlotterScope = "LIVE" | "UAT";

function auditRowIsUat(
  row: { source?: string | null; payload?: Record<string, unknown> | null },
  testUserIds: ReadonlySet<string>,
  testEmails: ReadonlySet<string>,
) {
  const source = String(row.source ?? "").toUpperCase();
  const payload = row.payload ?? {};
  if (source === "UAT_ADHOC_ORDER" || source.endsWith("_UAT")) return true;
  if (payload.uat_test === true) return true;
  const userIds = [
    payload.user_id,
    payload.investor_id,
    payload.owner_user_id,
    payload.recipient_user_id,
    payload.client_id,
  ]
    .map((value) => String(value ?? ""))
    .filter(Boolean);
  if (userIds.some((userId) => testUserIds.has(userId))) return true;
  const emails = [
    payload.client_email,
    payload.trader,
    payload.email,
    payload.investor_email,
    payload.recipient_email,
  ]
    .map((value) => String(value ?? "").trim().toLowerCase())
    .filter(Boolean);
  return emails.some((email) => testEmails.has(email));
}

export function isLiveBlotterAuditRow(
  row: {
    source?: string | null;
    payload?: Record<string, unknown> | null;
  },
  testUserIds: ReadonlySet<string> = new Set(),
  testEmails: ReadonlySet<string> = new Set(),
): boolean {
  return !auditRowIsUat(row, testUserIds, testEmails);
}

export function isUatBlotterAuditRow(
  row: { source?: string | null; payload?: Record<string, unknown> | null },
  testUserIds: ReadonlySet<string> = new Set(),
  testEmails: ReadonlySet<string> = new Set(),
): boolean {
  return auditRowIsUat(row, testUserIds, testEmails);
}

export function matchesBlotterStatus(state: OrderState, selected: ReadonlySet<BlotterStatusFilter>): boolean {
  if (selected.size === 0) return true;
  if (selected.has("WORKING") && (state === "WORKING" || state === "PARTIAL")) return true;
  return selected.has(state as BlotterStatusFilter);
}

export function matchesBlotterDate(ts: number, mode: BlotterDateMode, value: string): boolean {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return false;
  const iso = (d: Date) => [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, "0"),
    String(d.getDate()).padStart(2, "0"),
  ].join("-");
  const day = iso(date);
  if (mode === "ALL") return true;
  if (mode === "TODAY") return day === iso(new Date());
  if (mode === "YESTERDAY") {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    return day === iso(yesterday);
  }
  if (mode === "WEEK") {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - 6);
    return ts >= start.getTime();
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
