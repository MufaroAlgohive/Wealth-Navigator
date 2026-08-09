"use client";

import * as React from "react";

import { ActiveOrderBooks } from "@/components/admin/order-book/active-order-books";
import { CancelledOrders } from "@/components/admin/order-book/cancelled-orders";
import { ClosedBooks } from "@/components/admin/order-book/closed-books";
import { ExecutionView } from "@/components/admin/order-book/execution-view";
import { RebalanceBooks } from "@/components/admin/order-book/rebalance-books";
import { StrateBir } from "@/components/admin/order-book/strate-bir";
import { UatBanner } from "@/components/admin/order-book/uat-banner";
import { UatOrderTicket } from "@/components/admin/order-book/uat-order-ticket";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

export default function OrderBookPage() {
  const [tab, setTab] = React.useState("active");
  const [uatRefresh, setUatRefresh] = React.useState(0);
  const [activeEnvironment, setActiveEnvironment] = React.useState<"live" | "uat">("live");

  return (
    <div className="mx-auto max-w-[1400px] space-y-4">
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="active">Active Orderbook</TabsTrigger>
          <TabsTrigger value="closed">Closed Books</TabsTrigger>
          <TabsTrigger value="rebalances">Rebalances</TabsTrigger>
          <TabsTrigger value="strate-bir">STRATE BIR</TabsTrigger>
          <TabsTrigger value="cancelled">Cancelled</TabsTrigger>
          <TabsTrigger value="uat-testing">Manual Orders</TabsTrigger>
        </TabsList>
        {tab === "uat-testing" ? (
          <TabsContent value="uat-testing" className="mt-3 space-y-3">
            <UatBanner />
            <UatOrderTicket onPlaced={() => setUatRefresh((n) => n + 1)} />
            {/* UatTestRunner removed 2026-07-27. It is a bulk harness that
                dispatches throwaway orders with uat_test=true, which the BFF now
                refuses whenever IRESS_UAT_MODE is off — and which, before the
                lane-intent fix, would have been promoted to the PRODUCTION lane
                and placed real orders from a button labelled "UAT Test Runner".
                This tab is the manual client order desk now. The component is
                still in the tree for the UAT deployment. */}
            {/* Manual + UAT desk orders only. App (MINT_CLIENT_ORDER) orders
                live on the Active Orderbook tab, not here — a manual order
                placed above is MANUAL_CLIENT_ORDER, so it still appears below. */}
            <ExecutionView
              key={`orderbook-manual-${uatRefresh}`}
              sources={["MANUAL_CLIENT_ORDER", "UAT_ADHOC_ORDER"]}
            />
            <ActiveOrderBooks sources={["MANUAL_CLIENT_ORDER", "UAT_ADHOC_ORDER"]} />
          </TabsContent>
        ) : tab === "cancelled" ? (
          <TabsContent value="cancelled" className="mt-3">
            <CancelledOrders />
          </TabsContent>
        ) : tab === "active" ? (
          // Active Orderbook — the live app-order book. Renders exactly like the
          // Manual Orders tab (same ExecutionView + archived Active Order Books),
          // but scoped to app orders (MINT_CLIENT_ORDER) only; manual/UAT desk
          // orders stay on the Manual Orders tab.
          <TabsContent value="active" className="mt-3 space-y-3">
            <div className="flex justify-end">
              <div className="inline-flex rounded-md border border-border bg-background p-0.5">
                <Button
                  type="button"
                  size="sm"
                  variant={activeEnvironment === "live" ? "secondary" : "ghost"}
                  onClick={() => setActiveEnvironment("live")}
                  aria-pressed={activeEnvironment === "live"}
                >
                  Live orders
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant={activeEnvironment === "uat" ? "warning" : "ghost"}
                  onClick={() => setActiveEnvironment("uat")}
                  aria-pressed={activeEnvironment === "uat"}
                >
                  UAT orders
                </Button>
              </div>
            </div>
            <ExecutionView
              key={`orderbook-active-${activeEnvironment}`}
              sources={
                activeEnvironment === "uat"
                  ? ["UAT_ADHOC_ORDER", "MINT_CLIENT_ORDER", "PAPER_MODEL_REBALANCE"]
                  : ["MINT_CLIENT_ORDER", "PAPER_MODEL_REBALANCE"]
              }
              scope={activeEnvironment}
            />
            {/* The archive is shared across order-entry lanes. Older books and
                releases made through the desk/UAT routes do not carry the
                MINT_CLIENT_ORDER source, so filtering here can hide the only
                place from which an admin can close them. */}
            <ActiveOrderBooks
              sources={
                activeEnvironment === "uat"
                  ? ["UAT_ADHOC_ORDER", "CRM_UAT", "PAPER_MODEL_REBALANCE"]
                  : ["MINT_CLIENT_ORDER", "CRM_LIVE", "PAPER_MODEL_REBALANCE"]
              }
            />
          </TabsContent>
        ) : tab === "rebalances" ? (
          <TabsContent value="rebalances" className="mt-3 space-y-3">
            <div className="flex justify-end">
              <Button
                type="button"
                size="sm"
                variant={activeEnvironment === "uat" ? "warning" : "secondary"}
                onClick={() => setActiveEnvironment((current) => (current === "live" ? "uat" : "live"))}
                aria-pressed={activeEnvironment === "uat"}
                title={
                  activeEnvironment === "uat"
                    ? "Showing UAT strategy rebalance batches only — click to return to LIVE"
                    : "Showing LIVE strategy rebalance batches — click to view UAT"
                }
              >
                Environment: {activeEnvironment === "uat" ? "UAT" : "LIVE"}
              </Button>
            </div>
            <RebalanceBooks scope={activeEnvironment} />
          </TabsContent>
        ) : tab === "strate-bir" ? (
          <TabsContent value="strate-bir" className="mt-3">
            <StrateBir scope={activeEnvironment} />
          </TabsContent>
        ) : (
          // Closed Books — CRM-style archive of books an admin has explicitly
          // moved out of Active/Manual Order Books via "Move to Closed Book"
          // (close-book/route.ts). Unfiltered by source: one shared list across
          // app, manual and UAT books, mirroring MyMintAdmin's single Closed
          // Books tab.
          <TabsContent value="closed" className="mt-3">
            <ClosedBooks />
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}
