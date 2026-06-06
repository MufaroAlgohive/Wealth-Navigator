"use client";

import { useEffect, useId, useState } from "react";
import { AlertTriangle, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export interface DestructivePreviewItem {
  id: string;
  primary: string;
  secondary?: string;
}

export interface ConfirmDestructiveProps {
  /** Number of items about to be affected. Drives the typed phrase. */
  count: number;
  /** Verb/phrase shown in the dialog header, e.g. "CANCEL 3 ORDERS" or "CANCEL". */
  label: string;
  /** Label of the trigger button in its idle state. */
  triggerLabel: string;
  /** Idle vs armed visual state. Outline = default idle. Destructive = active/armed. */
  triggerVariant: "outline" | "destructive";
  /** Called once the user has confirmed via the typed-phrase + button. */
  onConfirm: () => void | Promise<void>;
  /** Orders / items being acted on, shown in a <ul> inside the dialog. */
  previewItems?: DestructivePreviewItem[];
  /** Disable the trigger (e.g. when count is 0). */
  disabled?: boolean;
  /** Optional short description under the dialog title. */
  description?: string;
}

/**
 * Pure helper. The phrase the user must type to arm the destructive button
 * is `${verb} ${count}`, where `verb` is the first whitespace-delimited
 * token of `label` uppercased.
 *
 *   buildConfirmationPhrase(3, "CANCEL 3 ORDERS") -> "CANCEL 3"
 *   buildConfirmationPhrase(1, "CANCEL")         -> "CANCEL 1"
 *   buildConfirmationPhrase(0, "Cancel")         -> "CANCEL 0"
 */
export function buildConfirmationPhrase(count: number, label: string): string {
  const first = label.trim().split(/\s+/)[0] ?? "";
  const verb = first.toUpperCase() || "CONFIRM";
  return `${verb} ${count}`;
}

export function ConfirmDestructive({
  count,
  label,
  triggerLabel,
  triggerVariant,
  onConfirm,
  previewItems,
  disabled,
  description,
}: ConfirmDestructiveProps) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const phraseInputId = useId();

  const phrase = buildConfirmationPhrase(count, label);
  const armed = typed.trim() === phrase;
  const triggerDisabled = disabled || count === 0;

  // Reset the typed input each time the dialog (re)opens.
  useEffect(() => {
    if (open) {
      setTyped("");
      setSubmitting(false);
    }
  }, [open]);

  async function handleConfirm() {
    if (!armed || submitting) return;
    setSubmitting(true);
    try {
      await onConfirm();
      setOpen(false);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button
        type="button"
        size="sm"
        variant={triggerVariant}
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={triggerDisabled}
        onClick={() => setOpen(true)}
        className="h-7 text-xs"
        data-testid="confirm-destructive-trigger"
      >
        <X className="h-3 w-3" />
        {triggerLabel}
        {count > 0 ? (
          <span className="rounded bg-muted px-1 font-mono text-[9.5px] text-muted-foreground">{count}</span>
        ) : null}
      </Button>

      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-destructive" />
            {label}
          </DialogTitle>
          <DialogDescription>
            {description ?? "Confirm this destructive action by typing the phrase below."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-[11px] font-semibold text-destructive">
            This action is irreversible.{" "}
            {count === 1 ? "The order" : `All ${count} orders`} will be cancelled at the venue and cannot be restored.
          </p>

          {previewItems && previewItems.length > 0 ? (
            <div className="rounded-md border border-border/60 bg-surface-2/30">
              <ul className="max-h-56 divide-y divide-border/60 overflow-y-auto font-mono text-[11px]">
                {previewItems.map((it) => (
                  <li key={it.id} className="flex items-center justify-between gap-3 px-3 py-1.5">
                    <div className="min-w-0 flex-1 truncate">
                      <span className="font-semibold">{it.primary}</span>
                      {it.secondary ? <span className="ml-2 text-muted-foreground">{it.secondary}</span> : null}
                    </div>
                    <span className="shrink-0 text-[9.5px] text-muted-foreground">{it.id}</span>
                  </li>
                ))}
              </ul>
              <p className="border-t border-border/60 px-3 py-1.5 text-[9.5px] text-muted-foreground">
                Showing {previewItems.length} of {count}
              </p>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">No items to preview.</p>
          )}

          <div className="space-y-1.5">
            <label
              htmlFor={phraseInputId}
              className="block text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground"
            >
              Type <span className="font-mono text-destructive">{phrase}</span> to confirm
            </label>
            <Input
              id={phraseInputId}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder={phrase}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="characters"
              spellCheck={false}
              className="h-8 font-mono text-xs"
              data-testid="confirm-destructive-input"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={submitting}>
            Keep orders
          </Button>
          <Button
            variant="destructive"
            disabled={!armed || submitting}
            onClick={() => {
              void handleConfirm();
            }}
            data-testid="confirm-destructive-submit"
          >
            {submitting ? "Working…" : label}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
