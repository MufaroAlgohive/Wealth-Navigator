"use client";

import * as React from "react";
import { toast } from "sonner";
import { ChevronRight } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { usePolling } from "@/lib/hooks/use-polling";
import type { OrderBookSummary } from "./execution-view";

interface OrderBooksPayload {
  ok: boolean;
  books?: OrderBookSummary[];
  notice?: string;
}

// Subset of the execution route's ExecutionRow — the fields shown in the
// expanded per-order view.
interface MemberRow {
  id: string;
  order_id: string | null;
  symbol: string;
  side: string;
  qty: number;
  filled: number | null;
  avg_fill_price: number | null;
  state: string;
  client_account: string | null;
  sent_by: string | null;
}

interface MembersPayload {
  ok: boolean;
  rows?: MemberRow[];
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

const R = (n: number | null | undefined) =>
  n == null || !Number.isFinite(n)
    ? "—"
    : new Intl.NumberFormat("en-ZA", { style: "currency", currency: "ZAR", minimumFractionDigits: 2 }).format(n);

const th = "px-3 py-1.5 text-left text-[9px] font-semibold uppercase tracking-wider text-muted-foreground whitespace-nowrap";
const td = "px-3 py-1.5 text-[11px] text-foreground whitespace-nowrap";

/** Expanded member-orders table for one book. Fetches on mount (i.e. on expand). */
function BookOrders({ sequence }: { sequence: number }) {
  const { data, loading } = usePolling<MembersPayload>(
    `/api/admin/orderbook/execution?order_book_seq=${sequence}`,
    { interval: 15_000 },
  );
  const rows = data?.rows ?? [];

  if (loading && rows.length === 0) {
    return <div className="px-4 py-4 text-center text-[11px] text-muted-foreground">Loading orders…</div>;
  }
  if (rows.length === 0) {
    return <div className="px-4 py-4 text-center text-[11px] text-muted-foreground">No orders found for this book.</div>;
  }
  return (
    <div className="overflow-x-auto bg-background/40">
      <table className="w-full border-collapse">
        <thead>
          <tr className="border-b border-border/50">
            {["Instrument", "Side", "Qty", "Filled", "Avg Fill", "Client", "State"].map((c) => (
              <th key={c} className={th}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-b border-border/25 last:border-b-0">
              <td className={`${td} font-semibold`}>{r.symbol}</td>
              <td className={td}>
                <Badge variant={r.side === "SELL" ? "destructive" : "success"} className="text-[9px]">{r.side}</Badge>
              </td>
              <td className={td}>{r.qty}</td>
              <td className={td}>{r.filled ?? 0}/{r.qty}</td>
              <td className={td}>{R(r.avg_fill_price)}</td>
              <td className={`${td} text-muted-foreground`}>{r.client_account ?? r.sent_by ?? "—"}</td>
              <td className={td}><Badge variant="outline" className="text-[9px]">{r.state}</Badge></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
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
 * Each book expands to show its member orders (fetched from the execution
 * route by `order_book_seq`), so the desk can see exactly what's in a book,
 * not just that one was archived.
 *
 * "Move to Closed Book" and the "EMAIL SENT" indicator are stubbed —
 * real STRATE settlement file generation and email-sending are a later
 * phase, matching how "Capture snapshot" / "Strate BIR export" are
 * already stubbed elsewhere on this admin page.
 */
export function ActiveOrderBooks() {
  const { data } = usePolling<OrderBooksPayload>("/api/admin/orderbook/order-books", { interval: 5_000 });
  const books = (data?.books ?? []).filter((b) => b.fully_filled);
  const [expanded, setExpanded] = React.useState<Set<number>>(new Set());
  const toggle = (seq: number) =>
    setExpanded((prev) => {
      const n = new Set(prev);
      n.has(seq) ? n.delete(seq) : n.add(seq);
      return n;
    });

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
          books.map((b) => {
            const open = expanded.has(b.sequence);
            return (
              <div key={b.sequence}>
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => toggle(b.sequence)}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") toggle(b.sequence); }}
                  className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 cursor-pointer hover:bg-accent/20"
                >
                  <div className="flex items-center gap-1.5 text-[12px] font-semibold text-foreground">
                    <ChevronRight className={`h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-90" : ""}`} />
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
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={(e) => { e.stopPropagation(); deferred("Move to Closed Book"); }}
                    >
                      Move to Closed Book
                    </Button>
                  </div>
                </div>
                {open && <BookOrders sequence={b.sequence} />}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

export default ActiveOrderBooks;
