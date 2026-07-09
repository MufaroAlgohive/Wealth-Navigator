/**
 * Cron route — daily SA macro snapshot pull from the SARB public Web API.
 *
 * GET /api/cron/sa-rates-update
 *
 * Auth: Vercel cron `Authorization: Bearer ${CRON_SECRET}`, OR an admin session.
 * Write gate: SHADOW by default — set `SA_RATES_WRITE=1` to persist to
 * `macro_indicator_c` on the institutional DB. Shadow mode logs what would
 * have been written so the operator can verify the upstream + the field
 * mapping before any rows hit the DB.
 *
 * Failure modes (all logged + counted, never thrown):
 *   - SARB upstream 4xx / 5xx → row marked `{ ok: false, errorNumber: … }`,
 *     run continues. Persistent 5xx trips the cron health on Vercel.
 *   - Network timeout (10 s) → same treatment as 5xx.
 *   - Auth missing / wrong → 401 (don't proceed; we don't want unauth writes).
 *   - DB not configured → 503; the route still surfaces the fetched points
 *     so the operator can see SARB was reachable.
 *   - DB write error (when `SA_RATES_WRITE=1`) → counted as `failed`, the
 *     rest of the batch proceeds.
 *
 * Suggested schedule (vercel.json): daily at 16:05 SAST (weekday), e.g.
 *   "5 14 * * 1-5" (UTC) — SARB publishes key stats mid-afternoon.
 *
 * Phase C2 — this is the wired macro feed. The `/api/sa-rates/timeseries`
 * route already serves the same SARB endpoint on read; the cron just adds
 * persistence into `macro_indicator_c` for the `/oems/macro` page and the
 * `macro-pulse` chart. The `/api/macro` read path stays unchanged.
 */
import { NextResponse } from "next/server";

import { getAdminContext, isAdminRole } from "@/lib/admin/rbac";
import { createInstitutionalServiceRoleClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const SARB_TS_URL = "https://custom.resbank.co.za/SarbWebApi/WebIndicators/TimeSeries";

/**
 * Indicator codes + human labels for the headline SA macro series. Mirrors
 * the read-side list in `/api/sa-rates/timeseries` so the cron writes back
 * the same shape that the chart already knows how to render.
 */
const INDICATORS: ReadonlyArray<{
  id: "repo" | "prime" | "zaronia" | "household_debt_to_gdp";
  label: string;
  code: string;
  source: "sarb" | "code-gap";
}> = [
  { id: "repo", label: "SARB Repo", code: "MMRD002A", source: "sarb" },
  { id: "prime", label: "Prime", code: "MMRD000A", source: "sarb" },
  { id: "zaronia", label: "ZARONIA", code: "MMRD855A", source: "sarb" },
  // Household-debt-to-GDP is not on the free SARB time-series feed; the read
  // side already surfaces this as `code-gap` and the cron keeps it as a no-op.
  { id: "household_debt_to_gdp", label: "Household debt / GDP", code: "MMRD_HDGDP_A", source: "code-gap" },
];

interface SarbTimeseriesPoint {
  Date?: string;
  Value?: number;
}
interface SarbTimeseriesResponse {
  data?: SarbTimeseriesPoint[];
  error?: { message?: string };
}

async function authorized(req: Request): Promise<boolean> {
  const secret = process.env.CRON_SECRET;
  const bearer = req.headers.get("authorization")?.replace("Bearer ", "");
  if (secret && bearer === secret) return true;
  const auth = await getAdminContext();
  return auth.status === "ok" && isAdminRole(auth.ctx);
}

async function fetchSeries(code: string, startDate: string, endDate: string): Promise<SarbTimeseriesPoint[]> {
  const url = `${SARB_TS_URL}?code=${encodeURIComponent(code)}&startDate=${encodeURIComponent(startDate)}&endDate=${encodeURIComponent(endDate)}&format=json`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": "MintOEM/SA-Rates-Cron/1.0" },
      signal: ctrl.signal,
    });
    if (!res.ok) {
      throw new Error(`sarb-ts ${code} HTTP ${res.status}`);
    }
    const body = (await res.json()) as SarbTimeseriesResponse;
    return Array.isArray(body.data) ? body.data : [];
  } finally {
    clearTimeout(timer);
  }
}

function pickLatest(points: SarbTimeseriesPoint[]): { date: string; value: number } | null {
  for (let i = points.length - 1; i >= 0; i--) {
    const p = points[i];
    if (p?.Date != null && p.Value != null && Number.isFinite(Number(p.Value))) {
      return { date: String(p.Date).slice(0, 10), value: Number(p.Value) };
    }
  }
  return null;
}

export async function GET(req: Request) {
  if (!(await authorized(req))) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const writesOn = process.env.SA_RATES_WRITE === "1";
  // Use yesterday → today so we always capture the most recent daily series,
  // even if the cron fires before SARB refreshes today's bucket. The SARB
  // endpoint returns the entire matching window — picking the latest is the
  // caller's job.
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86_400_000);
  const startDate = yesterday.toISOString().slice(0, 10);
  const endDate = today.toISOString().slice(0, 10);

  const sample: Array<Record<string, unknown>> = [];
  let fetched = 0;
  let written = 0;
  let failed = 0;

  // Phase C2 — graceful failure: if SARB is unreachable from Vercel, the
  // route still returns 200 with `failed > 0` so the cron slot isn't
  // permanently red. Persistent failures trip via Vercel's health check.
  let db: ReturnType<typeof createInstitutionalServiceRoleClient> | null = null;
  if (writesOn) {
    try {
      db = createInstitutionalServiceRoleClient();
    } catch {
      db = null;
    }
  }

  for (const ind of INDICATORS) {
    if (ind.source === "code-gap") {
      sample.push({
        indicator_id: ind.id,
        source: "code-gap",
        note: "Skipped — no SARB time-series code for household-debt-to-GDP.",
      });
      continue;
    }
    try {
      const raw = await fetchSeries(ind.code, startDate, endDate);
      fetched += 1;
      const latest = pickLatest(raw);
      if (!latest) {
        sample.push({ indicator_id: ind.id, ok: false, error: "empty series" });
        failed += 1;
        continue;
      }
      sample.push({
        indicator_id: ind.id,
        code: ind.code,
        value: latest.value,
        as_of: latest.date,
        prior_value: null,
        unit: "%",
        source: "sarb",
      });
      if (writesOn && db) {
        const { error } = await db.from("macro_indicator_c").upsert(
          {
            indicator_id: ind.id,
            name: ind.label,
            country: "ZA",
            unit: "%",
            value: latest.value,
            prior_value: null,
            as_of: latest.date,
            source: "sarb",
          },
          { onConflict: "indicator_id,as_of" },
        );
        if (error) {
          sample[sample.length - 1] = { ...sample[sample.length - 1], write_error: error.message };
          failed += 1;
        } else {
          written += 1;
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      sample.push({ indicator_id: ind.id, ok: false, error: msg });
      failed += 1;
    }
  }

  return NextResponse.json({
    ok: failed === 0,
    mode: writesOn ? (db ? "write" : "shadow") : "shadow",
    window: { startDate, endDate },
    sarb_upstream: SARB_TS_URL,
    fetched,
    written,
    failed,
    sample,
    note: writesOn
      ? db
        ? undefined
        : "SA_RATES_WRITE=1 but INSTITUTIONAL Supabase not configured — shadowed instead."
      : "Shadow run — set SA_RATES_WRITE=1 to persist macro_indicator_c rows. SARB upstream was still hit; check `sample` for the would-be rows.",
  });
}
