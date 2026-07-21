"use client";

import * as React from "react";

/**
 * Cancel/Amend logic ported from execution-view.tsx (the upper panel) —
 * same endpoints (/api/admin/orderbook/cancel, /api/admin/orderbook/amend),
 * same account-guess fallback, same MARKET-order price-amend guard. Kept as
 * a standalone hook (rather than copy-pasted per-component) so both panels
 * share one implementation of logic that mutates live IRESS orders.
 *
 * Deliberately NOT ported: the upper panel's optimistic local-state
 * override (flipping a row to CANCEL_PENDING/AMEND_PENDING instantly via
 * `liveOverrides`, reconciled later by its own SSE stream). This panel
 * polls independently every 30s and will show the real state on the next
 * poll — a short (<=30s) lag instead of an instant optimistic flip.
 */
export interface ActionableOrder {
  /** The oems_order_audit row's own id — used as the per-row state key, never sent to the API. */
  id: string;
  /** IRESS order number, as stamped on the audit row. */
  order_id: string | null;
  client_account: string | null;
  broker_account: string | null;
  limit_price: number | null;
  qty: number;
  tif: string | null;
  order_type: "limit" | "market" | null;
  state: string;
}

export function isCancellable(state: string): boolean {
  return (
    state === "WORKING" ||
    state === "PARTIAL" ||
    state === "ACKNOWLEDGED" ||
    state === "created" ||
    state === "amended"
  );
}
export function isAmendable(state: string): boolean {
  return isCancellable(state) && state !== "AMEND_PENDING";
}
export function isAwaitingBrokerAck(state: string): boolean {
  return state === "PENDING_ACK";
}

function accountGuessFor(row: ActionableOrder): string {
  return (
    (row.broker_account && row.broker_account.length > 0 ? row.broker_account : null) ??
    (row.client_account && row.client_account.length > 0 ? row.client_account : "56378")
  );
}

export function useOrderActions() {
  const [cancelInFlight, setCancelInFlight] = React.useState<Record<string, boolean>>({});
  const [cancelError, setCancelError] = React.useState<Record<string, string>>({});

  const handleCancel = React.useCallback(async (row: ActionableOrder) => {
    const iressOrderNumber = row.order_id;
    if (!iressOrderNumber) return;
    const auditId = row.id;
    setCancelInFlight((p) => ({ ...p, [auditId]: true }));
    setCancelError((p) => ({ ...p, [auditId]: "" }));
    try {
      const res = await fetch("/api/admin/orderbook/cancel", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ account: accountGuessFor(row), order_number: iressOrderNumber }),
      });
      if (!res.ok && res.status >= 500) {
        setCancelError((p) => ({ ...p, [auditId]: `Cancel endpoint returned ${res.status}` }));
      } else {
        const body = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          error?: string;
          message?: string;
        };
        if (body?.ok === false) {
          setCancelError((p) => ({ ...p, [auditId]: body.message ?? body.error ?? "Cancel failed" }));
        }
      }
    } catch (err) {
      setCancelError((p) => ({ ...p, [auditId]: err instanceof Error ? err.message : String(err) }));
    } finally {
      setCancelInFlight((p) => ({ ...p, [auditId]: false }));
    }
  }, []);

  const [amendOpen, setAmendOpen] = React.useState<Record<string, boolean>>({});
  const [amendForm, setAmendForm] = React.useState<
    Record<string, { priceRands: string; volume: string; tif: "DAY" | "GTC" | "IOC" | "FOK" }>
  >({});
  const [amendInFlight, setAmendInFlight] = React.useState<Record<string, boolean>>({});
  const [amendError, setAmendError] = React.useState<Record<string, string>>({});

  const openAmend = React.useCallback((row: ActionableOrder) => {
    const auditId = row.id;
    setAmendOpen((p) => ({ ...p, [auditId]: true }));
    setAmendForm((p) => ({
      ...p,
      [auditId]: {
        priceRands: row.limit_price != null ? String(row.limit_price) : "",
        volume: String(row.qty || ""),
        tif:
          row.tif === "DAY" || row.tif === "GTC" || row.tif === "IOC" || row.tif === "FOK" ? row.tif : "DAY",
      },
    }));
    setAmendError((p) => ({ ...p, [auditId]: "" }));
  }, []);

  const closeAmend = React.useCallback((auditId: string) => {
    setAmendOpen((p) => ({ ...p, [auditId]: false }));
    setAmendError((p) => ({ ...p, [auditId]: "" }));
  }, []);

  const submitAmend = React.useCallback(
    async (row: ActionableOrder) => {
      const auditId = row.id;
      const form = amendForm[auditId];
      if (!form) return;
      const iressOrderNumber = row.order_id;
      if (!iressOrderNumber) return;

      const px = form.priceRands.trim() === "" ? null : Number(form.priceRands);
      const vol = form.volume.trim() === "" ? null : Number(form.volume);
      const body: Record<string, unknown> = { account: accountGuessFor(row), order_number: iressOrderNumber };
      if (
        px != null &&
        Number.isFinite(px) &&
        (row.limit_price == null || Math.abs(px - row.limit_price) > 0.0001)
      ) {
        body.price = px;
      }
      if (vol != null && Number.isFinite(vol) && vol > 0 && vol !== row.qty) {
        body.volume = vol;
      }
      if (form.tif !== row.tif) {
        body.tif = form.tif;
      }
      if (!("price" in body) && !("volume" in body) && !("tif" in body)) {
        setAmendError((p) => ({
          ...p,
          [auditId]: "Nothing to amend — at least one of price / volume / TIF must change.",
        }));
        return;
      }
      if (row.order_type === "market" && px != null && Number.isFinite(px)) {
        setAmendError((p) => ({
          ...p,
          [auditId]:
            "MARKET orders cannot have their price amended via OrderAmend2 — cancel and re-create the order to set a limit price. Volume / TIF will still amend.",
        }));
        return;
      }
      setAmendInFlight((p) => ({ ...p, [auditId]: true }));
      setAmendError((p) => ({ ...p, [auditId]: "" }));
      try {
        const res = await fetch("/api/admin/orderbook/amend", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok && res.status >= 500) {
          setAmendError((p) => ({ ...p, [auditId]: `Amend endpoint returned ${res.status}` }));
        } else {
          const data = (await res.json().catch(() => ({}))) as {
            ok?: boolean;
            error?: string;
            message?: string;
          };
          if (data?.ok === false) {
            setAmendError((p) => ({ ...p, [auditId]: data.message ?? data.error ?? "Amend failed" }));
          } else {
            closeAmend(auditId);
          }
        }
      } catch (err) {
        setAmendError((p) => ({ ...p, [auditId]: err instanceof Error ? err.message : String(err) }));
      } finally {
        setAmendInFlight((p) => ({ ...p, [auditId]: false }));
      }
    },
    [amendForm, closeAmend],
  );

  return {
    cancelInFlight,
    cancelError,
    handleCancel,
    amendOpen,
    amendForm,
    setAmendForm,
    amendInFlight,
    amendError,
    openAmend,
    closeAmend,
    submitAmend,
  };
}
export type UseOrderActions = ReturnType<typeof useOrderActions>;
