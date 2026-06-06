"use client";

import Link from "next/link";
import { Compass, Home, Activity, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Pill } from "@/components/oems/primitives/pill";

/**
 * On-brand 404 — matches the login page's centered-card-on-canvas feel
 * (a carded panel with a Mint badge at the top, a status pill, a
 * headline, body, and two CTAs). Avoids being a plain shadcn placeholder.
 */
export default function NotFound() {
  return (
    <div className="flex min-h-screen w-full items-center justify-center bg-canvas p-4 sm:p-6">
      <div className="w-full max-w-md rounded-2xl border border-border bg-card p-8 text-center shadow-2xl">
        <div className="mb-6 flex items-center justify-between">
          <Brand />
          <Pill tone="warning" size="xs" dot>404</Pill>
        </div>
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <Compass className="h-6 w-6" />
        </div>
        <h1 className="text-2xl font-semibold tracking-tight">Off the curve</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          We couldn&apos;t find this page. From the OEMS desk the side nav covers every primary surface.
        </p>
        <div className="mt-6 flex items-center justify-center gap-2">
          <Link href="/oems">
            <Button className="gap-1.5"><Activity className="h-3.5 w-3.5" /> Open OEMS desk</Button>
          </Link>
          <Link href="/">
            <Button variant="outline" className="gap-1.5"><Home className="h-3.5 w-3.5" /> Go home</Button>
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
