"use client";

import { useMemo, useState } from "react";

import { GlassSection } from "@/components/oems/primitives/glass";
import { EmptyDataState } from "@/components/oems/primitives/empty-data-state";
import { Pill } from "@/components/oems/primitives/pill";
import { cn } from "@/lib/cn";
import { formatPct, formatZAR } from "@/lib/format";

/**
 * Time horizon for the investor performance column. Lonwabo asked for a
 * snippet of the Investors view (name + holdings value + performance) with a
 * horizon selector that DEFAULTS to YTD. The Cockpit only has dayPnl + ytd on
 * the Strategy seed today, so:
 *   1D  → mapped from each strategy's dayPnl (mock) / client-book day P&L
 *   MTD → deferred (no month-to-date field yet) → renders "—"
 *   YTD → mapped from each strategy's ytd
 * The full per-investor breakdown (the ~3,000 investor list with their own
 * holdings + returns) wires in the data phase from the client book.
 */
export type AccountsHorizon = "1D" | "MTD" | "YTD";

const HORIZONS: readonly AccountsHorizon[] = ["1D", "MTD", "YTD"];

/** One row in the Portfolio Accounts investor snippet. */
export interface PortfolioAccountRow {
  /** Investor / account display name. */
  name: string;
  /** Optional sub-label (strategy, account code, segment…). */
  sublabel?: string;
  /** Holdings value in Rands. `null` when not yet sourced. */
  holdings: number | null;
  /** Performance % for the selected horizon. `null` ⇒ deferred / unavailable. */
  perf: number | null;
}

/**
 * Portfolio Accounts — a compact snippet of the Investors view, surfaced on the
 * Cockpit. Lists investors with how much they hold and their performance, with
 * a 1D / MTD / YTD horizon toggle defaulting to YTD.
 *
 * The CALLER owns where the rows come from: in mock mode it derives them from
 * the strategy seed; in real-data mode it passes the client-book / investor
 * rows. When `rows` is empty the panel renders an honest empty state — we never
 * fabricate investor numbers (the investor list is a data-phase wire-up).
 */
export function CockpitPortfolioAccounts({
  rows,
  horizon,
  onHorizonChange,
  dataSource,
  endpoint,
  emptyTitle,
  emptyMessage,
  note,
  rowTag,
  className,
}: {
  rows: PortfolioAccountRow[];
  /** Controlled horizon. Omit to use the panel's own state (defaults YTD). */
  horizon?: AccountsHorizon;
  onHorizonChange?: (h: AccountsHorizon) => void;
  dataSource: "supabase" | "seed" | "unconfigured" | "unavailable";
  endpoint: string;
  emptyTitle?: string;
  emptyMessage?: string;
  /**
   * Optional honest footer note shown under the row list (e.g. that the rows
   * are strategy stand-ins, or that the per-investor breakdown wires in the
   * data phase). Rendered only when there are rows to show.
   */
  note?: string;
  /**
   * Optional short tag rendered as a Pill on each row (e.g. "strategy") so a
   * stand-in row list isn't mistaken for the real per-investor list.
   */
  rowTag?: string;
  className?: string;
}) {
  const [internal, setInternal] = useState<AccountsHorizon>("YTD");
  const active = horizon ?? internal;
  const setActive = (h: AccountsHorizon) => {
    if (onHorizonChange) onHorizonChange(h);
    else setInternal(h);
  };

  const totalHoldings = useMemo(
    () => rows.reduce((acc, r) => acc + (r.holdings ?? 0), 0),
    [rows],
  );

  return (
    <GlassSection
      title="Portfolio Accounts"
      endpoint={endpoint}
      dataSource={dataSource}
      noPadding
      className={cn("flex h-[340px] flex-col min-h-0", className)}
      right={
        <div className="glass-inset inline-flex overflow-hidden p-0.5">
          {HORIZONS.map((h) => (
            <button
              key={h}
              type="button"
              onClick={() => setActive(h)}
              className={cn(
                "rounded-lg px-2.5 py-1 text-xs font-medium transition-colors",
                active === h
                  ? "bg-primary/20 text-primary"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {h}
            </button>
          ))}
        </div>
      }
    >
      {rows.length === 0 ? (
        <div className="p-5">
          <EmptyDataState
            title={emptyTitle ?? "No investors yet"}
            message={
              emptyMessage ??
              "Investor list + per-investor holdings and returns wire in the data phase from the client book."
            }
          />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
            <ul className="divide-y divide-[hsl(var(--glass-border))]/60">
              {rows.map((r) => {
                const perf = r.perf;
                const up = perf != null && perf > 0;
                const down = perf != null && perf < 0;
                return (
                  <li
                    key={`${r.name}-${r.sublabel ?? ""}`}
                    className="flex items-center gap-2 px-3.5 py-2.5 transition-colors hover:bg-muted/30"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="flex items-center gap-1.5 truncate text-xs font-medium">
                        <span className="truncate">{r.name}</span>
                        {rowTag && (
                          <Pill tone="neutral" size="xs">{rowTag}</Pill>
                        )}
                      </p>
                      {r.sublabel && (
                        <p className="truncate font-mono text-[9.5px] text-muted-foreground">
                          {r.sublabel}
                        </p>
                      )}
                    </div>
                    <span className="shrink-0 font-mono text-[11px] tabular-nums text-foreground">
                      {r.holdings != null ? formatZAR(r.holdings) : "—"}
                    </span>
                    <span
                      className={cn(
                        "ml-1 w-16 shrink-0 text-right font-mono text-[11px] tabular-nums",
                        perf == null
                          ? "text-muted-foreground"
                          : up
                            ? "text-up"
                            : down
                              ? "text-down"
                              : "text-muted-foreground",
                      )}
                    >
                      {perf != null ? formatPct(perf) : "—"}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
          {note && (
            <p className="shrink-0 border-t border-[hsl(var(--glass-border))]/60 px-3.5 py-1.5 text-[10.5px] leading-snug text-muted-foreground/80">
              {note}
            </p>
          )}
          <div className="flex shrink-0 items-center justify-between border-t border-[hsl(var(--glass-border))]/60 px-3.5 py-2">
            <span className="flex items-center gap-1.5 text-caption">
              <Pill tone="neutral" size="xs">{active}</Pill>
              <span>
                {rows.length}{" "}
                {rowTag === "strategy"
                  ? rows.length === 1
                    ? "strategy"
                    : "strategies"
                  : rowTag
                    ? `${rowTag} ${rows.length === 1 ? "row" : "rows"}`
                    : rows.length === 1
                      ? "row"
                      : "rows"}
              </span>
            </span>
            <span className="font-mono text-[11px] tabular-nums text-foreground">
              {totalHoldings > 0 ? formatZAR(totalHoldings) : "—"}
            </span>
          </div>
        </div>
      )}
    </GlassSection>
  );
}
