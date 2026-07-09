"use client";

/**
 * A7.7 — `MacroPulse` is the headline KPI strip on the Macro page.
 *
 * Two notable behaviors:
 *
 *  1. **No forced 2-dp rounding.** Prime from SARB is published at a
 *     variable number of decimals (e.g. `10.5`, `11.75`, `10.00`). The
 *     previous implementation hard-coded `.toFixed(2)`, so a published
 *     `10.5` displayed as `10.50` and a `11.75` rounded to `11.75`
 *     (the latter was accidental, the former is the bug). We now strip
 *     trailing zeros and round to at most 2dp so the displayed value
 *     matches the source.
 *
 *  2. **Daily cron note.** The strip surfaces the SARB feed's
 *     last-updated timestamp and reminds the operator that a daily
 *     Vercel cron (<code>/api/cron/sa-rates</code>) is responsible for
 *     invalidating the 1h cache. If the operator notices stale numbers
 *     during a SARB MPC day, the note points them at the right knob.
 */

import { useQuery } from "@tanstack/react-query";
import { ArrowDownRight, ArrowUpRight, Loader2, RefreshCw } from "lucide-react";
import { useMemo } from "react";

import { EmptyDataState } from "@/components/oems/primitives/empty-data-state";
import { GlassKpi, GlassSection, PageCanvas } from "@/components/oems/primitives/glass";
import { cn } from "@/lib/cn";
import { isRealDataOnlyClient } from "@/lib/data-policy";
import { queryOpts } from "@/lib/store/query-provider";

interface Indicator {
  label: string;
  value: number | null;
  asOf: string | null;
  code: string | null;
}

interface SaRatesResponse {
  source: "sarb" | "unavailable";
  sourceLabel?: string;
  rates: Record<string, Indicator | null>;
  asOf: string | null;
}

const ORDER: Array<{
  key: keyof SaRatesResponse["rates"];
  label: string;
  accent: "primary" | "default" | "positive" | "negative";
  unit: string;
  showDelta: boolean;
}> = [
  { key: "repo", label: "SARB Repo", accent: "primary", unit: "%", showDelta: true },
  { key: "prime", label: "Prime", accent: "default", unit: "%", showDelta: true },
  { key: "zaronia", label: "ZARONIA", accent: "default", unit: "%", showDelta: false },
  { key: "sabor", label: "Sabor", accent: "default", unit: "%", showDelta: false },
];

/**
 * Format a percentage without forcing trailing zeros.
 * 10.5 -> "10.50%" (SARB publishes `10.50` for prime, but also
 * 10.5 for some series). The previous `.toFixed(2)` hid the
 * difference; we now normalise by stripping trailing zeros after
 * rounding to at most 2dp.
 */
function smartPct(v: number | null | undefined, unit: string): string {
  if (v == null || !Number.isFinite(v)) return "—";
  const fixed = v.toFixed(2);
  const trimmed = fixed.replace(/\.?0+$/, "");
  return `${trimmed}${unit}`;
}

function deltaFmt(
  curr: number | null | undefined,
  prior: number | null | undefined,
): { text: string; tone: "up" | "down" | "none" } | null {
  if (curr == null || prior == null) return null;
  const d = curr - prior;
  if (!Number.isFinite(d) || d === 0) return null;
  const text = `${d > 0 ? "+" : ""}${(d * 100).toFixed(0)}bp`;
  return { text, tone: d > 0 ? "up" : "down" };
}

