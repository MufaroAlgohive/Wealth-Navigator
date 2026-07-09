/**
 * GET /api/admin/vendor-health
 *
 * Phase C2 — aggregated vendor health endpoint.
 *
 * Surfaces a single envelope covering every vendor integration the OEMS
 * desk relies on, with a stable status taxonomy that the Cockpit
 * `Integration` panel can render without bespoke shaping per feed.
 *
 * Status taxonomy (matches `DataSourceKind` so the badge stays consistent
 * with the rest of the OEMS chrome):
 *   - "ok"           — vendor answered with real data.
 *   - "degraded"     — vendor answered but partially (e.g. 1 of 3 series).
 *   - "blocked"      — entitlement pending; see `unblockCondition`.
 *   - "unconfigured" — no creds / no URL; vendor is planned but not wired.
 *   - "error"        — vendor returned an error or timed out.
 *
 * Per-vendor check is best-effort + non-throwing: a single vendor outage
 * never takes the whole endpoint down. When a vendor requires Supabase +
 * `USE_SUPABASE_QUOTES=true`, the route falls back to a `blocked` status
 * with `unblockCondition` describing the prerequisite.
 *
 * Auth: signed-in admin team member (the route is informational but
 * exposes internal health surfaces, so we keep it behind RBAC).
 */
import { NextResponse } from "next/server";

import { getAdminContext } from "@/lib/admin/rbac";
import { isSupabaseSchemaMissing } from "@/lib/bff-reasons";
import { getIressWorkerUrl, isUseSupabaseQuotesEnabled } from "@/lib/data-policy";
import { getActiveProvider, getActiveProviderName } from "@/lib/data/providers";
import { iressConfig } from "@/lib/iress";
import { callWorker } from "@/lib/iress/worker-api";
import { createServiceRoleClient, isSupabaseConfigured } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export type VendorStatus = "ok" | "degraded" | "blocked" | "unconfigured" | "error";

export interface VendorHealth {
  vendor: string;
  status: VendorStatus;
  message: string;
  unblockCondition?: string;
  lastChecked: string;
  latencyMs?: number;
  detail?: Record<string, unknown>;
}

interface VendorHealthResponse {
  ok: true;
  generatedAt: string;
  /** Active provider name + whether USE_SUPABASE_QUOTES is enabled. */
  environment: {
    activeProvider: ReturnType<typeof getActiveProviderName>;
    useSupabaseQuotes: boolean;
    iressMode: string;
    workerConfigured: boolean;
  };
  vendors: VendorHealth[];
}

async function checkIress(): Promise<VendorHealth> {
  const lastChecked = new Date().toISOString();
  const workerUrl = getIressWorkerUrl();
  // The IRESS provider itself is always present (mock / live).
  // What the operator cares about is whether the worker is reachable
  // AND whether IRESS_MODE matches the production target.
  if (iressConfig.mode === "live" && !workerUrl) {
    return {
      vendor: "iress",
      status: "blocked",
      message:
        "IRESS_MODE=live but the Railway worker URL is not configured (IRESS_WORKER_URL or RAILWAY_SERVICE_URL on Vercel).",
      unblockCondition:
        "Set IRESS_WORKER_URL on Vercel, then redeploy. See docs/PROVIDER_SWITCH_RUNBOOK.md §4.2.",
      lastChecked,
    };
  }
  if (iressConfig.mode === "mock") {
    return {
      vendor: "iress",
      status: "ok",
      message: `IRESS adapter running in mock mode (${iressConfig.mode}). Local reads come from lib/iress/seed.ts; live reads require the Railway worker.`,
      lastChecked,
      detail: { mode: iressConfig.mode },
    };
  }
  // mode === "live" and worker URL is set — ping the worker.
  const start = Date.now();
  try {
    const res = await callWorker<{ ok: boolean; iressMode?: string; session?: { cached: boolean } }>({
      path: "/health",
      timeoutMs: 5_000,
    });
    if (!res.ok) {
      return {
        vendor: "iress",
        status: "error",
        message: `Worker /health returned ${res.status} (${res.code}).`,
        lastChecked,
        latencyMs: Date.now() - start,
        detail: { workerStatus: res.status, workerCode: res.code, workerError: res.error },
      };
    }
    const sessionCached = res.body?.session?.cached ?? false;
    return {
      vendor: "iress",
      status: "ok",
      message: sessionCached
        ? "IRESS session cached on the worker; quotes + orders are live."
        : "Worker healthy but IRESS session not yet cached — first quote will start the session.",
      lastChecked,
      latencyMs: Date.now() - start,
      detail: { iressMode: res.body?.iressMode ?? iressConfig.mode, sessionCached },
    };
  } catch (err) {
    return {
      vendor: "iress",
      status: "error",
      message: err instanceof Error ? err.message : String(err),
      lastChecked,
      latencyMs: Date.now() - start,
    };
  }
}

