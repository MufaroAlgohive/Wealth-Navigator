"use client";

/**
 * Banking › EFT — pending deposit approval surface.
 *
 * Mint OEM finalisation Phase B4. Reads pending `wallet_transactions` rows
 * from `/api/admin/eft?action=pending-transactions`, gates Approve / Reject
 * via `useCan("eft/approve_eft" | "eft/reject_eft")`, and lets the operator
 * upload a proof-of-funds screenshot per row.
 *
 * Flow:
 *   1. Pending rows arrive from the BFF as `wallet_transactions(status='pending')`.
 *   2. Operator uploads a proof image → POST /api/admin/eft/upload-proof returns
 *      a signed URL that persists to `wallet_transactions.proof_url`.
 *   3. Operator clicks Approve / Reject → POST /api/admin/eft?action=...
 *      updates the row, writes `email_logs`, and invokes the
 *      `trade_confirmation` webhook via the emailer helper.
 *   4. The action-items bar (A3) auto-decrements once the row leaves
 *      status='pending'.
 *
 * RBAC: the only approval authority is `eft/approve_eft` / `eft/reject_eft`.
 * Without them the operator sees the read-only queue. With them, every
 * destructive action stamps the audit trail (`wallet_transactions` + `email_logs`).
 */

import { CheckCircle2, Download, FileImage, Loader2, Send, ThumbsDown, Upload, X } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useAdmin } from "@/lib/admin/context";
import { cn } from "@/lib/cn";

interface PendingTxn {
  id: string;
  user_id: string;
  amount: number | string | null;
  created_at: string;
  status: string | null;
  proof_url?: string | null;
  topup_method?: string | null;
  profile: {
    id: string;
    first_name: string | null;
    last_name: string | null;
    email: string | null;
    mint_number: string | null;
  } | null;
}

