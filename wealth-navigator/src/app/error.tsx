"use client";

import { useEffect } from "react";
import Link from "next/link";
import { AlertOctagon, RefreshCw, Activity, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Pill } from "@/components/oems/primitives/pill";

/**
 * On-brand runtime error boundary — matches the login page's centered
 * card-on-canvas feel. The full error is logged to the console (with
 * the digest) so a developer can find it. The user sees a "Try again"
 * CTA that calls `reset()` to re-render the failed segment.
 */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    // eslint-disable-next-line no-console
    console.error("[global-error]", error);
  }, [error]);

  return (
    <div className="flex min-h-screen w-full items-center justify-center bg-canvas p-4 sm:p-6">
      <div className="w-full max-w-md rounded-2xl border border-border bg-card p-8 text-center shadow-2xl">
        <div className="mb-6 flex items-center justify-between">
          <Brand />
          <Pill tone="destructive" size="xs" dot>ERROR</Pill>
        </div>
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-destructive/10 text-destructive">
          <AlertOctagon className="h-6 w-6" />
        </div>
        <h1 className="text-2xl font-semibold tracking-tight">Something broke</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          The desk hit an unrecoverable error rendering this surface. The full error is in the browser console.
        </p>
        {error.digest && (
          <p className="mt-3 font-mono text-[10.5px] text-muted-foreground/70">digest · {error.digest}</p>
        )}
        <div className="mt-6 flex items-center justify-center gap-2">
          <Button onClick={reset} className="gap-1.5">
            <RefreshCw className="h-3.5 w-3.5" /> Try again
          </Button>
          <Link href="/oems">
            <Button variant="outline" className="gap-1.5"><Activity className="h-3.5 w-3.5" /> Open OEMS desk</Button>
          </Link>
        </div>
        <p className="mt-6 font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70">
          Mint Wealth Navigator · IRESS V4 wired
        </p>
      </div>
    </div>
  );
}

function Brand() {
  return (
    <span className="flex items-center gap-2.5">
      <span className="relative flex h-7 w-7 items-center justify-center overflow-hidden rounded-md bg-gradient-to-br from-primary to-primary/40 text-primary-foreground">
        <Sparkles className="h-3.5 w-3.5" />
      </span>
      <span className="text-sm font-semibold tracking-tight">Mint Wealth Navigator</span>
    </span>
  );
}
