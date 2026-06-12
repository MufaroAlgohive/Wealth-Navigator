// Typed IRESS V4 session error codes — see
// Documentation & Vision/iress-v4-docs/06-errors/01-session-error-codes.md

export const IRESS_SESSION_ERRORS = {
  25001: "Invalid login credentials",
  25002: "Invalid locale",
  25003: "Invalid application ID",
  25004: "Application ID already in use",
  25005: "Maximum concurrent sessions reached",
  25006: "Service session expired — rebuild",
  25007: "Invalid service name",
  25008: "Invalid server name",
  25009: "Service session disconnected — rebuild",
  25010: "Method not entitled",
  25011: "Method filter invalid",
  25012: "Invalid session timeout",
  25013: "Invalid session number to kick",
  25014: "Iress session expired — rebuild",
  25015: "Session number to kick is current session",
  25016: "Cannot kick sessions belonging to others",
  25017: "Cannot force close — entitlement required",
  25018: "Invalid input parameter",
  25019: "Server overloaded — back off and retry",
  25020: "Invalid RequestID",
  25021: "Request in progress",
  25022: "Iress session disconnected — rebuild",
  25023: "Service not available",
  25024: "Invalid page size",
  25025: "Invalid paging bookmark",
  25026: "Invalid paging direction",
  25027: "No more pages",
  25028: "Duplicate OrderTag (idempotency guard hit)",
  25029: "Order not found",
  25030: "Order cannot be amended in current state",
  25031: "Order cannot be cancelled in current state",
  25032: "Invalid account code",
  25033: "Service session terminated — rebuild",
  25034: "Entitlement check failed",
  25035: "Rate limit exceeded — slow down",
  666:   "SOAP fault — system error",
} as const;

export type IressErrorCode = keyof typeof IRESS_SESSION_ERRORS;

/** IRESS session is dead — rebuild parent session (and service sessions). */
const IRESS_SESSION_DEAD_CODES = new Set([25014, 25019, 25022]);

/** True when the parent Iress session must be recreated (not a service-only fault). */
export function isIressSessionDeadError(err: unknown): boolean {
  if (typeof err === "object" && err !== null && "code" in err) {
    const code = Number((err as { code: unknown }).code);
    if (IRESS_SESSION_DEAD_CODES.has(code)) return true;
  }
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return msg.includes("logged off") || msg.includes("not logged in");
}

export class IressError extends Error {
  override readonly name = "IressError";
  constructor(
    public code: IressErrorCode | number,
    public readonly method: string,
    message?: string,
  ) {
    super(message ?? IRESS_SESSION_ERRORS[code as IressErrorCode] ?? `IRESS error ${code}`);
  }
}