async function checkYahoo(): Promise<VendorHealth> {
  const lastChecked = new Date().toISOString();
  const start = Date.now();
  try {
    const provider = getActiveProvider();
    if (provider.name !== "yahoo") {
      // The provider is registered but not active; we still want to know
      // whether *if asked* it would work, so ping it directly.
      const res = await fetch("https://query1.finance.yahoo.com/v7/finance/quote?symbols=AAPL", {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; MintWealthNavigator/1.0)" },
        cache: "no-store",
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) {
        return {
          vendor: "yahoo",
          status: "error",
          message: `Yahoo HTTP ${res.status}`,
          lastChecked,
          latencyMs: Date.now() - start,
        };
      }
    }
    const health = await provider.health();
    return {
      vendor: "yahoo",
      status: health.status === "ok" ? "ok" : health.status === "degraded" ? "degraded" : "error",
      message: health.message ?? "Yahoo reachable.",
      lastChecked,
      latencyMs: health.latencyMs ?? Date.now() - start,
    };
  } catch (err) {
    return {
      vendor: "yahoo",
      status: "error",
      message: err instanceof Error ? err.message : String(err),
      lastChecked,
      latencyMs: Date.now() - start,
    };
  }
}

async function checkIris(): Promise<VendorHealth> {
  // Iris is a planned stub today — the provider's `health()` returns
  // `unconfigured` until Charles/Juan confirm the real APIs.
  const lastChecked = new Date().toISOString();
  try {
    const provider = getActiveProvider();
    void provider; // active provider might not be IRIS — read the named one directly.
    const { IrisProvider } = await import("@/lib/data/providers/iris");
    const iris = new IrisProvider();
    const health = await iris.health();
    return {
      vendor: "iris",
      status: health.status === "ok" ? "ok" : health.status === "degraded" ? "degraded" : "unconfigured",
      message: health.message ?? "IRIS provider not configured (planned for Research Lab follow-up).",
      lastChecked,
    };
  } catch (err) {
    return {
      vendor: "iris",
      status: "error",
      message: err instanceof Error ? err.message : String(err),
      lastChecked,
    };
  }
}

async function checkSens(): Promise<VendorHealth> {
  const lastChecked = new Date().toISOString();
  // SENS = IRESS `NewsVendorGet` with `vendor=SENS`. Status reflects the
  // entitlement state: the worker probe reports 25010 / 25034 when the
  // SENS vendor isn't entitled on `DFM@Mint`.
  if (iressConfig.mode === "mock") {
    return {
      vendor: "sens",
      status: "blocked",
      message: "IRESS adapter in mock mode; SENS entitlements cannot be probed from Vercel.",
      unblockCondition:
        "Set IRESS_MODE=live on the Railway worker (not Vercel), then run /api/iress/news?vendor=SENS to confirm Charles flipped the SENS vendor on DFM@Mint.",
      lastChecked,
    };
  }
  const workerUrl = getIressWorkerUrl();
  if (!workerUrl) {
    return {
      vendor: "sens",
      status: "blocked",
      message: "Railway worker URL not configured; SENS probe unreachable from Vercel.",
      unblockCondition: "Set IRESS_WORKER_URL on Vercel, then redeploy.",
      lastChecked,
    };
  }
  const start = Date.now();
  try {
    const res = await callWorker<{ ok: boolean; errorNumber: number | null; dataRowCount: number }>({
      path: "/debug/news-vendor-probe?vendor=SENS&pageSize=1&timeout=10",
      timeoutMs: 15_000,
    });
    if (!res.ok) {
      return {
        vendor: "sens",
        status: "error",
        message: `Worker probe returned ${res.status} (${res.code}).`,
        lastChecked,
        latencyMs: Date.now() - start,
      };
    }
    const fault = res.body?.errorNumber;
    if (fault === 25010 || fault === 25034) {
      return {
        vendor: "sens",
        status: "blocked",
        message: `IRESS entitlement fault ${fault} on SENS vendor.`,
        unblockCondition:
          "Charles/IRESS to flip the SENS vendor on DFM@Mint. See docs/VENDOR_ENTITLEMENT_STATUS.md.",
        lastChecked,
        latencyMs: Date.now() - start,
        detail: { errorNumber: fault, dataRowCount: res.body?.dataRowCount ?? 0 },
      };
    }
    if (!res.body?.ok || (res.body.dataRowCount ?? 0) === 0) {
      return {
        vendor: "sens",
        status: "degraded",
        message: "Worker answered but no SENS rows returned.",
        lastChecked,
        latencyMs: Date.now() - start,
        detail: { dataRowCount: res.body?.dataRowCount ?? 0 },
      };
    }
    return {
      vendor: "sens",
      status: "ok",
      message: `SENS vendor returning ${res.body.dataRowCount}+ rows.`,
      lastChecked,
      latencyMs: Date.now() - start,
    };
  } catch (err) {
    return {
      vendor: "sens",
      status: "error",
      message: err instanceof Error ? err.message : String(err),
      lastChecked,
      latencyMs: Date.now() - start,
    };
  }
}

