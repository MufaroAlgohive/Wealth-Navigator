"use client";

/**
 * OrderBookPage — Mint OEM Finalisation Phase UAT
 *
 * Top-level surface for the OEMS Order Book. Brings together:
 *  - UatBanner (yellow UAT-mode warning, polls /uat-status every 30s)
 *  - UatTestRunner (3 pre-canned scenarios that exercise the order pipeline)
 *  - ExecutionView (per-ISIN execution table with SSE live fill deltas)
 *  - bookId selector + manual send-to-market action
 *
 * The page is fully client-rendered; the server is only involved in the
 * initial HTML shell + RBAC. All data flows through the BFF (`/api/admin
 * /orderbook/*` and `/api/admin/orderbook/stream` SSE forwarder).
 *
 * Renders the existing ExecutionView even when UAT mode is off, so the
 * page is one consistent surface for both production and UAT. The UAT
 * banner + test runner are self-gated.
 */

import { Send } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/cn";

import { ExecutionView } from "./execution-view";
import { UatBanner } from "./uat-banner";
import { UatTestRunner } from "./uat-test-runner";

interface OrderBookStrategy {
  id: string;
  name?: string;
  [k: string]: unknown;
}

interface OrderBookStrategies {
  ok: boolean;
  strategies?: OrderBookStrategy[];
}

export function OrderBookPage() {
  const [bookId, setBookId] = React.useState<string>("");
  const [uatTest, setUatTest] = React.useState<boolean>(false);
  const [busy, setBusy] = React.useState<boolean>(false);
  const [strategies, setStrategies] = React.useState<OrderBookStrategy[]>([]);

  // Pull the available strategies from the same audit mirror the BFF uses.
  // We hit the retail holdings and group by strategy_name_snapshot.
  React.useEffect(() => {
    let cancelled = false;
    async function loadStrategies(): Promise<void> {
      try {
        const res = await fetch("/api/admin/strategies?action=list", { cache: "no-store" });
        if (!res.ok) return;
        const body = (await res.json()) as OrderBookStrategies;
        if (cancelled) return;
        if (body.ok && Array.isArray(body.strategies)) {
          setStrategies(body.strategies);
          if (!bookId && body.strategies[0]?.id) {
            setBookId(body.strategies[0].id);
          }
        }
      } catch {
        /* best-effort — leave empty so the user types a book id manually */
      }
    }
    void loadStrategies();
    return () => {
      cancelled = true;
    };
  }, [bookId]);

  const onSendToMarket = React.useCallback(async () => {
    if (!bookId) {
      toast.error("book_id is required");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/admin/orderbook/send-to-market", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          book_id: bookId,
          broker: "JSE",
          order_type: "limit",
          uat_test: uatTest,
        }),
      });
      const body = (await res.json()) as {
        ok: boolean;
        count?: number;
        error?: string;
        mode?: string;
        uat?: { sent: number; failed: number; notice: string | null };
        notice?: string;
      };
      if (!res.ok || !body.ok) {
        toast.error(body.error ?? `send-to-market ${res.status}`);
        return;
      }
      const uatBit = body.uat ? ` · UAT ${body.uat.sent}/${body.count ?? 0} sent` : "";
      toast.success(`Sent ${body.count ?? 0} orders to market (${body.mode ?? "audit-only"})${uatBit}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`send-to-market failed: ${msg}`);
    } finally {
      setBusy(false);
    }
  }, [bookId, uatTest]);

  return (
    <div className="space-y-4 p-4">
      <UatBanner />

      <Card className="border-border/60">
        <CardHeader className="pb-2">
          <CardTitle className="text-[12px] font-semibold uppercase tracking-wider text-muted-foreground">
            Send to Market
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex-1 min-w-[200px] space-y-1">
              <Label htmlFor="book-id" className="text-[10px] uppercase tracking-wider text-muted-foreground">
                Book ID (strategy)
              </Label>
              <Input
                id="book-id"
                value={bookId}
                onChange={(e) => setBookId(e.target.value)}
                placeholder="e.g. Yield-Basket-Mid-Cap or UAT-single-fill-abc123"
                className="h-8 font-mono text-[12px]"
                list="uat-strategies"
              />
              <datalist id="uat-strategies">
                {strategies.map((s) => {
                  const holdings = Array.isArray(s.holdings) ? (s.holdings as unknown[]).length : null;
                  return (
                    <option key={s.id} value={s.id}>
                      {typeof s.name === "string" ? s.name : s.id}
                      {holdings != null ? ` · ${holdings} holdings` : ""}
                    </option>
                  );
                })}
              </datalist>
            </div>
            <div className="flex items-center gap-2 pb-1">
              <input
                id="uat-test"
                type="checkbox"
                checked={uatTest}
                onChange={(e) => setUatTest(e.target.checked)}
                className="h-4 w-4 rounded border-border accent-warning"
              />
              <Label htmlFor="uat-test" className="text-[11px] text-muted-foreground">
                UAT test
                <Badge variant="outline" className="ml-1.5 text-[9px]">
                  IRESS_UAT_MODE
                </Badge>
              </Label>
            </div>
            <Button
              onClick={() => void onSendToMarket()}
              disabled={busy || !bookId}
              className={cn(
                "h-8",
                uatTest && "border-warning/40 bg-warning/10 text-warning hover:bg-warning/20",
              )}
              variant={uatTest ? "outline" : "default"}
            >
              <Send className="mr-1.5 h-3.5 w-3.5" />
              {busy ? "Sending…" : uatTest ? "Send to UAT" : "Send to Market"}
            </Button>
          </div>
          {strategies.length > 0 ? (
            <p className="text-[10px] text-muted-foreground">
              {strategies.length} strateg{strategies.length === 1 ? "y" : "ies"} available. Type or pick a
              book id above.
            </p>
          ) : null}
        </CardContent>
      </Card>

      <UatTestRunner />

      {bookId ? (
        <ExecutionView bookId={bookId} />
      ) : (
        <div className="rounded-xl border border-dashed border-border bg-card/20 px-4 py-10 text-center text-[12px] text-muted-foreground">
          Pick or type a book id above to view its execution ledger.
        </div>
      )}
    </div>
  );
}

export default OrderBookPage;
