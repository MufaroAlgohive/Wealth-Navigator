// Static fallback for JSE trading-day detection.
//
// The `jse_trading_calendar` table is the authoritative source whenever it has a row for a
// given date (an explicit `is_trading_day: false` row means an observed closure and must be
// respected even if this static list disagrees). But when the table simply has NO row for a
// date — a data-completeness gap, not an actual market closure — callers must not treat that
// as "not a trading day": doing so silently produces an empty, unexplained result set. This
// mirrors the MINT consumer app's `isJseTradingDay()` fallback (server/index.cjs), ported to
// TypeScript rather than copied verbatim.
//
// Keep this list in sync with MINT's `JSE_HOLIDAYS` (server/index.cjs) when JSE holidays are
// announced for new years.
const JSE_HOLIDAYS = new Set([
  // 2025
  "2025-01-01",
  "2025-03-21",
  "2025-04-18",
  "2025-04-21",
  "2025-04-28",
  "2025-05-01",
  "2025-06-16",
  "2025-08-09",
  "2025-09-24",
  "2025-12-16",
  "2025-12-25",
  "2025-12-26",
  // 2026
  "2026-01-01",
  "2026-03-21",
  "2026-04-03",
  "2026-04-06",
  "2026-04-27",
  "2026-05-01",
  "2026-06-16",
  "2026-08-10",
  "2026-09-24",
  "2026-12-16",
  "2026-12-25",
  "2026-12-26",
  // 2027
  "2027-01-01",
  "2027-03-21",
  "2027-03-26",
  "2027-03-29",
  "2027-04-27",
  "2027-05-01",
  "2027-06-16",
  "2027-08-09",
  "2027-09-24",
  "2027-12-16",
  "2027-12-27",
]);

/** Static weekday + hardcoded-holiday-list check. Used only as a fallback when the DB calendar
 * table has no row for the requested date. */
export function isJseTradingDayStatic(dateStr: string): boolean {
  const d = new Date(`${dateStr}T12:00:00Z`);
  const dow = d.getUTCDay(); // 0=Sun, 6=Sat
  if (dow === 0 || dow === 6) return false;
  if (JSE_HOLIDAYS.has(dateStr)) return false;
  return true;
}

export type JseCalendarLookup = { is_trading_day: boolean } | null;

/**
 * Resolve whether `asOf` is a JSE trading day, given a `jse_trading_calendar` lookup result
 * (`calendarRow` is the row's data, or null/undefined when no row exists for the date).
 *
 * - Explicit calendar row present -> the calendar's `is_trading_day` is authoritative.
 * - No calendar row -> fall back to the static weekday + holiday-list check, and say so.
 */
export function resolveJseTradingDay(
  asOf: string,
  calendarRow: JseCalendarLookup,
): { isTradingDay: boolean; source: "calendar" | "static_fallback" } {
  if (calendarRow) {
    return { isTradingDay: calendarRow.is_trading_day === true, source: "calendar" };
  }
  return { isTradingDay: isJseTradingDayStatic(asOf), source: "static_fallback" };
}
