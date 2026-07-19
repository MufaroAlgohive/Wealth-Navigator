"use client";

/**
 * Research note detail (read view) — the institutional note: thesis, triggers,
 * fundamentals, valuation-vs-peers, management view and the IC log. CURRENT
 * price + UPSIDE are live (from /api/quotes); the 90-day chart pulls
 * /api/intraday and overlays the trigger levels.
 */

import { Pencil, Send } from "lucide-react";
import * as React from "react";

import { GlassSection } from "@/components/oems/primitives/glass";
import { cn } from "@/lib/cn";
import type { NoteTriggers, ResearchNote, ResearchPerms } from "./types";
import {
  type ChartTrigger,
  ConvictionBadge,
  EsgBadge,
  PeerPeBars,
  PeerScorecard,
  PriceTriggerChart,
  RatingBadge,
  StatusChip,
  TrendArrow,
  initialsOf,
  medianOf,
  moneyR,
  signedPct,
  useIntradaySeries,
  useQuotes,
} from "./ui";

const TRIGGER_ROWS: { key: keyof NoteTriggers; label: string; tone: ChartTrigger["tone"] }[] = [
  { key: "buy_below", label: "BUY BELOW", tone: "buy" },
  { key: "add_below", label: "ADD BELOW", tone: "buy" },
  { key: "trim_above", label: "TRIM ABOVE", tone: "sell" },
  { key: "sell_above", label: "SELL ABOVE", tone: "sell" },
  { key: "stop_loss", label: "STOP LOSS", tone: "neutral" },
];