async function checkFixedIncome(): Promise<VendorHealth> {
  const lastChecked = new Date().toISOString();
  if (!isUseSupabaseQuotesEnabled() || !isSupabaseConfigured()) {
    return {
      vendor: "fixed-income",
      status: "blocked",
      message: "Bond analytics table (bonds_c) requires USE_SUPABASE_QUOTES=true + INSTITUTIONAL Supabase.",
      unblockCondition:
        "Enable USE_SUPABASE_QUOTES=true on Vercel and Railway; the worker will then populate bonds_c from IRESS SecuritySearchGet + YTM once Charles flips the entitlement on DFM@Mint.",
      lastChecked,
    };
  }
  try {
    const db = createServiceRoleClient();
    const { count, error } = await db.from("bonds_c").select("*", { count: "exact", head: true });
    if (error) {
      if (isSupabaseSchemaMissing(error)) {
        return {
          vendor: "fixed-income",
          status: "blocked",
          message: "bonds_c table not migrated yet.",
          unblockCondition:
            "Apply supabase/migrations/20260613000004_oems_instrument_universe.sql on the institutional Supabase.",
          lastChecked,
          detail: { migration: "20260613000004_oems_instrument_universe.sql" },
        };
      }
      return {
        vendor: "fixed-income",
        status: "error",
        message: error.message,
        lastChecked,
      };
    }
    const n = count ?? 0;
    if (n === 0) {
      return {
        vendor: "fixed-income",
        status: "blocked",
        message: "bonds_c is empty — SecuritySearchGet + YTM entitlement pending on DFM@Mint.",
        unblockCondition:
          "Charles/IRESS to flip SecuritySearchGet + YTM entitlement on DFM@Mint; the worker will then write the bond analytics.",
        lastChecked,
        detail: { count: 0 },
      };
    }
    return {
      vendor: "fixed-income",
      status: "ok",
      message: `bonds_c populated with ${n} rows.`,
      lastChecked,
      detail: { count: n },
    };
  } catch (err) {
    return {
      vendor: "fixed-income",
      status: "error",
      message: err instanceof Error ? err.message : String(err),
      lastChecked,
    };
  }
}

