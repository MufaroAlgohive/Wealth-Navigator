"use client";

import { Info, Mail, Send } from "lucide-react";
import type { Route } from "next";
import Link from "next/link";

import { GlassSection, PageCanvas } from "@/components/oems/primitives/glass";

const EMAILERS_PATH = "/oems/marketing/emailers" as Route;

/**
 * Marketing › Triggers — the marketing hub entry-point that bundles
 * Supabase-webhook triggers with emailer campaigns. The full editor lives at
 * Emailers (Webhook Triggers tab) until we break it into a sub-route.
 */
export default function TriggersPage() {
  return (
    <PageCanvas>
      <GlassSection title="Triggers" subtitle="Webhook + emailer automation hub" dataSource="supabase">
        <div className="flex flex-col items-start gap-3 py-3">
          <div className="flex items-center gap-2 rounded-lg border border-primary/30 bg-primary/10 px-3 py-2 text-[12px] text-foreground/80">
            <Info className="h-4 w-4 shrink-0 text-primary" />
            <span>
              The full editor (Supabase webhook URL, table mapping, email-type selection, and Send Logs) is
              reachable from{" "}
              <Link
                href={EMAILERS_PATH}
                className="font-semibold text-primary underline-offset-2 hover:underline"
              >
                Emailers &amp; Triggers → Webhook Triggers
              </Link>
              .
            </span>
          </div>
          <p className="text-caption max-w-2xl">
            This stub page exists to reserve the marketing URL space and route for the upcoming dedicated
            triggers editor. Wiring is gated on the trigger editor break-out being tracked under the
            finalisation plan.
          </p>
          <Link
            href={EMAILERS_PATH}
            className="inline-flex items-center gap-2 rounded-md border border-border bg-card px-3 py-1.5 text-[12px] text-foreground hover:bg-accent"
          >
            <Mail className="h-3.5 w-3.5" /> Open Emailers &amp; Triggers
            <Send className="h-3 w-3 text-muted-foreground" />
          </Link>
        </div>
      </GlassSection>
    </PageCanvas>
  );
}