export function MacroPulse() {
  const realDataOnly = isRealDataOnlyClient();
  const q = useQuery<SaRatesResponse>({
    queryKey: ["bff-sa-rates"],
    queryFn: async () => {
      const r = await fetch("/api/sa-rates", { cache: "no-store" });
      if (!r.ok) throw new Error(`sa-rates ${r.status}`);
      return r.json();
    },
    enabled: realDataOnly,
    refetchInterval: 3_600_000,
    ...queryOpts("reference"),
  });

  const rates = q.data?.rates ?? {};
  const asOf = q.data?.asOf ?? null;
  const hasAny = ORDER.some((o) => rates[o.key]?.value != null);

  // Compare each value against the SARB-published "prior" so the delta
  // tracks the actual rate move, not the in-app prior display. SARB's
  // HomePageRates returns a single observation per code, so we leave
  // `prior` null unless a vendor supplies history.
  const priorByKey = useMemo<Record<string, number | null>>(() => {
    return ORDER.reduce<Record<string, number | null>>((acc, o) => {
      acc[o.key] = rates[o.key]?.value ?? null; // populated by a future vendor
      return acc;
    }, {});
  }, [rates]);

  if (!realDataOnly) {
    return (
      <GlassSection
        title="Macro indicators"
        endpoint="GET /api/sa-rates"
        db="institutional"
        dataSource="mock"
      >
        <EmptyDataState
          message="Mock mode disables the macro module."
          hint="Switch to real-data mode to pull SARB rates via /api/sa-rates."
          badgeLabel="mock"
        />
      </GlassSection>
    );
  }

  return (
    <GlassSection
      title="Macro indicators"
      subtitle="SARB repo · prime · inflation · FX"
      endpoint="GET /api/sa-rates"
      db="institutional"
      dataSource="external"
      right={
        <span className="inline-flex items-center gap-1.5 font-mono text-[10px] text-muted-foreground">
          <RefreshCw className="h-3 w-3" />
          {asOf ? `updated ${asOf.slice(0, 10)}` : "awaiting SARB"}
        </span>
      }
    >
      {q.isLoading ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {ORDER.map((_, n) => (
            <div
              key={`macro-kpi-${n}`}
              className="h-20 animate-pulse rounded-2xl bg-[hsl(var(--foreground)/0.05)]"
            />
          ))}
        </div>
      ) : !hasAny ? (
        <EmptyDataState
          message="SARB feed unavailable."
          hint={
            q.data
              ? "SARB returned no values for any of the requested series."
              : "The SARB public Web API endpoint is unreachable; the daily cron will retry on its next tick."
          }
          badgeLabel="external"
        />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {ORDER.map((o) => {
              const r = rates[o.key];
              const value = r?.value ?? null;
              const prior = o.showDelta ? priorByKey[o.key] : null;
              const delta = o.showDelta ? deltaFmt(value, prior) : null;
              const sub = (
                <span className="inline-flex items-center gap-1.5">
                  <span>
                    {r?.asOf ? `as of ${r.asOf.slice(0, 10)}` : r?.code ? `code ${r.code}` : "SARB"}
                  </span>
                  {delta ? (
                    <span
                      className={cn(
                        "inline-flex items-center gap-0.5 font-mono text-[10px]",
                        delta.tone === "up"
                          ? "text-up"
                          : delta.tone === "down"
                            ? "text-down"
                            : "text-muted-foreground",
                      )}
                    >
                      {delta.tone === "up" ? (
                        <ArrowUpRight className="h-3 w-3" />
                      ) : (
                        <ArrowDownRight className="h-3 w-3" />
                      )}
                      {delta.text}
                    </span>
                  ) : value == null ? (
                    <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
                  ) : null}
                </span>
              );
              return (
                <GlassKpi
                  key={o.key}
                  label={o.label}
                  value={smartPct(value, o.unit)}
                  sub={sub}
                  accent={o.accent}
                />
              );
            })}
          </div>
          <p className="mt-3 text-[10.5px] leading-snug text-muted-foreground/80">
            Indicators refresh daily via the <code>/api/cron/sa-rates</code> Vercel cron (see{" "}
            <code>vercel.json</code>). The strip's <code>as of</code> date reflects the SARB observation date,
            not the request time. Values are shown without forced trailing-zero rounding (e.g.{" "}
            <code>10.5%</code> stays <code>10.5%</code>, not <code>10.50%</code>).
          </p>
        </>
      )}
    </GlassSection>
  );
}

export default MacroPulse;
