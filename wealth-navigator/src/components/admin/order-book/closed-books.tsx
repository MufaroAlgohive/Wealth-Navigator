"use client";

import { ChevronRight } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { usePolling } from "@/lib/hooks/use-polling";
import { cn } from "@/lib/cn";
import { CrmOrderBreakdown } from "./crm-order-breakdown";
import type { OrderBookSummary } from "./execution-view";

interface OrderBooksPayload {
  ok: boolean;
  books?: OrderBookSummary[];
  notice?: string;
  error?: string;
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-ZA", {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}

/**
 * Closed Books — mirrors MyMintAdmin's Closed Books tab (public/orderbook.html:
 * "Books move here once every holding has a fill date"). A book lands here
 * after "Move to Closed Book" on the Active/Manual Order Books archive
 * (close-book/route.ts). Shared across every admin (closed_at lives in
 * oems_order_book, not localStorage).
 *
 * "Email Sent" / "Email Failed" (retryable) mirrors the CRM's per-book chip —
 * closing a book is never blocked on the confirmation email succeeding, so a
 * failed send is retried from here without re-closing.
 */
export function ClosedBooks({ sources }: { sources?: string[] } = {}) {
  const query = sources?.length ? `?source=${encodeURIComponent(sources.join(","))}` : "";
  const { data, error, loading, refresh } = usePolling<OrderBooksPayload>(`/api/admin/orderbook/order-books${query}`, { interval: 10_000 });
  const books = (data?.books ?? []).filter((b) => !!b.closed_at);
  const [expanded, setExpanded] = React.useState<Set<string>>(new Set());
  const toggle = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const [busy, setBusy] = React.useState<Record<string, boolean>>({});

  const retryEmail = async (book: OrderBookSummary) => {
    const key = book.archive_id ?? String(book.sequence);
    setBusy((p) => ({ ...p, [key]: true }));
    try {
      const res = await fetch("/api/admin/orderbook/close-book", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sequence: book.sequence, archive_id: book.archive_id, origin: book.origin, closed: true, retry_email: true }),
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; email_status?: string };
      if (!res.ok || body.ok === false) {
        toast.error(body.error ?? `Retry failed (${res.status})`);
      } else {
        toast[body.email_status === "sent" ? "success" : "error"](
          body.email_status === "sent" ? `Order Book ${book.sequence} confirmation resent.` : "Retry failed again — check RESEND_API_KEY / recipients.",
        );
      }
      await refresh?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Retry failed");
    } finally {
      setBusy((p) => ({ ...p, [key]: false }));
    }
  };

  const reopen = async (book: OrderBookSummary) => {
    const key = book.archive_id ?? String(book.sequence);
    setBusy((p) => ({ ...p, [key]: true }));
    try {
      const res = await fetch("/api/admin/orderbook/close-book", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sequence: book.sequence, archive_id: book.archive_id, origin: book.origin, closed: false }),
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || body.ok === false) {
        toast.error(body.error ?? `Reopen failed (${res.status})`);
      } else {
        toast.success(`Order Book ${book.sequence} reopened — back on the live archive.`);
      }
      await refresh?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Reopen failed");
    } finally {
      setBusy((p) => ({ ...p, [key]: false }));
    }
  };

  return (
    <div className="w-full rounded-xl border border-border bg-card/40 overflow-hidden">
      <div className="border-b border-border px-4 py-2.5">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Closed Books</span>
        <div className="mt-0.5 text-[11px] text-muted-foreground">
          Books move here once an admin clicks &ldquo;Move to Closed Book&rdquo;.
        </div>
      </div>
      {error || data?.ok === false || data?.notice ? (
        <div className="border-b border-border px-4 py-2 text-[11px] text-destructive">
          {error?.message ?? data?.error ?? data?.notice ?? "The closed-book archive could not be loaded."}
        </div>
      ) : null}
      <div className="divide-y divide-border/40">
        {loading ? (
          <div className="px-4 py-6 text-center text-[12px] text-muted-foreground">Loading closed books...</div>
        ) : books.length === 0 ? (
          <div className="px-4 py-6 text-center text-[12px] text-muted-foreground">No closed books yet.</div>
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
                    <ChevronRight className={cn("h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
                    {b.title ?? `Order Book ${b.sequence}`}: {fmtDate(b.released_at)}
                  </button>
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] text-muted-foreground">Closed: {fmtDate(b.closed_at)}{b.closed_by ? ` · ${b.closed_by}` : ""}</span>
                    <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{b.filled_count}/{b.total_count} filled</span>
                    {b.email_status === "sent" ? (
                      <Badge variant="success" className="text-[9px]" title={b.email_sent_at ? `Sent ${fmtDate(b.email_sent_at)}` : undefined}>
                        Email Sent
                      </Badge>
                    ) : b.origin === "crm" ? (
                      <Badge variant="outline" className="text-[9px]">CRM</Badge>
                    ) : (
                      <Button
                        variant="destructive"
                        size="sm"
                        disabled={!!busy[bookKey]}
                        onClick={() => void retryEmail(b)}
                        title={b.email_error ?? "Retry the confirmation email"}
                        className="h-6 px-2 text-[10px]"
                      >
                        {busy[bookKey] ? "Retrying…" : "Email Failed — Retry"}
                      </Button>
                    )}
                    <Button variant="ghost" size="sm" disabled={!!busy[bookKey]} onClick={() => void reopen(b)}>
                      Reopen
                    </Button>
                  </div>
                </div>
                {open ? (
                  <div className="overflow-x-auto border-t border-border/40 bg-background/40 px-4 py-2">
                    {members.length === 0 ? (
                      <div className="py-3 text-center text-[11px] text-muted-foreground">No member orders returned for this book.</div>
                    ) : (
                      <table className="w-full border-collapse text-[11px]">
                        <thead>
                          <tr className="text-left text-[10px] uppercase tracking-wider text-muted-foreground">
                            <th className="py-1 pr-3 font-semibold">Order</th>
                            <th className="py-1 pr-3 font-semibold">Client</th>
                            <th className="py-1 pr-3 font-semibold">Symbol</th>
                            <th className="py-1 pr-3 font-semibold">Side</th>
                            <th className="py-1 pr-3 text-right font-semibold">Qty</th>
                            <th className="py-1 pr-3 text-right font-semibold">Avg fill</th>
                            <th className="py-1 pr-3 text-right font-semibold">Value</th>
                          </tr>
                        </thead>
                        <tbody>
                          {members.map((m) => (
                            <React.Fragment key={m.id}>
                            <tr className="border-t border-border/30">
                              <td className="py-1.5 pr-3 font-mono text-[10px]">{m.order_id ?? "—"}</td>
                              <td className="max-w-[180px] truncate py-1.5 pr-3" title={m.client_account ?? ""}>{m.client_account ?? "—"}</td>
                              <td className="py-1.5 pr-3 font-semibold">{m.symbol ?? "—"}</td>
                              <td className="py-1.5 pr-3"><Badge variant={m.side === "SELL" ? "destructive" : "success"} className="text-[9px]">{m.side}</Badge></td>
                              <td className="py-1.5 pr-3 text-right tabular-nums">{m.qty}</td>
                              <td className="py-1.5 pr-3 text-right font-semibold tabular-nums">
                                {m.avg_fill_price_rands != null ? `R${m.avg_fill_price_rands.toFixed(2)}` : "—"}
                              </td>
                              <td className="py-1.5 pr-3 text-right tabular-nums">
                                {m.value_rands != null ? `R${m.value_rands.toFixed(2)}` : "—"}
                              </td>
                            </tr>
                            {m.crm_details ? (
                              <tr>
                                <td colSpan={7} className="p-0">
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

export default ClosedBooks;
