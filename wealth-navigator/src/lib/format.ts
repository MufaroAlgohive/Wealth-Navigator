// Formatting helpers used across the trading desk.
// All money formatting uses the en-ZA locale (ZAR / R prefix, comma grouping).
// Numbers are tabular-nums via CSS — we don't reformat on the data side.

const zar = new Intl.NumberFormat("en-ZA", {
  style: "currency",
  currency: "ZAR",
  maximumFractionDigits: 2,
});

const num = new Intl.NumberFormat("en-ZA", { maximumFractionDigits: 2 });
const num4 = new Intl.NumberFormat("en-ZA", {
  maximumFractionDigits: 4,
  minimumFractionDigits: 4,
});
const int = new Intl.NumberFormat("en-ZA", { maximumFractionDigits: 0 });

export const formatZAR = (n: number) =>
  n >= 1_000_000_000
    ? `R${(n / 1_000_000_000).toFixed(2)}bn`
    : n >= 1_000_000
      ? `R${(n / 1_000_000).toFixed(1)}m`
      : n >= 10_000
        ? `R${(n / 1_000).toFixed(0)}k`
        : zar.format(n);

export const formatZARExact = (n: number) => zar.format(n);

export const formatNumber = (n: number, dp = 2) =>
  dp === 0 ? int.format(n) : num.format(n);

export const formatNumber4 = (n: number) => num4.format(n);

export const formatPct = (n: number, dp = 2) =>
  `${n > 0 ? "+" : ""}${n.toFixed(dp)}%`;

export const formatPctAbs = (n: number, dp = 2) => `${Math.abs(n).toFixed(dp)}%`;

export const formatBps = (n: number, dp = 1) =>
  `${n > 0 ? "+" : ""}${(n * 100).toFixed(dp)}bp`;

export const formatBpsAbs = (n: number, dp = 1) =>
  `${(Math.abs(n) * 100).toFixed(dp)}bp`;

export const formatTime = (d: Date | string | number) => {
  const date = typeof d === "object" ? d : new Date(d);
  return date.toLocaleTimeString("en-ZA", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZone: "Africa/Johannesburg",
  });
};

export const formatTimeShort = (d: Date | string | number) => {
  const date = typeof d === "object" ? d : new Date(d);
  return date.toLocaleTimeString("en-ZA", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Africa/Johannesburg",
  });
};

export const formatDate = (d: Date | string | number) => {
  const date = typeof d === "object" ? d : new Date(d);
  return date.toLocaleDateString("en-ZA", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
};

export const formatDateTime = (d: Date | string | number) =>
  `${formatDate(d)} · ${formatTimeShort(d)} SAST`;

export const formatTenor = (months: number) => {
  if (months < 1) {
    const days = Math.round(months * 30);
    return `${days}d`;
  }
  if (months < 12) return `${Math.round(months)}M`;
  const years = months / 12;
  return Number.isInteger(years) ? `${years}Y` : `${years.toFixed(1)}Y`;
};