async function checkMoneyMarket(): Promise<VendorHealth> {
  const lastChecked = new Date().toISOString();
  if (!isUseSupabaseQuotesEnabled() || !isSupabaseConfigured()) {
    return {
      vendor: "money-market",
      status: "blocked",
      message:
        "MM tables (money_market_instrument_c + jibar_fixing_c) require USE_SUPABASE_QUOTES=true + INSTITUTIONAL Supabase.",
      unblockCondition:
        "Enable USE_SUPABASE_QUOTES=true on Vercel + Railway; the worker will populate the MM tables once Charles flips the rate-feed entitlement on DFM@Mint.",
      lastChecked,
    };
  }
  try {
    const db = createServiceRoleClient();
    const [instRes, jibarRes] = await Promise.all([
      db.from("money_market_instrument_c").select("*", { count: "exact", head: true }),
      db.from("jibar_fixing_c").select("*", { count: "exact", head: true }),
    ]);
    if (instRes.error && isSupabaseSchemaMissing(instRes.error)) {
      return {
        vendor: "money-market",
        status: "blocked",
        message: "MM tables not migrated yet.",
        unblockCondition:
          "Apply supabase/migrations/20260613000005_money_market_universe.sql on the institutional Supabase.",
        lastChecked,
        detail: { migration: "20260613000005_money_market_universe.sql" },
      };
    }
    if (instRes.error || jibarRes.error) {
      return {
        vendor: "money-market",
        status: "error",
        message: instRes.error?.message ?? jibarRes.error?.message ?? "MM read failed.",
        lastChecked,
      };
    }
    const inst = instRes.count ?? 0;
    const jibar = jibarRes.count ?? 0;
    if (inst === 0 && jibar === 0) {
      return {
        vendor: "money-market",
        status: "blocked",
        message: "MM tables empty — rate-feed entitlement pending on DFM@Mint.",
        unblockCondition:
          "Charles/IRESS to flip the rate-feed entitlement on DFM@Mint; the worker will then populate the MM universe + JIBAR fixings.",
        lastChecked,
        detail: { instruments: inst, jibar },
      };
    }
    return {
      vendor: "money-market",
      status: "ok",
      message: `MM populated (${inst} instruments, ${jibar} JIBAR fixings).`,
      lastChecked,
      detail: { instruments: inst, jibar },
    };
  } catch (err) {
    return {
      vendor: "money-market",
      status: "error",
      message: err instanceof Error ? err.message : String(err),
      lastChecked,
    };
  }
}

async function checkMacro(): Promise<VendorHealth> {
  const lastChecked = new Date().toISOString();
  // Phase C2 — the macro cron route (`/api/cron/sa-rates-update`) pulls
  // SARB public data and persists to `macro_indicator_c`. Surface the cron
  // result here so the operator can see whether the SARB feed is alive.
  const start = Date.now();
  try {
    const url = `${SARB_TS_URL}?code=MMRD002A&startDate=${encodeURIComponent(yesterday())}&endDate=${encodeURIComponent(today())}&format=json`;
    const res = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": "MintOEM/VendorHealth/1.0" },
      cache: "no-store",
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) {
      return {
        vendor: "macro-sarb",
        status: "error",
        message: `SARB upstream HTTP ${res.status}`,
        unblockCondition:
          "SARB public Web API may be unreachable from Vercel — see docs/VENDOR_ENTITLEMENT_STATUS.md. The cron route is graceful and will retry on the next window.",
        lastChecked,
        latencyMs: Date.now() - start,
      };
    }
    return {
      vendor: "macro-sarb",
      status: "ok",
      message: "SARB public Web API reachable; the daily cron writes to macro_indicator_c.",
      lastChecked,
      latencyMs: Date.now() - start,
    };
  } catch (err) {
    return {
      vendor: "macro-sarb",
      status: "error",
      message: err instanceof Error ? err.message : String(err),
      unblockCondition:
        "SARB public Web API may be unreachable from Vercel — see docs/VENDOR_ENTITLEMENT_STATUS.md.",
      lastChecked,
      latencyMs: Date.now() - start,
    };
  }
}

const SARB_TS_URL = "https://custom.resbank.co.za/SarbWebApi/WebIndicators/TimeSeries";
function today(): string {
  return new Date().toISOString().slice(0, 10);
}
function yesterday(): string {
  return new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
}

export async function GET() {
  const auth = await getAdminContext();
  if (auth.status === "no-session") {
    return NextResponse.json({ ok: false, error: "no-session" }, { status: 401 });
  }
  if (auth.status !== "ok") {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  // Each vendor check is independent and best-effort; failures in one
  // never short-circuit the others.
  const vendors: VendorHealth[] = await Promise.all([
    checkIress(),
    checkYahoo(),
    checkIris(),
    checkSens(),
    checkFixedIncome(),
    checkMoneyMarket(),
    checkMacro(),
  ]);

  const payload: VendorHealthResponse = {
    ok: true,
    generatedAt: new Date().toISOString(),
    environment: {
      activeProvider: getActiveProviderName(),
      useSupabaseQuotes: isUseSupabaseQuotesEnabled(),
      iressMode: iressConfig.mode,
      workerConfigured: getIressWorkerUrl().length > 0,
    },
    vendors,
  };
  return NextResponse.json(payload);
}
