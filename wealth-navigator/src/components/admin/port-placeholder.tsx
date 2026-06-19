import { Construction } from "lucide-react";

/**
 * Temporary placeholder for a Mint admin page whose React port is pending.
 * Keeps the merged shell fully navigable while pages are ported one by one.
 * Tracking: wealth-navigator/docs/MINT_FRONTEND_PARITY.md
 */
export function PortPlaceholder({
  title,
  parityRef,
  summary,
}: {
  title: string;
  /** Section in MINT_FRONTEND_PARITY.md, e.g. "C — Clients". */
  parityRef?: string;
  /** One-line description of what this page will do. */
  summary?: string;
}) {
  return (
    <div className="mx-auto max-w-2xl py-10">
      <div className="rounded-lg border border-dashed border-border bg-card/50 p-8 text-center">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-muted">
          <Construction className="h-6 w-6 text-muted-foreground" />
        </div>
        <h1 className="text-lg font-semibold text-foreground">{title}</h1>
        <p className="mt-1 text-sm text-muted-foreground">Porting in progress — React rebuild pending.</p>
        {summary && <p className="mt-3 text-sm text-foreground/80">{summary}</p>}
        {parityRef && (
          <p className="mt-4 font-mono text-[11px] text-muted-foreground">
            Parity spec: docs/MINT_FRONTEND_PARITY.md · {parityRef}
          </p>
        )}
      </div>
    </div>
  );
}
