/**
 * Worker bond-universe sync → `bonds_c`.
 *
 * IRESS gives us the bond YTM (TimeSeriesGet2 on YFX/YFXD) and reference terms
 * (SecuritySearchGet: coupon + maturity + ISIN + name). We compute the price
 * analytics (clean/dirty, modified duration, DV01, convexity) with the
 * `bond-pricer` module and upsert one row per bond into `bonds_c` (PK = ISIN).
 *
 * Scope: NOMINAL ZAR govt bonds only. The pricer is exact for fixed-coupon
 * nominal bonds; inflation-linked bonds (I-series) need the CPI index ratio
 * (not in this feed), so they stay yield-only in the ZAR_REAL curve and are
 * deliberately NOT priced here — better an honest omission than a wrong ILB
 * price. Terms are immutable, so they're fetched once per worker lifetime and
 * cached; only the YTM is re-fetched each cycle.
 */

import { getIressClient } from "../../../src/lib/iress/index";
import { isIressSessionDeadError } from "../../../src/lib/iress/errors";
import { priceBondFromYield, parseBondDescription } from "../../../src/lib/iress/bond-pricer";
import type { WorkerEnv } from "./env";
import type { WorkerSessionManager } from "./session";
import type { WorkerSupabase } from "./supabase";

function newRequestID(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

interface BondTerms {
  isin: string;
  name: string;
  couponPct: number;
  maturityISO: string;
}

interface BondUpsertRow {
  isin: string;
  bond_code: string;
  name: string;
  issuer: string;
  coupon_pct: number;
  maturity_date: string;
  ytm_pct: number;
  clean_price: number;
  dirty_price: number;
  mod_duration: number;
  dv01_cents: number;
  convexity: number;
  spread_bp: number | null;
  rating: string | null;
  liquidity: string;
  payload: Record<string, unknown>;
  updated_at: string;
}

// Immutable reference terms — fetched once per worker lifetime per code.
const termsCache = new Map<string, BondTerms | null>();

async function fetchBondTerms(sessions: WorkerSessionManager, code: string): Promise<BondTerms | null> {
  if (termsCache.has(code)) return termsCache.get(code) ?? null;
  let terms: BondTerms | null = null;
  await sessions.withSession(async (session) => {
    const client = getIressClient("live");
    const res = await client.securitySearchGet({
      Header: { SessionKey: session.iressSessionKey, RequestID: newRequestID(`sec-${code}`), Timeout: 25 },
      SearchText: code,
    });
    // The actual bond is SecurityType 401 with the matching code + a real ISIN.
    const row = res.DataRows.find(
      (r) => String(r.SecurityCode).toUpperCase() === code.toUpperCase() && Number(r.SecurityType) === 401,
    );
    if (!row) return;
    const isin = typeof row.ISIN === "string" ? row.ISIN.trim() : "";
    const desc = typeof row.SecurityDescription === "string" ? row.SecurityDescription : "";
    const { couponPct, maturityISO } = parseBondDescription(desc);
    if (!isin || couponPct == null || !maturityISO) return; // need all three to price
    terms = {
      isin,
      name: desc || code,
      couponPct,
      maturityISO,
    };
  });
  termsCache.set(code, terms);
  return terms;
}

async function fetchLatestYtm(sessions: WorkerSessionManager, code: string, exchange: string, dataSource: string): Promise<number | null> {
  let ytm: number | null = null;
  await sessions.withSession(async (session) => {
    const client = getIressClient("live");
    const to = new Date();
    const from = new Date(to.getTime() - 14 * 86_400_000);
    const res = await client.timeSeriesGet2({
      Header: { SessionKey: session.iressSessionKey, RequestID: newRequestID(`ytm-${code}`), Timeout: 30 },
      Code: code,
      Exchange: exchange,
      DataSource: dataSource,
      From: from.toISOString().slice(0, 10),
      To: to.toISOString().slice(0, 10),
      Interval: "Daily",
    });
    const last = res.DataRows[res.DataRows.length - 1];
    // YFX bond yields are decimal fractions (0.0809 = 8.09%) → percent.
    if (last && last.v > 0) ytm = last.v < 1 ? last.v * 100 : last.v;
  });
  return ytm;
}

export interface BondSyncOptions {
  env: WorkerEnv;
  sessions: WorkerSessionManager;
  supabase: WorkerSupabase | null;
  /** Nominal govt-bond codes (defaults to the GOVI basket). */
  codes: string[];
  exchange: string;
  dataSource: string;
}

export interface BondSyncResult {
  priced: number;
  requested: number;
  errors: number;
}

export async function syncBondUniverse(opts: BondSyncOptions): Promise<BondSyncResult> {
  const { env, sessions, supabase, codes, exchange, dataSource } = opts;
  const isLive = env.iressMode === "live" || env.iressMode === "wsdl-stub";
  if (!isLive || codes.length === 0) return { priced: 0, requested: codes.length, errors: 0 };

  const settlementISO = new Date().toISOString().slice(0, 10);
  const rows: BondUpsertRow[] = [];
  let errors = 0;

  for (const code of codes) {
    try {
      const terms = await fetchBondTerms(sessions, code);
      if (!terms) continue;
      const ytmPct = await fetchLatestYtm(sessions, code, exchange, dataSource);
      if (ytmPct == null) continue;
      const a = priceBondFromYield({ couponPct: terms.couponPct, maturityISO: terms.maturityISO, settlementISO, ytmPct });
      if (!a) continue;
      rows.push({
        isin: terms.isin,
        bond_code: code,
        name: terms.name,
        issuer: "Republic of South Africa",
        coupon_pct: terms.couponPct,
        maturity_date: terms.maturityISO,
        ytm_pct: Number(ytmPct.toFixed(4)),
        clean_price: a.cleanPrice,
        dirty_price: a.dirtyPrice,
        mod_duration: a.modDuration,
        dv01_cents: Number((a.dv01 * 100).toFixed(2)), // DV01 (Rands/100 nominal) → cents
        convexity: a.convexity,
        spread_bp: 0, // govt bonds define the curve — spread to self ≈ 0
        rating: null, // sovereign rating is reference data we don't assert here
        liquidity: "high", // GOVI-basket benchmarks are the liquid line
        payload: { accruedInterest: a.accruedInterest, macaulayYears: a.macaulayYears, couponsRemaining: a.couponsRemaining, derivedFrom: "iress-yfx-ytm + bond-pricer" },
        updated_at: new Date().toISOString(),
      });
    } catch (err) {
      if (isIressSessionDeadError(err)) throw err;
      errors += 1;
      console.warn(`[iress-ingest] bond sync(${code}) failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (rows.length === 0) return { priced: 0, requested: codes.length, errors };

  if (!supabase || env.dryRun || !env.allowWrites) {
    console.info(JSON.stringify({ level: "info", event: "would_upsert_bonds_c", count: rows.length, sample: rows.slice(0, 2) }));
    return { priced: rows.length, requested: codes.length, errors };
  }

  const { error } = await supabase.from("bonds_c").upsert(rows, { onConflict: "isin" });
  if (error) {
    console.error(`[iress-ingest] bonds_c upsert failed: ${error.message}`);
    return { priced: 0, requested: codes.length, errors: errors + 1 };
  }
  console.info(JSON.stringify({ level: "info", event: "bonds_c_upserted", count: rows.length }));
  return { priced: rows.length, requested: codes.length, errors };
}
