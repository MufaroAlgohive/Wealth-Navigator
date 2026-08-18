"use client";

import { ChevronRight } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { usePolling } from "@/lib/hooks/use-polling";
import { cn } from "@/lib/cn";
import { CrmOrderBreakdown } from "./crm-order-breakdown";
import type { OrderBookMember, OrderBookSummary } from "./execution-view";

interface OrderBooksPayload {
  ok: boolean;
  books?: OrderBookSummary[];
  notice?: string;
  error?: string;
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
  const query = sources?.length ? `?source=${encodeURIComponent(sources.join(","))}` : "";
  const { data, error, loading, refresh } = usePolling<OrderBooksPayload>(`/api/admin/orderbook/order-books${query}`, { interval: 5_000 });
  // Fully filled AND not yet moved to Closed Books — a closed book lives only
  // on the Closed Books tab from here on.
  const books = (data?.books ?? []).filter((b) => b.fully_filled && !b.closed_at);
  const [expanded, setExpanded] = React.useState<Set<string>>(new Set());
  const toggle = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const [sending, setSending] = React.useState<Record<string, boolean>>({});
  const sendConfirmation = async (member: OrderBookMember, book: OrderBookSummary) => {
    const key = member.id;
    setSending((p) => ({ ...p, [key]: true }));
    try {
      // CRM-sourced members carry id="crm-${sourceId}" (see order-books/
      // route.ts's crmMember()), where sourceId IS stock_holdings_c.id. The
      // API needs that raw id to find the order at all -- member.order_id
      // for a CRM row is a display-only settlement reference (e.g.
      // "BND-20260727-4001") that was never written to oems_order_audit, so
      // sending only that 404'd for every CRM order.
      const isCrm = book.origin === "crm";
      const res = await fetch("/api/admin/orderbook/send-confirmation", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          order_id: member.order_id || member.id,
          book_id: book.archive_id ?? String(book.sequence),
          origin: book.origin ?? "oem",
          ...(isCrm ? { source_ids: [member.id.replace(/^crm-/, "")] } : {}),
        }),
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || body.ok === false) {
        toast.error(body.error ?? `Send Confirmation failed (${res.status})`);
        return;
      }
      toast.success(`Confirmation sent for order ${member.order_id ?? member.id}`);
      await refresh?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Send Confirmation failed");
    } finally {
      setSending((p) => ({ ...p, [key]: false }));
    }
  };

  const [closing, setClosing] = React.useState<Record<string, boolean>>({});
  const moveToClosed = async (book: OrderBookSummary) => {
    const key = book.archive_id ?? String(book.sequence);
    setClosing((p) => ({ ...p, [key]: true }));
    try {
      const res = await fetch("/api/admin/orderbook/close-book", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sequence: book.sequence,
          archive_id: book.archive_id,
          origin: book.origin,
          closed: true,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; email_status?: string };
      if (!res.ok || body.ok === false) {
        toast.error(body.error ?? `Move to Closed Book failed (${res.status})`);
        return;
      }
      toast.success(
        book.origin === "crm"
          ? `${book.title ?? `Order Book ${book.sequence}`} moved to Closed Books.`
          : body.email_status === "sent"
            ? `Order Book ${book.sequence} closed — confirmation emailed.`
            : `Order Book ${book.sequence} closed — confirmation email failed (retry from Closed Books).`,
      );
      await refresh?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Move to Closed Book failed");
    } finally {
      setClosing((p) => ({ ...p, [key]: false }));
    }
  };

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
      {error || data?.ok === false || data?.notice ? (
        <div className="border-b border-border px-4 py-2 text-[11px] text-destructive">
          {error?.message ?? data?.error ?? data?.notice ?? "The order-book archive could not be loaded."}
        </div>
      ) : null}
      <div className="divide-y divide-border/40">
        {loading ? (
          <div className="px-4 py-6 text-center text-[12px] text-muted-foreground">Loading order books...</div>
        ) : books.length === 0 ? (
          <div className="px-4 py-6 text-center text-[12px] text-muted-foreground">No archived order books yet.</div>
        ) : (
          books.map((b) => {
            const bookKey = b.archive_id ?? `${b.origin ?? "oem"}-${b.sequence}`;
            const open = expanded.has(bookKey);
            const members = b.members ?? [];
            return (
              <div key={bookKey}>
                <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5">
                  <button
                    type="button"
                    onClick={() => toggle(bookKey)}
                    className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-foreground hover:underline"
                    aria-expanded={open}
                  >
                    <ChevronRight
                      className={cn("h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")}
                    />
                    {b.title ?? `Order Book ${b.sequence}`}: {fmtReleasedAt(b.released_at)}
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
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={!!closing[bookKey]}
                      onClick={() => void moveToClosed(b)}
                      title="Emails a CSV of this book's fills to the desk, then moves it to Closed Books."
                    >
                      {closing[bookKey] ? "Closing…" : "Move to Closed Book"}
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
                            <th className="py-1 pr-3 font-semibold text-right">Action</th>
                          </tr>
                        </thead>
                        <tbody>
                          {members.map((m) => (
                            <React.Fragment key={m.id}>
                            <tr className="border-t border-border/30">
                              <td className="py-1.5 pr-3 font-mono text-[10px]">{m.order_id ?? "—"}</td>
                              <td className="max-w-[180px] truncate py-1.5 pr-3" title={m.client_account ?? ""}>
                                <div>{m.client_account ?? "—"}</div>
                                {m.parentName && <div className="text-[9px] mt-0.5 opacity-80">Managed by {m.parentName}</div>}
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
                              <td className="py-1.5 pr-3 text-right">
                                {m.status === "filled" ? (
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    className="h-6 text-[10px]"
                                    disabled={!!sending[m.id]}
                                    onClick={() => void sendConfirmation(m, b)}
                                    title="Sends trade confirmation emails to client."
                                  >
                                    {sending[m.id] ? "Sending…" : "Send Confirm"}
                                  </Button>
                                ) : (
                                  <span className="text-[10px] text-muted-foreground">—</span>
                                )}
                              </td>
                            </tr>
                            {m.crm_details ? (
                              <tr>
                                <td colSpan={14} className="p-0">
                                  <CrmOrderBreakdown member={m} bookId={b.archive_id ?? String(b.sequence)} />
                                </td>
                              </tr>
                            ) : null}
                            </React.Fragment>
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
