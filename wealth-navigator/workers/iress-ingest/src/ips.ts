/**
 * Worker IPS portfolio loop — Tier 4 wiring.
 *
 * Polls IRESS `IPSAccountGetAll1` + `IPSPositionGetAll1` +
 * `IPSTransactionGetByAccount5` and upserts the result into
 * `oems_account_c` / `oems_position_c` / `oems_transaction_c` so the
 * `/api/portfolio` BFF and the OEMS Cockpit can read portfolio state
 * without ever holding the IRESS license seat.
 *
 * The IPS entitlements (`IPSAccountGetAll1`, `IPSPositionGetAll1`,
 * `IPSTransactionGetByAccount5`) are NOT included by default on the
 * production IRESS profile — Charles has to enable them on Charles's
 * account. Until they are on, the loop runs in "entitlement-required"
 * mode and surfaces a structured `ips_entitlement_missing` event each
 * poll so `/oems/integration` can show a precise "what to ask Charles
 * for" message instead of a generic "Data feed not configured".
 *
 * Failure modes (mirror `timeseries.ts`):
 *
 *   1. 25014 / 25008 — entitlement missing or license seat. Loop logs
 *      `ips_entitlement_missing` and skips the round. The next poll
 *      succeeds once Charles flips the entitlement.
 *   2. 25xxx "no data" — IRESS returned no accounts / positions /
 *      transactions (e.g. market closed / new account with no fills).
 *      Loop logs `ips_no_data` and continues; we never fabricate.
 *   3. Network / timeout — retry with exponential back-off up to 3
 *      times before giving up the round.
 *
 * Source-of-truth for the watchlist:
 *   `IRESS_IPS_ACCOUNTS`  (default "" = derive from `IRESS_ACCOUNT_CODE`)
 *   `IRESS_IPS_TX_DAYS`   (default 30 — how many days of transactions
 *                          to pull per account per poll)
 *
 * The `IRESS_ACCOUNT_CODE` env var (set by Charles for the order poll)
 * doubles as the IPS account list when `IRESS_IPS_ACCOUNTS` is unset.
 */

import { getIressClient } from "../../../src/lib/iress/index";
import { IressError, isIressSessionDeadError } from "../../../src/lib/iress/errors";
import type { IPSAccountRow, IPSPositionRow } from "../../../src/lib/iress/client";
import type { WorkerEnv } from "./env";
import type { WorkerSessionManager } from "./session";
import type { WorkerSupabase } from "./supabase";
import { recordWorkerEvent } from "./events";

export interface IpsSyncResult {
  accountsUpserted: number;
  positionsUpserted: number;
  transactionsUpserted: number;
  accountsRequested: number;
  entitlementRequired: boolean;
  errors: number;
}

export interface IpsConfig {
  accounts: string[];
  transactionDays: number;
  intervalSec: number;
}

export function loadIpsConfig(env: WorkerEnv): IpsConfig {
  // Pull from `IRESS_IPS_ACCOUNTS` if set; otherwise derive from
  // `IRESS_ACCOUNT_CODE` (the same comma-list the order poll uses) so
  // there's only one knob for Charles to turn.
  const raw = (process.env.IRESS_IPS_ACCOUNTS ?? env.iressAccountCode ?? "")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  return {
    accounts: raw,
    transactionDays: Math.max(1, Number(process.env.IRESS_IPS_TX_DAYS ?? "30")),
    intervalSec: Math.max(60, Number(process.env.IRESS_WORKER_IPS_INTERVAL_SEC ?? "300")),
  };
}

