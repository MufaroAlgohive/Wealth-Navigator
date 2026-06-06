"use client";

import { useQuery } from "@tanstack/react-query";
import { Panel } from "@/components/oems/primitives/panel";
import { Pill } from "@/components/oems/primitives/pill";
import { useIress } from "@/lib/iress/provider";
import { iressConfig } from "@/lib/iress";

export default function SettingsPage() {
  const { data } = useIress();
  const epQ = useQuery({ queryKey: ["endpoints"], queryFn: () => data.endpoints() });
  const endpoints = epQ.data ?? [];

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-8">
      <div>
        <Pill tone="primary" size="sm" className="mb-3">Settings</Pill>
        <h1 className="text-2xl font-semibold tracking-tight">Application · environment</h1>
        <p className="mt-1 text-sm text-muted-foreground">Read-only view of the running configuration. Override via environment variables.</p>
      </div>

      <Panel title="IRESS adapter" endpoint="iress.config">
        <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-3">
          {Object.entries(iressConfig).map(([k, v]) => (
            <div key={k} className="rounded-md border border-border/60 bg-surface-2/30 p-2">
              <p className="text-[9.5px] uppercase tracking-wider text-muted-foreground">{k}</p>
              <p className="mt-0.5 break-all font-mono text-xs font-semibold">
                {Array.isArray(v) ? v.join(", ") : String(v)}
              </p>
            </div>
          ))}
        </div>
      </Panel>

      <Panel title="Endpoint health snapshot" endpoint="iress.health" density="scroll">
        <table className="w-full font-mono text-xs">
          <tbody className="divide-y divide-border/60">
            {endpoints.map((e) => (
              <tr key={e.name}>
                <td className="px-2.5 py-1.5 font-semibold">{e.name}</td>
                <td className="px-2.5 py-1.5 text-muted-foreground">{e.method}</td>
                <td className="px-2.5 py-1.5 text-right">p95 {e.p95}ms</td>
                <td className="px-2.5 py-1.5"><Pill tone={e.status === "ok" ? "success" : "warning"} size="xs" dot>{e.status}</Pill></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
    </div>
  );
}
