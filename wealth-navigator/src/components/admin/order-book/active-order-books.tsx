"use client";

import { ChevronRight } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { usePolling } from "@/lib/hooks/use-polling";
import { cn } from "@/lib/cn";
import type { OrderBookSummary } from "./execution-view";

interface OrderBooksPayload {
  ok: boolean;
  books?: OrderBookSummary[];
  notice?: string;
}

/** Rands, en-ZA. Returns an em dash for null so an empty cell is unambiguous. */
function fmtRands(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return `R${v.toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
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
export function ActiveOrderBooks({ sources }: { sources?: string[] } = {}) {
  const query = sources && sources.length ? `?source=${encodeURIComponent(sources.join(","))}` : "";
  const { data } = usePolling<OrderBooksPayload>(`/api/admin/orderbook/order-books${query}`, { interval: 5_000 });
  const books = (data?.books ?? []).filter((b) => b.fully_filled);
  const [expanded, setExpanded] = React.useState<Set<number>>(new Set());
  const toggle = (seq: number) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(seq)) next.delete(seq);
      else next.add(seq);
      return next;
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
            const members = b.members ?? [];
            return (
              <div key={b.sequence}>
                <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5">
                  <button
                    type="button"
                    onClick={() => toggle(b.sequence)}
                    className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-foreground hover:underline"
                    aria-expanded={open}
                  >
                    <ChevronRight
                      className={cn("h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")}
                    />
                    Order Book {b.sequence}: {fmtReleasedAt(b.released_at)}
                  </button>
                  <div className="flex items-center gap-2">
                    {/* The money figure belongs on the collapsed row — the whole
                        point of this panel is "what did the desk actually
                        execute", and that was previously invisible. */}
                    {b.filled_value_rands != null && b.filled_value_rands > 0 ? (
                      <span className="text-[11px] font-semibold tabular-nums text-foreground">
                        {fmtRands(b.filled_value_rands)}
                      </span>
                    ) : null}
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
                {open ? (
                  <div className="overflow-x-auto border-t border-border/40 bg-background/40 px-4 py-2">
                    {members.length === 0 ? (
                      <div className="py-3 text-center text-[11px] text-muted-foreground">
                        No member orders returned for this book.
                      </div>
                    ) : (
                      <table className="w-full border-collapse text-[11px]">
                        <thead>
                          <tr className="text-left text-[10px] uppercase tracking-wider text-muted-foreground">
                            <th className="py-1 pr-3 font-semibold">Order</th>
                            <th className="py-1 pr-3 font-semibold">Client</th>
                            <th className="py-1 pr-3 font-semibold">Symbol</th>
                            <th className="py-1 pr-3 font-semibold">Side</th>
                            <th className="py-1 pr-3 text-right font-semibold">Qty</th>
                            <th className="py-1 pr-3 text-right font-semibold">Filled</th>
                            <th className="py-1 pr-3 font-semibold">Type</th>
                            <th className="py-1 pr-3 text-right font-semibold">Limit</th>
                            <th className="py-1 pr-3 text-right font-semibold">Avg fill</th>
                            <th className="py-1 pr-3 text-right font-semibold">Value</th>
                            <th className="py-1 pr-3 font-semibold">Venue</th>
                            <th className="py-1 pr-3 font-semibold">State</th>
                            <th className="py-1 pr-3 font-semibold">Filled at</th>
                          </tr>
                        </thead>
                        <tbody>
                          {members.map((m) => (
                            <tr key={m.id} className="border-t border-border/30">
                              <td className="py-1.5 pr-3 font-mono text-[10px]">{m.order_id ?? "—"}</td>
                              <td className="max-w-[180px] truncate py-1.5 pr-3" title={m.client_account ?? ""}>
                                {m.client_account ?? "—"}
                              </td>
                              <td className="py-1.5 pr-3 font-semibold">{m.symbol ?? "—"}</td>
                              <td className="py-1.5 pr-3">
                                <Badge variant={m.side === "SELL" ? "destructive" : "success"} className="text-[9px]">
                                  {m.side}
                                </Badge>
                              </td>
                              <td className="py-1.5 pr-3 text-right tabular-nums">{m.qty}</td>
                              <td className="py-1.5 pr-3 text-right tabular-nums">{m.filled}</td>
                              <td className="py-1.5 pr-3 uppercase text-muted-foreground">{m.order_type}</td>
                              <td className="py-1.5 pr-3 text-right tabular-nums">{fmtRands(m.limit_price_rands)}</td>
                              <td className="py-1.5 pr-3 text-right font-semibold tabular-nums">
                                {fmtRands(m.avg_fill_price_rands)}
                              </td>
                              <td className="py-1.5 pr-3 text-right tabular-nums">{fmtRands(m.value_rands)}</td>
                              <td className="py-1.5 pr-3 text-muted-foreground">{m.venue ?? "—"}</td>
                              <td className="py-1.5 pr-3">
                                <Badge
                                  variant={m.status === "filled" ? "success" : "outline"}
                                  className="text-[9px] uppercase"
                                  title={m.iress_error ?? m.last_action ?? undefined}
                                >
                                  {m.status}
                                </Badge>
                              </td>
                              <td className="py-1.5 pr-3 text-muted-foreground">{fmtReleasedAt(m.filled_at ?? "")}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                ) : null}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

export default ActiveOrderBooks;