function Stat({ label, value, accent }: { label: string; value: string; accent?: "up" | "down" }) {
  return (
    <div className="text-right">
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p
        className={cn(
          "text-lg font-semibold tabular-nums",
          accent === "up" && "text-up",
          accent === "down" && "text-down",
        )}
      >
        {value}
      </p>
    </div>
  );
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

export function NoteDetail({
  note,
  perms,
  onEdit,
  onSubmitToIc,
  busy,
}: {
  note: ResearchNote;
  perms: ResearchPerms;
  onEdit: () => void;
  onSubmitToIc: () => void;
  busy?: boolean;
}) {
  const th = note.thesis ?? {};
  const quotes = useQuotes([note.symbol]);
  const series = useIntradaySeries(note.symbol);
  const current = quotes.data?.[note.symbol.toUpperCase()]?.last ?? null;
  const priceLoading = quotes.isLoading;
  const target = typeof th.targetPrice === "number" ? th.targetPrice : null;
  const upside =
    current != null && target != null && current > 0 ? ((target - current) / current) * 100 : null;

  const chartTriggers: ChartTrigger[] = TRIGGER_ROWS.flatMap((r) => {
    const t = note.triggers?.[r.key];
    return t && typeof t.price === "number" ? [{ label: r.label, price: t.price, tone: r.tone }] : [];
  });

  const peers = note.valuation?.peers ?? [];
  const fundamentals = th.fundamentals ?? [];
  const icLog = th.icLog ?? [];
  const canSubmit = perms.createNote && (note.status === "draft" || note.status === "in_review");

  return (
    <div className="space-y-5">
      {/* header */}
      <div className="glass-panel p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 space-y-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-lg font-semibold">{note.symbol}</span>
              <RatingBadge rating={th.rating} />
              {th.style && (
                <span className="rounded-full border border-[hsl(var(--glass-border))] px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                  {th.style}
                </span>
              )}
              <ConvictionBadge conviction={th.conviction} />
              <EsgBadge esg={th.esg} />
            </div>
            <p className="text-sm font-medium">{th.companyName ?? note.symbol}</p>
            <p className="text-caption">
              {[
                th.sector,
                th.isin ? `ISIN ${th.isin}` : null,
                th.horizon ? `Time horizon ${th.horizon}` : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </p>
          </div>
          <div className="flex items-center gap-6">
            <Stat label="Current" value={current != null ? moneyR(current) : priceLoading ? "…" : "—"} />
            <Stat label="Target" value={target != null ? moneyR(target) : "—"} />
            <Stat
              label="Upside"
              value={upside != null ? signedPct(upside) : priceLoading ? "…" : "—"}
              accent={upside == null ? undefined : upside >= 0 ? "up" : "down"}
            />
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-[hsl(var(--glass-border))] pt-3">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
            <span>
              Analyst · {th.analystName ?? note.author_email}
              {th.analystRole ? ` (${th.analystRole})` : ""}
            </span>
            {th.reviewerName && <span>Reviewer · {th.reviewerName}</span>}
            {th.version != null && <span>v{th.version}</span>}
            <span>updated {fmtDate(note.updated_at)}</span>
            {th.nextReview && <span>Next review · {th.nextReview}</span>}
            {th.linkedStrategies?.length ? <span>Linked: {th.linkedStrategies.join(", ")}</span> : null}
          </div>
          <div className="flex items-center gap-2">
            <StatusChip status={note.status} />
            {(note.status === "draft" || note.status === "in_review") && (
              <button
                type="button"
                onClick={onEdit}
                className="inline-flex items-center gap-1.5 rounded-lg border border-[hsl(var(--glass-border))] px-3 py-1.5 text-xs font-medium hover:bg-[hsl(var(--foreground)/0.05)]"
              >
                <Pencil className="h-3.5 w-3.5" /> Edit
              </button>
            )}
            {canSubmit && (
              <button
                type="button"
                onClick={onSubmitToIc}
                disabled={busy}
                className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
              >
                <Send className="h-3.5 w-3.5" /> Submit to IC
              </button>
            )}
          </div>
        </div>
      </div>

      {/* price + triggers */}
      <div className="grid gap-5 lg:grid-cols-[1.6fr_1fr]">
        <GlassSection
          title="Price · 90D with triggers"
          dataSource="hybrid"
          subtitle={
            series.data?.source === "unavailable" || (series.data?.points.length ?? 0) === 0
              ? "Live series pending — trigger levels shown"
              : undefined
          }
          className="flex h-[280px] flex-col"
        >
          <div className="min-h-0 flex-1">
            <PriceTriggerChart
              points={series.data?.points ?? []}
              triggers={chartTriggers}
              current={current}
            />
          </div>
        </GlassSection>
        <GlassSection title="Triggers" dataSource="supabase" db="institutional">
          <div className="space-y-2.5">
            {TRIGGER_ROWS.map((r) => {
              const t = note.triggers?.[r.key];
              if (!t || typeof t.price !== "number") return null;
              const tone = r.tone === "buy" ? "text-up" : r.tone === "sell" ? "text-down" : "text-amber-500";
              return (
                <div
                  key={r.key}
                  className="flex items-start justify-between gap-3 border-b border-[hsl(var(--glass-border))] pb-2 last:border-0 last:pb-0"
                >
                  <div className="min-w-0">
                    <p className={cn("text-[11px] font-semibold uppercase tracking-wide", tone)}>{r.label}</p>
                    {t.note && <p className="text-caption">{t.note}</p>}
                  </div>
                  <span className="shrink-0 font-mono text-sm font-semibold tabular-nums">
                    {moneyR(t.price, 0)}
                  </span>
                </div>
              );
            })}
            {chartTriggers.length === 0 && <p className="text-caption">No triggers set.</p>}
          </div>
        </GlassSection>
      </div>

      {/* thesis */}
      <div className="grid gap-5 lg:grid-cols-2">
        <GlassSection title="Bull thesis" dataSource="supabase" db="institutional">
          {th.bull ? (
            <p className="text-sm leading-relaxed text-foreground/85">{th.bull}</p>
          ) : (
            <p className="text-caption">—</p>
          )}
          {th.catalysts?.length ? (
            <div className="mt-4">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Catalysts
              </p>
              <ul className="mt-1.5 space-y-1">
                {th.catalysts.map((c) => (
                  <li key={c} className="flex gap-2 text-xs text-foreground/80">
                    <span className="text-up">▸</span>
                    <span>{c}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </GlassSection>
        <GlassSection title="Bear case / risks" dataSource="supabase" db="institutional">
          {th.bear ? (
            <p className="text-sm leading-relaxed text-foreground/85">{th.bear}</p>
          ) : (
            <p className="text-caption">—</p>
          )}
          {th.risks?.length ? (
            <div className="mt-4">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Risks</p>
              <ul className="mt-1.5 space-y-1">
                {th.risks.map((c) => (
                  <li key={c} className="flex gap-2 text-xs text-foreground/80">
                    <span className="text-down">▸</span>
                    <span>{c}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </GlassSection>
      </div>

      {/* fundamentals + peers */}
      <div className="grid gap-5 lg:grid-cols-[1.4fr_1fr]">
        <GlassSection
          title={
            fundamentals.some((f) => Array.isArray(f.forecastYears) && f.forecastYears.length > 0)
              ? "Fundamentals · multi-year (Year 1 / Year 2 / Year 3)"
              : "Fundamentals · latest vs forecast"
          }
          dataSource="supabase"
          db="institutional"
          noPadding
        >
          {fundamentals.length ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[hsl(var(--glass-border))] text-left text-[10px] uppercase tracking-wide text-muted-foreground">
                    <th className="px-5 py-2 font-medium">Metric</th>
                    <th className="px-3 py-2 text-right font-medium">Prior</th>
                    <th className="px-3 py-2 text-right font-medium">Current</th>
                    {fundamentals.some((f) => Array.isArray(f.forecastYears) && f.forecastYears.length > 0) ? (
                      <>
                        <th className="px-3 py-2 text-right font-medium">Year 1</th>
                        <th className="px-3 py-2 text-right font-medium">Year 2</th>
                        <th className="px-3 py-2 text-right font-medium">Year 3</th>
                      </>
                    ) : (
                      <th className="px-3 py-2 text-right font-medium">Forecast</th>
                    )}
                    <th className="px-5 py-2 text-right font-medium">Trend</th>
                  </tr>
                </thead>
                <tbody>
                  {fundamentals.map((f) => {
                    const years = Array.isArray(f.forecastYears) ? f.forecastYears : [];
                    return (
                      <tr
                        key={f.metric}
                        className="border-b border-[hsl(var(--glass-border))] last:border-0"
                      >
                        <td className="px-5 py-2 text-foreground/85">
                          {f.metric}
                          {f.unit ? ` (${f.unit})` : ""}
                        </td>
                        <td className="px-3 py-2 text-right font-mono tabular-nums text-muted-foreground">
                          {f.prior}
                        </td>
                        <td className="px-3 py-2 text-right font-mono font-semibold tabular-nums">
                          {f.current}
                        </td>
                        {years.length > 0 ? (
                          <>
                            <td className="px-3 py-2 text-right font-mono tabular-nums text-muted-foreground">
                              {years[0] !== undefined && years[0] !== "" ? String(years[0]) : "—"}
                            </td>
                            <td className="px-3 py-2 text-right font-mono tabular-nums text-muted-foreground">
                              {years[1] !== undefined && years[1] !== "" ? String(years[1]) : "—"}
                            </td>
                            <td className="px-3 py-2 text-right font-mono tabular-nums text-muted-foreground">
                              {years[2] !== undefined && years[2] !== "" ? String(years[2]) : "—"}
                            </td>
                          </>
                        ) : (
                          <td className="px-3 py-2 text-right font-mono tabular-nums text-muted-foreground">
                            {f.forecast}
                          </td>
                        )}
                        <td className="px-5 py-2">
                          <span className="flex justify-end">
                            <TrendArrow trend={f.trend} />
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="p-5 text-caption">No fundamentals captured.</p>
          )}
        </GlassSection>
        <GlassSection
          title="Valuation vs peers · scorecard"
          subtitle="GREEN/AMBER/RED vs peer median (Lovable spec)"
          dataSource="supabase"
          db="institutional"
          noPadding
        >
          <PeerScorecard
            subjectName={note.symbol}
            metrics={[
              {
                label: "P/E",
                subject: note.valuation?.pe_multiple ?? null,
                median: medianOf(peers.map((p) => p.pe)),
                kind: "lowerIsBetter",
                unit: "x",
              },
              {
                label: "EV/EBITDA",
                subject: note.valuation?.ev_ebitda ?? null,
                median: medianOf(peers.map((p) => p.evEbitda)),
                kind: "lowerIsBetter",
                unit: "x",
              },
              {
                label: "ROE",
                subject: note.valuation?.roe_pct ?? null,
                median: medianOf(peers.map((p) => p.roe)),
                kind: "higherIsBetter",
                unit: "%",
              },
              {
                label: "Div yield",
                subject: note.valuation?.div_yield_pct ?? null,
                median: medianOf(peers.map((p) => p.divYield)),
                kind: "higherIsBetter",
                unit: "%",
              },
            ]}
          />
          <div className="border-t border-[hsl(var(--glass-border))] p-5">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              P/E bars
            </p>
            <div className="mt-2 h-[140px]">
              <PeerPeBars
                peers={peers}
                subjectPe={note.valuation?.pe_multiple ?? null}
                subjectName={note.symbol}
              />
            </div>
          </div>
        </GlassSection>
      </div>

      {/* management */}
      {(th.likesManagement || th.dislikesManagement) && (
        <div className="grid gap-5 lg:grid-cols-2">
          <GlassSection title="Management — what we love" dataSource="supabase" db="institutional">
            <p className="text-sm leading-relaxed text-foreground/85">{th.likesManagement ?? "—"}</p>
          </GlassSection>
          <GlassSection title="Management — what worries us" dataSource="supabase" db="institutional">
            <p className="text-sm leading-relaxed text-foreground/85">{th.dislikesManagement ?? "—"}</p>
          </GlassSection>
        </div>
      )}

      {/* IC log */}
      <GlassSection title="Investment committee log" dataSource="supabase" db="institutional">
        {icLog.length ? (
          <ol className="space-y-3">
            {icLog.map((e) => (
              <li key={`${e.at}-${e.action}`} className="flex gap-3">
                <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[hsl(var(--foreground)/0.06)] text-[10px] font-semibold text-muted-foreground">
                  {e.initials ?? initialsOf(e.actor)}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs font-semibold">{e.actor}</span>
                    <span className="rounded border border-[hsl(var(--glass-border))] px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">
                      {e.action}
                    </span>
                    <span className="text-[10px] text-muted-foreground">{e.at}</span>
                  </div>
                  {e.note && <p className="mt-0.5 text-xs text-foreground/80">{e.note}</p>}
                </div>
              </li>
            ))}
          </ol>
        ) : (
          <p className="text-caption">No committee history yet.</p>
        )}
      </GlassSection>
    </div>
  );
}
