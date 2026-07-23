"use client";

import * as React from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { usePolling } from "@/lib/hooks/use-polling";
import type { OrderBookSummary } from "./execution-view";

interface OrderBooksPayload {
  ok: boolean;
  books?: OrderBookSummary[];
  notice?: string;
}

function fmtReleasedAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-ZA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/**
 * "Active Order Books" — CRM-style archive of fully-filled order-book
 * batches (see execution-view.tsx's `filterOutPromotedBooks`: once every
 * member order of a book reaches `filled`, it drops out of the live view
 * and shows up here instead). Deliberately a separate, simple polled
 * component with no SSE / liveOverrides reconciliation — every row here
 * is already terminal by definition, so ExecutionView's real-time
 * machinery doesn't apply.
 *
 * "Move to Closed Book" and the "EMAIL SENT" indicator are stubbed —
 * real STRATE settlement file generation and email-sending are a later
 * phase, matching how "Capture snapshot" / "Strate BIR export" are
 * already stubbed elsewhere on this admin page.
 */
export function ActiveOrderBooks() {
  const { data } = usePolling<OrderBooksPayload>("/api/admin/orderbook/order-books", { interval: 5_000 });
  const books = (data?.books ?? []).filter((b) => b.fully_filled);

  const deferred = (label: string) => toast.message(`${label} is deferred to the data phase (settlement writes).`);

  return (
    <div className="w-full rounded-xl border border-border bg-card/40 overflow-hidden">
      <div className="border-b border-border px-4 py-2.5">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Active Order Books
        </span>
        <div className="mt-0.5 text-[11px] text-muted-foreground">
          Orders move here automatically once fully filled. Sending stays manual.
        </div>
      </div>
      <div className="divide-y divide-border/40">
        {books.length === 0 ? (
          <div className="px-4 py-6 text-center text-[12px] text-muted-foreground">No archived order books yet.</div>
        ) : (
          books.map((b) => (
            <div key={b.sequence} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5">
              <div className="text-[12px] font-semibold text-foreground">
                Order Book {b.sequence}: {fmtReleasedAt(b.released_at)}
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[11px] text-muted-foreground">Sent: {fmtReleasedAt(b.released_at)}</span>
                <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  {b.filled_count}/{b.total_count} filled
                </span>
                <Badge
                  variant="outline"
                  className="text-[9px]"
                  title="Deferred — real email sending lands with the data phase."
                >
                  EMAIL SENT
                </Badge>
                <Button variant="secondary" size="sm" onClick={() => deferred("Move to Closed Book")}>
                  Move to Closed Book
                </Button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

export default ActiveOrderBooks;
