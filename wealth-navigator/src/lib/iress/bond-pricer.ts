/**
 * ZAR fixed-coupon government-bond pricer.
 *
 * IRESS gives us the YTM only (TimeSeriesGet2 ClosePrice on YFX/YFXD) — no
 * clean/dirty price, duration, DV01 or convexity. This module computes those
 * analytics from the YTM + the bond's terms (coupon, maturity), so the
 * fixed-income blotter can show a full row.
 *
 * Convention (standard JSE/BESA semi-annual govt bond):
 *   - Semi-annual coupons; coupon dates fall on the maturity day/month and six
 *     months prior.
 *   - Semi-annual compounding of the yield.
 *   - All-in (dirty) price via broken-period discounting; clean = dirty −
 *     accrued; accrued interest on an ACT/365 basis.
 *   - The "books-closed" (ex-interest) period in the ~10 business days before a
 *     coupon is NOT modelled (a small accrued refinement) — flagged here so the
 *     simplification is explicit. All figures are per 100 nominal.
 *
 * Pure + deterministic given an explicit settlement date — unit-tested in
 * `src/__tests__/bond-pricer.test.ts`.
 */

export interface BondPriceInputs {
  /** Annual coupon rate in percent, e.g. 8 for an 8% bond. */
  couponPct: number;
  /** Maturity date (ISO YYYY-MM-DD). */
  maturityISO: string;
  /** Settlement date (ISO YYYY-MM-DD). */
  settlementISO: string;
  /** Yield to maturity in percent (annual, semi-annual compounded). */
  ytmPct: number;
}

export interface BondAnalytics {
  cleanPrice: number; // per 100 nominal
  dirtyPrice: number; // per 100 nominal (all-in)
  accruedInterest: number; // per 100 nominal
  macaulayYears: number;
  modDuration: number; // years
  /** Price change (Rands per 100 nominal) for a 1bp yield move. */
  dv01: number;
  convexity: number; // years^2
  /** Number of remaining coupons priced. */
  couponsRemaining: number;
}

const MS_PER_DAY = 86_400_000;

/** Parse an ISO date (YYYY-MM-DD) to a UTC Date at midnight. */
function parseISO(iso: string): Date {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return new Date(Date.UTC(y ?? 2000, (m ?? 1) - 1, d ?? 1));
}

function daysBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / MS_PER_DAY);
}

