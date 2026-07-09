"use client";

/**
 * A7.6 — the JIBAR + instrument tables are dynamically imported from
 * `page.tsx` via `next/dynamic` so the page's KPI strip + header paint
 * first. The tables hold the heaviest DOM in the module (instrument
 * universe can run to a few hundred rows) and they were the reason the
 * page's first-paint time tracked the table render.
 */

import { EmptyDataState } from "@/components/oems/primitives/empty-data-state";
import { GlassSection } from "@/components/oems/primitives/glass";
import { Pill } from "@/components/oems/primitives/pill";
import { cn } from "@/lib/cn";
import { formatZAR } from "@/lib/format";

interface InstrumentRow {
  ticker: string;
  name: string;
  type: string;
  issuer: string;
  tenor: string;
  rating: string;
  yield: number;
  duration: number;
  notional: number;
  maturity: string;
}

interface JibarRow {
  tenor: string;
  rate: number;
  change: number;
  rateDate: string;
}

function GlassTableShell({ children }: { children: React.ReactNode }) {
  return <div className="glass-inset overflow-hidden">{children}</div>;
}

export function MoneyMarketTables({
  jibar,
  instruments,
  dataSource,
  isLoading,
}: {
  jibar: JibarRow[];
  instruments: InstrumentRow[];
  dataSource: "blocked-external" | "supabase";
  isLoading: boolean;
}) {
  if (isLoading && jibar.length === 0 && instruments.length === 0) {
    return (
      <>
        <GlassSection
          title="JIBAR fixings"
          endpoint="GET /api/money-market"
          db="institutional"
          dataSource={dataSource}
          className="col-span-12 lg:col-span-4"
          noPadding
        >
          <div className="space-y-2 p-4">
            <div className="h-7 w-full animate-pulse rounded bg-[hsl(var(--foreground)/0.05)]" />
            <div className="h-7 w-full animate-pulse rounded bg-[hsl(var(--foreground)/0.04)]" />
            <div className="h-7 w-full animate-pulse rounded bg-[hsl(var(--foreground)/0.04)]" />
          </div>
        </GlassSection>
        <GlassSection
          title="Eligible money-market instruments"
          endpoint="GET /api/money-market"
          db="institutional"
          dataSource={dataSource}
          className="col-span-12 lg:col-span-8"
          noPadding
        >
          <div className="space-y-2 p-4">
            <div className="h-7 w-full animate-pulse rounded bg-[hsl(var(--foreground)/0.04)]" />
            <div className="h-7 w-full animate-pulse rounded bg-[hsl(var(--foreground)/0.04)]" />
            <div className="h-7 w-full animate-pulse rounded bg-[hsl(var(--foreground)/0.04)]" />
          </div>
        </GlassSection>
      </>
    );
  }

  return (
    <>
      <GlassSection
        title="JIBAR fixings"
        endpoint="GET /api/money-market"
        db="institutional"
        dataSource={dataSource}
        className="col-span-12 lg:col-span-4"
        noPadding
      >
        {jibar.length === 0 ? (
          <div className="p-5">
            <EmptyDataState message="No JIBAR fixings ingested." />
          </div>
        ) : (
          <GlassTableShell>
            <table className="w-full font-mono text-xs">
              <tbody>
                {jibar.map((f) => (
                  <tr
                    key={`${f.tenor}-${f.rateDate}`}
                    className="border-b border-[hsl(var(--glass-border))]/60 transition-colors last:border-0 hover:bg-[hsl(var(--primary)/0.04)]"
                  >
                    <td className="px-4 py-2.5 font-semibold">{f.tenor}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{f.rate.toFixed(2)}%</td>
                    <td
                      className={cn(
                        "px-4 py-2.5 text-right font-mono text-[10px]",
                        f.change > 0
                          ? "text-success"
                          : f.change < 0
                            ? "text-destructive"
                            : "text-muted-foreground",
                      )}
                    >
                      {f.change > 0 ? "+" : ""}
                      {(f.change * 100).toFixed(0)}bp
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </GlassTableShell>
        )}
      </GlassSection>

      <GlassSection
        title="Eligible money-market instruments"
        endpoint="GET /api/money-market"
        db="institutional"
        dataSource={dataSource}
        className="col-span-12 lg:col-span-8"
        noPadding
        right={
          <Pill tone="primary" size="xs">
            {instruments.length} ELIGIBLE
          </Pill>
        }
      >
        {instruments.length === 0 ? (
          <div className="p-5">
            <EmptyDataState
              message="No MM instruments ingested."
              hint="Provide IRESS rate data or connect a vendor feed to populate money market instruments."
            />
          </div>
        ) : (
          <GlassTableShell>
            <div className="overflow-x-auto scrollbar-thin">
              <table className="w-full min-w-[640px] font-mono text-xs">
                <thead>
                  <tr className="border-b border-[hsl(var(--glass-border))] bg-[hsl(var(--foreground)/0.02)] text-[9.5px] uppercase tracking-wider text-muted-foreground">
                    <th className="px-4 py-2.5 text-left font-medium">Ticker</th>
                    <th className="px-4 py-2.5 text-left font-medium">Type</th>
                    <th className="px-4 py-2.5 text-left font-medium">Issuer</th>
                    <th className="px-4 py-2.5 text-left font-medium">Tenor</th>
                    <th className="px-4 py-2.5 text-left font-medium">Rating</th>
                    <th className="px-4 py-2.5 text-right font-medium">Yield</th>
                    <th className="px-4 py-2.5 text-right font-medium">Duration</th>
                    <th className="px-4 py-2.5 text-right font-medium">Notional</th>
                  </tr>
                </thead>
                <tbody>
                  {instruments.map((i) => (
                    <tr
                      key={i.ticker}
                      className="border-b border-[hsl(var(--glass-border))]/60 transition-colors last:border-0 hover:bg-[hsl(var(--primary)/0.04)]"
                    >
                      <td className="px-4 py-2 font-semibold">{i.ticker}</td>
                      <td className="px-4 py-2">
                        <Pill tone="neutral" size="xs">
                          {i.type}
                        </Pill>
                      </td>
                      <td className="px-4 py-2 text-muted-foreground">{i.issuer}</td>
                      <td className="px-4 py-2">{i.tenor}</td>
                      <td className="px-4 py-2">
                        <Pill tone={i.rating.startsWith("AA") ? "success" : "warning"} size="xs">
                          {i.rating}
                        </Pill>
                      </td>
                      <td className="px-4 py-2 text-right font-semibold tabular-nums">
                        {i.yield.toFixed(2)}%
                      </td>
                      <td className="px-4 py-2 text-right text-muted-foreground tabular-nums">
                        {i.duration.toFixed(2)}y
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums">{formatZAR(i.notional)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </GlassTableShell>
        )}
      </GlassSection>
    </>
  );
}
