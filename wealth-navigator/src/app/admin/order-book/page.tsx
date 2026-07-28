"use client";

import * as React from "react";

import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { UatBanner } from "@/components/admin/order-book/uat-banner";
import { UatOrderTicket } from "@/components/admin/order-book/uat-order-ticket";
import { ExecutionView } from "@/components/admin/order-book/execution-view";
import { ActiveOrderBooks } from "@/components/admin/order-book/active-order-books";
import { ClosedBooks } from "@/components/admin/order-book/closed-books";
import { CancelledOrders } from "@/components/admin/order-book/cancelled-orders";

export default function OrderBookPage() {
  const [tab, setTab] = React.useState("active");
  const [uatRefresh, setUatRefresh] = React.useState(0);

  return (
    <div className="mx-auto max-w-[1400px] space-y-4">
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="active">Active Orderbook</TabsTrigger>
          <TabsTrigger value="closed">Closed Books</TabsTrigger>
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
            <ExecutionView key="orderbook-active" sources={["MINT_CLIENT_ORDER"]} />
            <ActiveOrderBooks sources={["MINT_CLIENT_ORDER"]} />
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
