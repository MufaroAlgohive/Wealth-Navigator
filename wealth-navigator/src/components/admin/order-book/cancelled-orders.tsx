"use client";

/**
 * Cancelled tab — the parking lot for orders the desk cancelled. These are
 * split OUT of the live blotter (execution route hides status='cancelled' from
 * the default view) so a cancel gets the order off the working screen. Here the
 * desk can review them and, if they're clutter (a fat-fingered test order, a
 * wrong ticker), permanently delete them.
 *
 * Delete is password-guarded: it re-verifies the admin's own password
 * server-side before removing the audit row, and the server refuses to delete
 * anything that isn't status='cancelled'. See delete-cancelled/route.ts.
 */

import * as React from "react";
import { toast } from "sonner";
import { Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { usePolling } from "@/lib/hooks/use-polling";

interface CancelledRow {
  id: string;
  order_id: string | null;
  symbol: string;
  side: string;
  qty: number;
  strategy: string | null;
  client_account: string | null;
  sent_by: string | null;
  updated_at: string | null;
  source: string;
}

interface ExecutionPayload {
  ok?: boolean;
  rows?: CancelledRow[];
  notice?: string;
}

const th = "px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-wider text-muted-foreground whitespace-nowrap";
const td = "px-3 py-2 text-[12px] text-foreground whitespace-nowrap";

const fmtDate = (iso: string | null) => {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "—"
    : d.toLocaleString("en-ZA", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
};

// Matches the live blotter's source scope so the Cancelled tab covers the same
// universe of orders (manual desk orders + UAT ad-hoc + forwarded mint client
// orders). Keep in sync with the ExecutionView `sources` on the Manual Orders
// tab — a source missing here means a cancelled order of that kind never shows.
const SOURCES = "MANUAL_CLIENT_ORDER,UAT_ADHOC_ORDER,MINT_CLIENT_ORDER";

export function CancelledOrders() {
  const cancelled = usePolling<ExecutionPayload>(
    `/api/admin/orderbook/execution?status=cancelled&source=${encodeURIComponent(SOURCES)}`,
    { interval: 10_000 },
  );
  const rows = cancelled.data?.rows ?? [];

  const [target, setTarget] = React.useState<CancelledRow | null>(null);
  const [password, setPassword] = React.useState("");
  const [deleting, setDeleting] = React.useState(false);

  const closeDialog = () => {
    setTarget(null);
    setPassword("");
    setDeleting(false);
  };

  const confirmDelete = async () => {
    if (!target || !password.trim()) return;
    setDeleting(true);
    try {
      const res = await fetch("/api/admin/orderbook/delete-cancelled", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ order_audit_id: target.id, password }),
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || body.ok === false) {
        toast.error(body.error ?? `Delete failed (${res.status})`);
        setDeleting(false);
        return;
      }
      toast.success(`Deleted cancelled order ${target.symbol}`);
      closeDialog();
      await cancelled.refresh?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Delete failed");
      setDeleting(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="overflow-x-auto rounded-xl border border-border">
        <table className="w-full border-collapse">
          <thead>
            <tr className="border-b border-border bg-card">
              {["Instrument", "Side", "Qty", "Strategy / Book", "Account", "Cancelled By", "Cancelled At", ""].map((c) => (
                <th key={c} className={th}>{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {cancelled.loading && rows.length === 0 ? (
              <tr><td colSpan={8} className="px-3 py-12 text-center text-sm text-muted-foreground">Loading…</td></tr>
            ) : rows.length === 0 ? (
              <tr><td colSpan={8} className="px-3 py-12 text-center text-sm text-muted-foreground">No cancelled orders.</td></tr>
            ) : rows.map((r) => (
              <tr key={r.id} className="border-b border-border/40 last:border-b-0 hover:bg-accent/10">
                <td className={td}><span className="font-semibold">{r.symbol}</span></td>
                <td className={td}><Badge variant={r.side === "SELL" ? "destructive" : "success"}>{r.side}</Badge></td>
                <td className={td}>{r.qty}</td>
                <td className={td}>{r.strategy ?? "—"}</td>
                <td className={td}>{r.client_account ?? "—"}</td>
                <td className={td}>{r.sent_by ?? "—"}</td>
                <td className={`${td} text-muted-foreground`}>{fmtDate(r.updated_at)}</td>
                <td className={td}>
                  <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={() => setTarget(r)}>
                    <Trash2 className="h-3.5 w-3.5" /> Delete
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Dialog open={target !== null} onOpenChange={(open) => { if (!open) closeDialog(); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete cancelled order</DialogTitle>
            <DialogDescription>
              {target ? (
                <>Permanently remove the cancelled <span className="font-semibold">{target.side} {target.qty} {target.symbol}</span> audit row. This can&rsquo;t be undone. Enter your password to confirm.</>
              ) : null}
            </DialogDescription>
          </DialogHeader>
          <Input
            type="password"
            autoComplete="current-password"
            placeholder="Your password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && password.trim() && !deleting) void confirmDelete(); }}
          />
          <DialogFooter>
            <Button variant="ghost" onClick={closeDialog} disabled={deleting}>Cancel</Button>
            <Button variant="destructive" onClick={() => void confirmDelete()} disabled={deleting || !password.trim()}>
              {deleting ? "Deleting…" : "Delete permanently"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
