"use client";

import { Download } from "lucide-react";

import { Button } from "@/components/ui/button";
import { usePolling } from "@/lib/hooks/use-polling";

export function StrateBir({ scope = "live" }: { scope?: "live" | "uat" }) {
  const query = usePolling<{
    ok: boolean;
    lines?: string[];
    file_name?: string;
    client_count?: number;
    holding_count?: number;
    total_records?: number;
    error?: string;
  }>(`/api/admin/orderbook/crm-modules?module=bir&scope=${scope}`, { interval: 30_000 });
  const lines = query.data?.lines ?? [];
  const download = () => {
    if (!lines.length) return;
    const blob = new Blob([`${lines.join("\r\n")}\r\n`], { type: "text/plain;charset=utf-8" });
    const href = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = href;
    link.download = query.data?.file_name ?? "MINT_STRATE_BIR.txt";
    link.click();
    URL.revokeObjectURL(href);
  };

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card/40">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div>
          <h2 className="text-xs font-semibold uppercase text-muted-foreground">STRATE BIR Export</h2>
          <div className="mt-1 text-[11px] text-muted-foreground">
            {query.data?.total_records ?? 0} records · {query.data?.client_count ?? 0} clients ·{" "}
            {query.data?.holding_count ?? 0} holdings
          </div>
        </div>
        <Button size="sm" onClick={download} disabled={!lines.length}>
          <Download className="h-4 w-4" />
          Download BIR
        </Button>
      </div>
      {query.error || query.data?.error ? (
        <div className="px-4 py-3 text-xs text-destructive">{query.error?.message ?? query.data?.error}</div>
      ) : query.loading ? (
        <div className="px-4 py-8 text-center text-xs text-muted-foreground">Generating BIR preview...</div>
      ) : lines.length === 0 ? (
        <div className="px-4 py-8 text-center text-xs text-muted-foreground">No BIR records generated.</div>
      ) : (
        <div className="max-h-[620px] overflow-auto">
          <table className="w-full min-w-[920px] text-[11px]">
            <thead className="sticky top-0 bg-card">
              <tr className="text-left text-[10px] uppercase text-muted-foreground">
                <th className="px-3 py-2">Line</th><th className="px-3 py-2">Type</th>
                <th className="px-3 py-2">Record</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((line, index) => (
                <tr key={`${index}-${line}`} className="border-t border-border/30">
                  <td className="px-3 py-1.5 text-muted-foreground">{index + 1}</td>
                  <td className="px-3 py-1.5 font-semibold">{line.split("|")[0]}</td>
                  <td className="whitespace-nowrap px-3 py-1.5 font-mono text-[10px]">{line}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
