"use client";

import { Loader2, ShieldAlert, TriangleAlert } from "lucide-react";
import type * as React from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * Confirmation gate for the irreversible "send" desk actions (Send to Market,
 * Send to Order Book).
 *
 * Password re-entry was removed 2026-08-17 at the user's request; the server
 * still requires a Master ★ account (lib/admin/step-up.ts →
 * requireMasterPassword, which checks `approverTier === "master"`). This dialog
 * is the CLIENT-SIDE courtesy layer over that same rule:
 *
 *   - not a master → explain who can do this, offer no way to proceed
 *   - master       → an explicit "are you sure" with Yes / No
 *
 * It is deliberately NOT the security boundary. A client check can always be
 * bypassed; the server gate above is what actually protects the release. This
 * only stops a non-master wasting a click on a call that would 403, and stops
 * a master firing an unrecoverable broker release by accident.
 */
export function MasterSendConfirmDialog({
  open,
  onOpenChange,
  isMaster,
  title,
  description = "This is sent straight to the broker and cannot be undone from this system.",
  summary,
  confirmLabel = "Yes, execute order",
  pending = false,
  onConfirm,
  nonMasterDescription = "Only a Master ★ account can send orders to the market. Your account does not hold that approver tier, so this release cannot be started from here.",
}: {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  /** `ctx.approverTier === "master"` — mirrors the server's own check exactly. */
  isMaster: boolean;
  /** What is about to be sent, e.g. "Send 12 parked orders to market". */
  title: string;
  /** Trailing sentence after `title` in the master-branch description.
   *  Defaults to the broker-release wording — override for an action that
   *  isn't a broker send (e.g. a manual fill, which is the OPPOSITE case). */
  description?: string;
  /** One line of specifics so the approver can sanity-check before saying yes. */
  summary?: React.ReactNode;
  confirmLabel?: string;
  pending?: boolean;
  onConfirm: () => void;
  /** Body text shown to a non-master viewer. Defaults to the broker-release
   *  wording — override for an action that isn't "send to market". */
  nonMasterDescription?: string;
}) {
  // Never let a pending release be dismissed out from under itself — the request
  // is already in flight and closing would strand the spinner state.
  const handleOpenChange = (next: boolean) => {
    if (pending && !next) return;
    onOpenChange(next);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-md">
        {isMaster ? (
          <>
            <DialogHeader>
              <div className="mb-2 flex h-9 w-9 items-center justify-center rounded-full bg-warning/15">
                <TriangleAlert className="h-4.5 w-4.5 text-warning" />
              </div>
              <DialogTitle>Are you sure you want to execute this order?</DialogTitle>
              <DialogDescription>
                {title} {description}
              </DialogDescription>
            </DialogHeader>
            {summary ? (
              <div className="rounded-lg border border-border bg-muted/30 px-3 py-2.5 text-xs text-foreground">
                {summary}
              </div>
            ) : null}
            <DialogFooter className="gap-2">
              <Button variant="outline" size="default" disabled={pending} onClick={() => onOpenChange(false)}>
                No, cancel
              </Button>
              <Button variant="default" size="default" disabled={pending} onClick={onConfirm}>
                {pending ? (
                  <>
                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                    Sending…
                  </>
                ) : (
                  confirmLabel
                )}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <div className="mb-2 flex h-9 w-9 items-center justify-center rounded-full bg-destructive/15">
                <ShieldAlert className="h-4.5 w-4.5 text-destructive" />
              </div>
              <DialogTitle>Master approval required</DialogTitle>
              <DialogDescription>{nonMasterDescription}</DialogDescription>
            </DialogHeader>
            <div className="rounded-lg border border-border bg-muted/30 px-3 py-2.5 text-xs text-muted-foreground">
              Ask a master approver to review and release it. Nothing has been sent.
            </div>
            <DialogFooter>
              <Button variant="secondary" size="default" onClick={() => onOpenChange(false)}>
                Close
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
