"use client";

import { useQuery } from "@tanstack/react-query";
import { iressConfig } from "@/lib/iress";

interface ProvenanceResponse {
  mode: string;
  counts: { LIVE: number; MOCK: number; SEED: number; HYBRID: number; PENDING: number };
  session: { ok: boolean; started: boolean };
}

/** Dev-only strip showing IRESS mode, session status, and provenance counts. */
export function ProvenanceStrip() {
  if (process.env.NODE_ENV !== "development") return null;

  const q = useQuery({
    queryKey: ["iress-provenance"],
    queryFn: async (): Promise<ProvenanceResponse> => {
      const res = await fetch("/api/iress/provenance");
      if (!res.ok) throw new Error(`provenance ${res.status}`);
      return res.json();
    },
    staleTime: 30_000,
    refetchInterval: 60_000,
  });

  const counts = q.data?.counts;
  const sessionOk = q.data?.session?.ok ?? false;
  const mode = q.data?.mode ?? iressConfig.mode;

  return (
    <div className="hidden items-center gap-2 rounded-md border border-dashed border-border/80 bg-muted/30 px-2 py-0.5 font-mono text-[9px] text-muted-foreground lg:flex">
      <span>IRESS_MODE={mode}</span>
      <span className="text-muted-foreground/50">|</span>
      <span className={sessionOk ? "text-success" : "text-destructive"}>
        Session: {sessionOk ? "ok" : "fail"}
      </span>
      {counts && (
        <>
          <span className="text-muted-foreground/50">|</span>
          <span>Live: {counts.LIVE + counts.HYBRID}</span>
          <span>Seed: {counts.SEED}</span>
          <span>Mock: {counts.MOCK}</span>
        </>
      )}
    </div>
  );
}