function newRequestID(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function parseDateOnly(value: string | undefined): string {
  // DateFrom/DateTo for IPSTransactionGetByAccount5 want YYYY-MM-DD
  // (no time component). Default to 30 days back when the caller doesn't
  // supply one.
  if (!value) {
    const d = new Date();
    return d.toISOString().slice(0, 10);
  }
  return value.slice(0, 10);
}

function toNumberOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function toNumber(v: unknown, fallback = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function toIsoString(v: unknown): string {
  if (!v) return new Date().toISOString();
  return String(v);
}

function recordEntitlementMissing(method: string, code: number): void {
  const event = "ips_entitlement_missing";
  const msg = `${method} entitlement required (IRESS error ${code}). Ask Charles to enable ${method} on the production IRESS profile.`;
  console.warn(
    JSON.stringify({
      level: "warn",
      event,
      source: "iress-worker",
      method,
      code,
      msg,
    }),
  );
  recordWorkerEvent({
    level: "warn",
    event,
    msg,
    data: { method, code, what: `Ask Charles to enable ${method} on production IRESS profile` },
  });
}

function recordNoData(method: string, accountCode: string): void {
  const event = "ips_no_data";
  const msg = `${method} returned no rows for ${accountCode} — likely no entitlement, no holdings, or the account is new.`;
  console.warn(
    JSON.stringify({
      level: "warn",
      event,
      source: "iress-worker",
      method,
      accountCode,
      msg,
    }),
  );
  recordWorkerEvent({
    level: "warn",
    event,
    msg,
    data: { method, accountCode },
  });
}

interface IressErrorLike {
  code?: number;
  message?: string;
}

function isEntitlementError(err: unknown): number | null {
  if (err instanceof IressError) {
    if (err.code === 25014 || err.code === 25008) return err.code;
  }
  const e = err as IressErrorLike;
  const msg = String(e?.message ?? err ?? "");
  if (msg.includes("25014") || msg.toLowerCase().includes("not entitled")) return 25014;
  if (msg.includes("25008") || msg.toLowerCase().includes("license seat")) return 25008;
  return null;
}

export interface IpsSyncOptions {
  env: WorkerEnv;
  config: IpsConfig;
  sessions: WorkerSessionManager;
  supabase: WorkerSupabase | null;
}

/**
 * Run one IPS poll cycle. Mirrors the public shape of `syncTimeSeries`
 * so `main.ts` can call it from a loop.
 */
export async function syncIps(opts: IpsSyncOptions): Promise<IpsSyncResult> {
  const { env, config, sessions, supabase } = opts;
  // Yellow #18 — measure wall-clock for the latency chart. The
  // integration page's `buildLatencySeries` reads `data.elapsedMs`.
  const t0 = Date.now();
  const isLive = env.iressMode === "live" || env.iressMode === "wsdl-stub";

  let accountsUpserted = 0;
  let positionsUpserted = 0;
  let transactionsUpserted = 0;
  let errors = 0;
  let entitlementRequired = false;
  let observedAccounts: string[] = [];

  if (config.accounts.length === 0) {
    return {
      accountsUpserted: 0,
      positionsUpserted: 0,
      transactionsUpserted: 0,
      accountsRequested: 0,
      entitlementRequired: false,
      errors: 0,
    };
  }

  // ── 1. Accounts ──────────────────────────────────────────────────────
  let accountRows: IPSAccountRow[] = [];
  if (isLive) {
    try {
      await sessions.withSession(async (session) => {
        const iosKey = session.serviceKeys?.IPS ?? session.serviceKeys?.IOSPlus;
        if (!iosKey) {
          throw new Error("IPS service session not available for IPSAccountGetAll1");
        }
        const client = getIressClient("live");
        const res = await client.ipsAccountGetAll1({
          ServiceSessionKey: iosKey,
          PageSize: 500,
        });
        if (res.Header?.ErrorNumber === 25014 || res.Header?.ErrorNumber === 25008) {
          entitlementRequired = true;
          recordEntitlementMissing("IPSAccountGetAll1", res.Header.ErrorNumber);
          return;
        }
        accountRows = res.DataRows ?? [];
      });
    } catch (err) {
      if (isIressSessionDeadError(err)) throw err;
      const code = isEntitlementError(err);
      if (code) {
        entitlementRequired = true;
        recordEntitlementMissing("IPSAccountGetAll1", code);
      } else {
        errors += 1;
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[iress-ingest] IPSAccountGetAll1 failed: ${msg}`);
      }
    }
  } else {
    // Mock path — `mockIressClient.ipsAccountGetAll1` returns the seed.
    try {
      const { mockIressClient } = await import("../../../src/lib/iress/mock");
      const res = await mockIressClient.ipsAccountGetAll1({
        ServiceSessionKey: "MOCK",
        PageSize: 500,
      });
      accountRows = (res.DataRows ?? []) as IPSAccountRow[];
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[iress-ingest] mock IPSAccountGetAll1 failed: ${msg}`);
    }
  }

  if (accountRows.length === 0 && !entitlementRequired) {
    recordNoData("IPSAccountGetAll1", "(all)");
  }

  if (accountRows.length > 0) {
    if (env.dryRun || !env.allowWrites || !supabase) {
      console.info(
        JSON.stringify({
          level: "info",
          event: "would_upsert_oems_account_c",
          count: accountRows.length,
          sample: accountRows.slice(0, 3).map((r) => r.AccountCode),
        }),
      );
    } else {
      const rows = accountRows.map((a) => ({
        account_code: a.AccountCode,
        account_name: a.AccountName ? String(a.AccountName) : null,
        account_type: a.AccountType ? String(a.AccountType) : null,
        currency: a.Currency ? String(a.Currency) : null,
        base_currency: a.BaseCurrency ? String(a.BaseCurrency) : null,
        beneficiary: a.Beneficiary ? String(a.Beneficiary) : null,
        account_status: a.AccountStatus ? String(a.AccountStatus) : null,
        open_date: a.OpenDate ? String(a.OpenDate) : null,
        nav_value: toNumberOrNull(a.NetAssetValue ?? a.NAV),
        cash_balance: toNumberOrNull(a.CashBalance),
        payload: a,
        updated_at: new Date().toISOString(),
      }));
      const { error } = await supabase
        .from("oems_account_c")
        .upsert(rows, { onConflict: "account_code" });
      if (error) {
        errors += 1;
        console.warn(`[iress-ingest] oems_account_c upsert failed: ${error.message}`);
      } else {
        accountsUpserted = rows.length;
        observedAccounts = rows.map((r) => r.account_code);
      }
    }
  }

  // If accounts came back from IRESS, use them. Otherwise fall back to
  // the configured list so we still pull positions/transactions for the
  // explicitly-configured accounts.
  const accountsToPoll =
    observedAccounts.length > 0
      ? observedAccounts
      : config.accounts.map((a) => a.toUpperCase());

  // ── 2. Positions (per account) ───────────────────────────────────────
  for (const accountCode of accountsToPoll) {
    let positionRows: IPSPositionRow[] = [];
    if (isLive) {
      try {
        await sessions.withSession(async (session) => {
          const iosKey = session.serviceKeys?.IPS ?? session.serviceKeys?.IOSPlus;
          if (!iosKey) {
            throw new Error("IPS service session not available for IPSPositionGetAll1");
          }
          const client = getIressClient("live");
          const res = await client.ipsPositionGetAll1({
            ServiceSessionKey: iosKey,
            AccountCode: accountCode,
            PageSize: 500,
          });
          if (res.Header?.ErrorNumber === 25014 || res.Header?.ErrorNumber === 25008) {
            entitlementRequired = true;
            recordEntitlementMissing("IPSPositionGetAll1", res.Header.ErrorNumber);
            return;
          }
          positionRows = res.DataRows ?? [];
        });
      } catch (err) {
        if (isIressSessionDeadError(err)) throw err;
        const code = isEntitlementError(err);
        if (code) {
          entitlementRequired = true;
          recordEntitlementMissing("IPSPositionGetAll1", code);
          break;
        }
        errors += 1;
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[iress-ingest] IPSPositionGetAll1(${accountCode}) failed: ${msg}`);
      }
    } else {
      // Mock path — the seed has positions attributed to the trading
      // account. Skip per-account filtering in the mock by passing
      // `AccountCode` so the cursor still kicks in cleanly.
      try {
        const { mockIressClient } = await import("../../../src/lib/iress/mock");
        const res = await mockIressClient.ipsPositionGetAll1({
          ServiceSessionKey: "MOCK",
          AccountCode: accountCode,
          PageSize: 500,
        });
        positionRows = (res.DataRows ?? []) as IPSPositionRow[];
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[iress-ingest] mock IPSPositionGetAll1(${accountCode}) failed: ${msg}`);
      }
    }

    if (positionRows.length === 0 && !entitlementRequired) {
      recordNoData("IPSPositionGetAll1", accountCode);
    }

    if (positionRows.length > 0) {
      if (env.dryRun || !env.allowWrites || !supabase) {
        console.info(
          JSON.stringify({
            level: "info",
            event: "would_upsert_oems_position_c",
            accountCode,
            count: positionRows.length,
          }),
        );
      } else {
        const rows = positionRows.map((p) => ({
          account_code: p.AccountCode ?? accountCode,
          security_code: p.SecurityCode,
          exchange: p.Exchange ? String(p.Exchange) : null,
          quantity: toNumber(p.Quantity, 0),
          open_average_price: toNumberOrNull(p.OpenAveragePrice),
          market_value: toNumberOrNull(p.MarketValue),
          open_pl: toNumberOrNull(p.OpenPL ?? p.OpenProfitLoss),
          currency: p.Currency ? String(p.Currency) : null,
          open_date: p.OpenDate ? String(p.OpenDate) : null,
          payload: p,
          updated_at: new Date().toISOString(),
        }));
        const { error } = await supabase
          .from("oems_position_c")
          .upsert(rows, { onConflict: "account_code,security_code" });
        if (error) {
          errors += 1;
          console.warn(`[iress-ingest] oems_position_c upsert(${accountCode}) failed: ${error.message}`);
        } else {
          positionsUpserted += rows.length;
        }
      }
    }
  }

  // ── 3. Transactions (per account) ───────────────────────────────────
  const dateTo = parseDateOnly(new Date().toISOString());
  const dateFromDate = new Date(Date.now() - config.transactionDays * 86_400_000);
  const dateFrom = parseDateOnly(dateFromDate.toISOString());

  for (const accountCode of accountsToPoll) {
    let txRows: Array<{
      TransactionNumber: string;
      Date: string;
      Type: string;
      Symbol: string;
      Quantity: number;
      Price: number;
      Amount: number;
      Currency: string;
    }> = [];
    if (isLive) {
      try {
        await sessions.withSession(async (session) => {
          const iosKey = session.serviceKeys?.IPS ?? session.serviceKeys?.IOSPlus;
          if (!iosKey) {
            throw new Error("IPS service session not available for IPSTransactionGetByAccount5");
          }
          const client = getIressClient("live");
          const res = await client.ipsTransactionGetByAccount5({
            ServiceSessionKey: iosKey,
            AccountCode: accountCode,
            DateFrom: dateFrom,
            DateTo: dateTo,
          });
          if (res.Header?.ErrorNumber === 25014 || res.Header?.ErrorNumber === 25008) {
            entitlementRequired = true;
            recordEntitlementMissing("IPSTransactionGetByAccount5", res.Header.ErrorNumber);
            return;
          }
          txRows = (res.DataRows ?? []) as typeof txRows;
        });
      } catch (err) {
        if (isIressSessionDeadError(err)) throw err;
        const code = isEntitlementError(err);
        if (code) {
          entitlementRequired = true;
          recordEntitlementMissing("IPSTransactionGetByAccount5", code);
          break;
        }
        errors += 1;
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[iress-ingest] IPSTransactionGetByAccount5(${accountCode}) failed: ${msg}`);
      }
    } else {
      try {
        const { mockIressClient } = await import("../../../src/lib/iress/mock");
        const res = await mockIressClient.ipsTransactionGetByAccount5({
          ServiceSessionKey: "MOCK",
          AccountCode: accountCode,
          DateFrom: dateFrom,
          DateTo: dateTo,
        });
        txRows = (res.DataRows ?? []) as typeof txRows;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[iress-ingest] mock IPSTransactionGetByAccount5(${accountCode}) failed: ${msg}`);
      }
    }

    if (txRows.length === 0 && !entitlementRequired) {
      recordNoData("IPSTransactionGetByAccount5", accountCode);
    }

    if (txRows.length > 0) {
      if (env.dryRun || !env.allowWrites || !supabase) {
        console.info(
          JSON.stringify({
            level: "info",
            event: "would_upsert_oems_transaction_c",
            accountCode,
            count: txRows.length,
            sample: txRows.slice(0, 3).map((t) => t.TransactionNumber),
          }),
        );
      } else {
        const rows = txRows.map((t) => ({
          transaction_number: t.TransactionNumber,
          account_code: accountCode,
          tx_date: t.Date ? String(t.Date).slice(0, 10) : null,
          tx_type: t.Type,
          security_code: t.Symbol,
          quantity: toNumberOrNull(t.Quantity),
          price: toNumberOrNull(t.Price),
          amount: toNumberOrNull(t.Amount),
          currency: t.Currency ?? "ZAR",
          payload: t,
          ingested_at: toIsoString(t.Date),
        }));
        const { error } = await supabase
          .from("oems_transaction_c")
          .upsert(rows, { onConflict: "transaction_number" });
        if (error) {
          errors += 1;
          console.warn(`[iress-ingest] oems_transaction_c upsert(${accountCode}) failed: ${error.message}`);
        } else {
          transactionsUpserted += rows.length;
        }
      }
    }
  }

  // Yellow #18 — surface elapsedMs in the IPS sync-complete event so
  // the integration page's latency chart picks up the IPS cycle.
  const elapsedMs = Date.now() - t0;
  recordWorkerEvent({
    level: errors > 0 || entitlementRequired ? "warn" : "info",
    event: "ips_sync_complete",
    msg: `IPS sync: ${accountsUpserted} accounts / ${positionsUpserted} positions / ${transactionsUpserted} transactions (${elapsedMs}ms)`,
    data: {
      accountsUpserted,
      positionsUpserted,
      transactionsUpserted,
      accountsRequested: accountsToPoll.length,
      entitlementRequired,
      errors,
      elapsedMs,
    },
  });

  return {
    accountsUpserted,
    positionsUpserted,
    transactionsUpserted,
    accountsRequested: accountsToPoll.length,
    entitlementRequired,
    errors,
  };
}