const ZAR = (n: number | string | null) => {
  const v = Number(n) || 0;
  return `R ${v.toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

export default function BankingEftPage() {
  const { ctx } = useAdmin();
  // B4 — RBAC resolution against `lib/admin/rbac-keys.ts`. The local `can`
  // helper accepts the legacy 2-arg (section, field) shape; the `dev`
  // approver tier bypasses both forms.
  const can = (section: string, field: string): boolean => {
    if (ctx.approverTier === "dev") return true;
    const v = ctx.permissions?.[section]?.[field];
    return v === "pending" || v === "direct" ? true : Boolean(v);
  };
  const canApprove = can("eft", "approve_eft");
  const canReject = can("eft", "reject_eft");
  // B4 — preview pane toggle for the proof thumbnail; defaults to compact
  // link list, expands on demand to a card-with-image preview.
  const [previewingId, setPreviewingId] = React.useState<string | null>(null);

  const [rows, setRows] = React.useState<PendingTxn[] | null>(null);
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [uploadingId, setUploadingId] = React.useState<string | null>(null);

  const reload = React.useCallback(async () => {
    try {
      const res = await fetch("/api/admin/eft?action=pending-transactions", { cache: "no-store" });
      const body = await res.json().catch(() => ({ ok: false }));
      if (body.ok) setRows((body.transactions ?? []) as PendingTxn[]);
      else setRows([]);
    } catch {
      setRows([]);
    }
  }, []);

  React.useEffect(() => {
    void reload();
  }, [reload]);

  const uploadProof = async (transactionId: string, file: File) => {
    setUploadingId(transactionId);
    try {
      const fd = new FormData();
      fd.append("transaction_id", transactionId);
      fd.append("file", file);
      const res = await fetch("/api/admin/eft/upload-proof", { method: "POST", body: fd });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.ok) {
        toast.error(body.error || `Upload failed (HTTP ${res.status})`);
        return;
      }
      toast.success("Proof uploaded");
      await reload();
    } catch (e) {
      toast.error((e as Error).message || "Upload failed");
    } finally {
      setUploadingId(null);
    }
  };

  const decide = async (transactionId: string, decision: "approved" | "rejected") => {
    if (decision === "approved" && !canApprove) return toast.error("Not permitted");
    if (decision === "rejected" && !canReject) return toast.error("Not permitted");
    setBusyId(transactionId);
    try {
      const res = await fetch(`/api/admin/eft?action=${decision}-deposit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transaction_id: transactionId }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.ok) {
        toast.error(body.error || `Failed (HTTP ${res.status})`);
        return;
      }
      toast.success(decision === "approved" ? "Deposit approved · confirmation queued" : "Deposit rejected");
      await reload();
    } catch (e) {
      toast.error((e as Error).message || "Failed");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-2">
      <header className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-section">EFT deposits</h1>
          <p className="text-caption">Pending wallet_transactions awaiting manual credit / rejection.</p>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" onClick={reload}>
            <Loader2 className="h-3.5 w-3.5" /> Refresh
          </Button>
        </div>
      </header>

      {!canApprove && !canReject && (
        <Card className="border-warning/40 bg-warning/10">
          <CardContent className="flex items-center gap-3 p-3 text-[12px] text-warning">
            You can view the queue, but <code className="font-mono">eft/approve_eft</code> and{" "}
            <code className="font-mono">eft/reject_eft</code> are required to decide. Contact the team lead.
          </CardContent>
        </Card>
      )}

      {rows === null && (
        <p className="py-12 text-center text-sm text-muted-foreground">Loading pending deposits…</p>
      )}
      {rows !== null && rows.length === 0 && (
        <Card>
          <CardContent className="py-12 text-center">
            <CheckCircle2 className="mx-auto mb-2 h-8 w-8 text-success" />
            <p className="text-sm font-semibold text-foreground">No pending deposits</p>
            <p className="text-[11px] text-muted-foreground">
              All caught up. The action-items banner will flag new rows within 30s.
            </p>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-3">
        {rows?.map((t) => {
          const name = t.profile
            ? `${t.profile.first_name || ""} ${t.profile.last_name || ""}`.trim() ||
              t.profile.email ||
              "Unknown"
            : "Unknown";
          return (
            <Card key={t.id}>
              <CardContent className="grid gap-3 p-4 md:grid-cols-[1fr_280px] md:items-center">
                <div className="min-w-0 space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="text-base font-bold text-foreground">{name}</span>
                    {t.profile?.mint_number && (
                      <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-mono uppercase text-muted-foreground">
                        {t.profile.mint_number}
                      </span>
                    )}
                  </div>
                  <div className="text-[12px] text-muted-foreground">
                    {t.profile?.email ? `${t.profile.email} · ` : ""}
                    {new Date(t.created_at).toLocaleString("en-ZA")}
                  </div>
                  <div className="flex flex-wrap items-center gap-3 pt-1">
                    <div className="text-2xl font-bold text-foreground">{ZAR(t.amount)}</div>
                    {t.topup_method && (
                      <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                        {t.topup_method.replace(/_/g, " ")}
                      </span>
                    )}
                  </div>
                </div>

                <div className="space-y-2">
                  {t.proof_url ? (
                    <Card className="overflow-hidden">
                      <CardContent className="space-y-2 p-2">
                        {/* B4 — thumbnail preview per the spec. The full URL is
                            still reachable via "Open full image" (a no-op
                            lightbox inside the card keeps the operator inside
                            the EFT surface). */}
                        <div className="relative">
                          {previewingId === t.id ? (
                            <div className="relative">
                              <button
                                type="button"
                                onClick={() => setPreviewingId(null)}
                                aria-label="Close proof preview"
                                className="absolute right-1 top-1 z-10 rounded-full bg-background/80 p-1 text-foreground/70 hover:bg-background hover:text-foreground"
                              >
                                <X className="h-3.5 w-3.5" />
                              </button>
                              <a
                                href={t.proof_url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="block"
                              >
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                <img
                                  src={t.proof_url}
                                  alt={`Proof of funds for ${name}`}
                                  className="max-h-48 w-full rounded-md border border-border object-contain"
                                />
                              </a>
                            </div>
                          ) : (
                            <button
                              type="button"
                              onClick={() => setPreviewingId(t.id)}
                              className="flex w-full items-center gap-2 rounded-md border border-border bg-card/60 p-2 text-[12px] text-foreground hover:bg-accent"
                              aria-label="Preview proof of funds"
                            >
                              <FileImage className="h-4 w-4 text-primary" />
                              <span className="min-w-0 flex-1 truncate text-left">
                                Proof of funds attached
                              </span>
                              <Download className="h-3.5 w-3.5 text-muted-foreground" />
                            </button>
                          )}
                        </div>
                        <div className="flex flex-wrap gap-1.5 text-[10px]">
                          <a
                            href={t.proof_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="rounded bg-muted px-2 py-1 text-foreground/70 hover:bg-accent"
                          >
                            Open full image
                          </a>
                          <a
                            href={t.proof_url}
                            download
                            className="rounded bg-muted px-2 py-1 text-foreground/70 hover:bg-accent"
                          >
                            Download
                          </a>
                        </div>
                      </CardContent>
                    </Card>
                  ) : (
                    <ProofUploader
                      disabled={uploadingId === t.id}
                      uploading={uploadingId === t.id}
                      onPick={(file) => void uploadProof(t.id, file)}
                    />
                  )}
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="success"
                      disabled={!canApprove || busyId === t.id}
                      onClick={() => void decide(t.id, "approved")}
                    >
                      <CheckCircle2 className="h-3.5 w-3.5" /> Approve
                    </Button>
                    <Button
                      size="sm"
                      variant="destructive"
                      disabled={!canReject || busyId === t.id}
                      onClick={() => void decide(t.id, "rejected")}
                    >
                      <ThumbsDown className="h-3.5 w-3.5" /> Reject
                    </Button>
                    <a
                      href={`/admin/clients?focus=${t.user_id}`}
                      className={cn(
                        "inline-flex items-center gap-1 rounded-md border border-border bg-card px-2.5 py-1.5 text-[12px] font-medium text-foreground hover:bg-accent",
                      )}
                    >
                      <Send className="h-3.5 w-3.5" /> View client
                    </a>
                  </div>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}

function ProofUploader({
  uploading,
  disabled,
  onPick,
}: {
  uploading: boolean;
  disabled: boolean;
  onPick: (file: File) => void;
}) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  return (
    <div className="flex items-center gap-2">
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="sr-only"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onPick(f);
          e.currentTarget.value = "";
        }}
      />
      <Button size="sm" variant="secondary" disabled={disabled} onClick={() => inputRef.current?.click()}>
        {uploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
        {uploading ? "Uploading…" : "Upload proof"}
      </Button>
      <span className="text-[11px] text-muted-foreground">PNG / JPG</span>
    </div>
  );
}