/** Shift a UTC date by `months`, clamping the day to the target month's end. */
function addMonthsClamped(date: Date, months: number): Date {
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth() + months;
  const day = date.getUTCDate();
  const targetYear = y + Math.floor(m / 12);
  const targetMonth = ((m % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  return new Date(Date.UTC(targetYear, targetMonth, Math.min(day, lastDay)));
}

/**
 * Coupon schedule on/after `from`, derived from the maturity date by stepping
 * back in 6-month increments. Returns the remaining coupon dates strictly after
 * settlement, plus the last coupon date on/before settlement (LCD) and the next
 * coupon date (NCD).
 */
function couponSchedule(maturity: Date, settlement: Date): { remaining: Date[]; lcd: Date; ncd: Date } {
  // Walk back from maturity until we're at/just before settlement.
  const dates: Date[] = [];
  let d = maturity;
  // Guard against pathological inputs (cap at 120 semi-annual periods = 60y).
  for (let i = 0; i < 120 && d.getTime() > settlement.getTime(); i++) {
    dates.push(d);
    d = addMonthsClamped(d, -6);
  }
  // `d` is now the last coupon date on/before settlement (LCD); the previous
  // step is the next coupon date (NCD).
  const lcd = d;
  const remaining = dates.reverse(); // ascending, all > settlement
  const ncd = remaining[0] ?? maturity;
  return { remaining, lcd, ncd };
}

/**
 * Price a ZAR semi-annual govt bond from its yield. Returns null when the
 * inputs are unusable (e.g. already matured, non-finite yield).
 */
export function priceBondFromYield(inputs: BondPriceInputs): BondAnalytics | null {
  const { couponPct, maturityISO, settlementISO, ytmPct } = inputs;
  const maturity = parseISO(maturityISO);
  const settlement = parseISO(settlementISO);
  if (
    !Number.isFinite(couponPct) ||
    !Number.isFinite(ytmPct) ||
    ytmPct <= -100 ||
    maturity.getTime() <= settlement.getTime()
  ) {
    return null;
  }

  const couponPerPeriod = couponPct / 2; // per 100 nominal
  const i = ytmPct / 100 / 2; // per-period yield
  const z = 1 / (1 + i);

  const { remaining, lcd, ncd } = couponSchedule(maturity, settlement);
  const n = remaining.length;
  if (n === 0) return null;

  // Fraction of the current coupon period still remaining (broken period).
  const periodDays = Math.max(1, daysBetween(lcd, ncd));
  const f = Math.min(1, Math.max(0, daysBetween(settlement, ncd) / periodDays));

  // Discount each cashflow at t = f + (k) periods, k = 0..n-1.
  let dirty = 0;
  let macaulayPeriods = 0;
  let convexitySum = 0;
  for (let k = 0; k < n; k++) {
    const isLast = k === n - 1;
    const cf = couponPerPeriod + (isLast ? 100 : 0);
    const tPeriods = f + k;
    const pv = cf * z ** tPeriods;
    dirty += pv;
    macaulayPeriods += tPeriods * pv;
    convexitySum += tPeriods * (tPeriods + 1) * pv;
  }
  if (dirty <= 0) return null;

  // Accrued interest, ACT/365 on the annual coupon (SA convention).
  const daysAccrued = Math.max(0, daysBetween(lcd, settlement));
  const accruedInterest = (couponPct * daysAccrued) / 365;
  const cleanPrice = dirty - accruedInterest;

  const macaulayYears = macaulayPeriods / dirty / 2;
  const modDuration = macaulayYears / (1 + i);
  const dv01 = modDuration * dirty * 0.0001;
  // Convexity in years^2: Σ t(t+1)·PV / (P·(1+i)^2) then /m^2.
  const convexity = convexitySum / (dirty * (1 + i) ** 2) / 4;

  return {
    cleanPrice: round(cleanPrice, 5),
    dirtyPrice: round(dirty, 5),
    accruedInterest: round(accruedInterest, 5),
    macaulayYears: round(macaulayYears, 4),
    modDuration: round(modDuration, 4),
    dv01: round(dv01, 5),
    convexity: round(convexity, 4),
    couponsRemaining: n,
  };
}

function round(v: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(v * f) / f;
}

/**
 * Parse a JSE govt-bond `SecurityDescription` into coupon + maturity.
 * Examples seen live (SecuritySearchGet):
 *   "REPUBLIC OF SA 8% 31.01.2030"      → { couponPct: 8,     maturityISO: 2030-01-31 }
 *   "REPUBLIC OF SA 8.875% 28.02.2035"  → { couponPct: 8.875, maturityISO: 2035-02-28 }
 *   "I2033 - RSA 1.875% 2033"           → { couponPct: 1.875, maturityISO: null }
 * Returns nulls for fields it can't extract.
 */
export function parseBondDescription(desc: string): { couponPct: number | null; maturityISO: string | null } {
  const couponMatch = desc.match(/(\d+(?:\.\d+)?)\s*%/);
  const couponPct = couponMatch ? Number(couponMatch[1]) : null;
  // DD.MM.YYYY (preferred — full maturity date).
  const dmy = desc.match(/(\d{2})\.(\d{2})\.(\d{4})/);
  let maturityISO: string | null = null;
  if (dmy) {
    maturityISO = `${dmy[3]}-${dmy[2]}-${dmy[1]}`;
  }
  return { couponPct, maturityISO };
}
