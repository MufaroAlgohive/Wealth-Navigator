// JSE 2026 holiday calendar (settlement rolls automatically per IRESS).
// Source: JSE trading hours documentation.

export const JSE_HOLIDAYS_2026 = [
  "2026-01-01", // New Year's Day
  "2026-03-20", // Human Rights Day
  "2026-04-03", // Good Friday
  "2026-04-06", // Family Day
  "2026-04-27", // Freedom Day (observed Mon)
  "2026-05-01", // Workers' Day
  "2026-06-16", // Youth Day
  "2026-08-10", // Women's Day (observed Mon)
  "2026-09-24", // Heritage Day (observed Thu)
  "2026-12-16", // Day of Reconciliation
  "2026-12-25", // Christmas Day
  "2026-12-28", // Day of Goodwill (observed Mon)
];

export function isJseHoliday(d: Date): boolean {
  const iso = d.toISOString().slice(0, 10);
  return JSE_HOLIDAYS_2026.includes(iso);
}

export function isJseOpen(d = new Date()): boolean {
  if (isJseHoliday(d)) return false;
  const day = d.getDay();
  if (day === 0 || day === 6) return false;
  const hour = d.getHours();
  const minute = d.getMinutes();
  const mins = hour * 60 + minute;
  // JSE continuous trading: 09:00 – 17:00 SAST (with pre-open 07:30, closing auction 16:50–17:00)
  return mins >= 9 * 60 && mins < 17 * 60;
}
