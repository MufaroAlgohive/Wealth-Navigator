"use client";

import { ArrowRight, Info, Plus, Wallet, Zap } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";

import { GlassKpi, GlassSection, PageCanvas } from "@/components/oems/primitives/glass";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * Banking › Wallet Top-ups (Ozone stub).
 *
 * Phase C6 of the OEM finalisation plan. The page now drives the real
 * `OzoneProvider` (via `POST /api/admin/eft/ozone-topup`) instead of the
 * Phase B4 manual-reference stub. The redirect URL the provider returns
 * is opened so a (mock) callback fires after ~5 s; the EFT approvals
 * surface then picks the row up as a normal `topup_method='ozone'`
 * wallet top-up awaiting review.
 *
 * Real Ozone API is BLOCKED on Tsie confirming the vendor contract —
 * `OZONE_MODE=mock` simulates the redirect + callback for end-to-end
 * verification. The page surfaces `data-source="code-gap"` when the
 * provider reports `unconfigured` so the operator knows to reach out.
 */

interface Client {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  mint_number: string | null;
}

interface InitiateResponse {
  ok: boolean;
  redirect_url?: string;
  transaction_id?: string;
  pending_transaction_id?: string;
  error?: string;
  warning?: string;
  provider_status?: string;
}

export default function WalletTopupPage() {
  const [amount, setAmount] = React.useState("");
  const [reference, setReference] = React.useState("");
  const [clientQ, setClientQ] = React.useState("");
  const [matches, setMatches] = React.useState<Client[]>([]);
  const [picked, setPicked] = React.useState<Client | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [providerMode, setProviderMode] = React.useState<"mock" | "live" | "unconfigured" | null>(null);

  // Probe provider health on mount so the badge reflects reality.
  React.useEffect(() => {
    let alive = true;
    void fetch("/api/admin/eft/ozone-health")
      .then((r) => (r.ok ? r.json() : { mode: "unconfigured" }))
      .then((j: { mode?: string }) => {
        if (!alive) return;
        const m = j?.mode;
        if (m === "mock" || m === "live" || m === "unconfigured") setProviderMode(m);
        else setProviderMode("unconfigured");
      })
      .catch(() => {
        if (alive) setProviderMode("unconfigured");
      });
    return () => {
      alive = false;
    };
  }, []);

  // Debounced client search so the lookup is cheap.
  React.useEffect(() => {
    const q = clientQ.trim();
    if (q.length < 1) {
      setMatches([]);
      return;
    }
    let alive = true;
    const t = window.setTimeout(() => {
      void fetch(`/api/admin/eft?action=search-clients&q=${encodeURIComponent(q)}`)
        .then((r) => r.json().catch(() => ({})))
        .then((d) => {
          if (!alive) return;
          setMatches(d.ok ? (d.clients ?? []) : []);
        })
        .catch(() => {
          if (!alive) return;
          setMatches([]);
        });
    }, 250);
    return () => {
      alive = false;
      window.clearTimeout(t);
    };
  }, [clientQ]);

  const submit = async () => {
    const amtRands = Number(amount);
    if (!amtRands || !Number.isFinite(amtRands) || amtRands <= 0)
      return toast.error("Enter a valid amount (ZAR)");
    if (!reference.trim()) return toast.error("Enter the Ozone reference");
    if (!picked?.id) return toast.error("Pick a client first");
    const amountCents = Math.round(amtRands * 100);

    setBusy(true);
    try {
      const res = await fetch("/api/admin/eft/ozone-topup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: picked.id,
          amount_cents: amountCents,
          reference: reference.trim(),
        }),
      });
      const body = (await res.json().catch(() => ({}))) as InitiateResponse;
      if (!res.ok || !body.ok) {
        toast.error(body.error || `Top-up failed (HTTP ${res.status})`);
        return;
      }
      toast.success(`Ozone top-up initiated — opening checkout…`);
      // Reset the form for the next entry while the redirect opens.
      setAmount("");
      setReference("");
      if (body.redirect_url) {
        // Mock mode redirects to the same page; live mode would land on
        // the Ozone-hosted checkout. `noopener` so a malicious provider
        // can't reach back into our window.
        window.open(body.redirect_url, "_blank", "noopener,noreferrer");
      }
    } catch (e) {
      toast.error((e as Error).message || "Top-up failed");
    } finally {
      setBusy(false);
    }
  };

  const isUnconfigured = providerMode === null || providerMode === "unconfigured";

  return (
    <PageCanvas>
      <GlassSection
        title="Wallet Top-ups (Ozone)"
        subtitle="Ozone-issued checkout — pending until provider callback fires"
        dataSource={isUnconfigured ? "code-gap" : "supabase"}
        db="retail"
        endpoint="/api/admin/eft/ozone-topup"
      >
        <div className="space-y-5 py-2">
          <div
            className="flex items-start gap-2 rounded-lg border border-primary/30 bg-primary/10 px-3 py-2 text-[12px] text-foreground/80"
            role="status"
          >
            <Info className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
            <span>
              Initiates a real (or mock) Ozone checkout via{" "}
              <code className="font-mono text-[11px]">POST /api/admin/eft/ozone-topup</code>. The pending row
              in <code className="font-mono text-[11px]">wallet_transactions</code> uses
              <code className="font-mono text-[11px]"> topup_method='ozone'</code>; on callback (mock: ~5 s)
              it flips to <code className="font-mono text-[11px]">completed</code> and the EFT approval
              surface picks it up. Provider status:{" "}
              <strong className="font-mono uppercase tracking-wider">{providerMode ?? "CHECKING…"}</strong>.
            </span>
          </div>

          <div className="grid gap-3 md:grid-cols-3">
            <div>
              <label
                htmlFor="ozone-client-email"
                className="mb-1 block text-[12px] font-semibold text-foreground"
              >
                Client
              </label>
              <Input
                id="ozone-client-email"
                value={
                  picked
                    ? `${picked.first_name ?? ""} ${picked.last_name ?? ""}`.trim() || picked.email || ""
                    : clientQ
                }
                onChange={(e) => {
                  setPicked(null);
                  setClientQ(e.target.value);
                }}
                placeholder="Search by name / email / mint number"
              />
              {clientQ.trim() && !picked && (
                <div className="mt-1 max-h-40 overflow-y-auto rounded-md border border-border bg-card">
                  {matches.length === 0 ? (
                    <p className="px-2 py-2 text-[11px] text-muted-foreground">No matches.</p>
                  ) : (
                    matches.map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => {
                          setPicked(c);
                          setClientQ(c.email || `${c.first_name ?? ""} ${c.last_name ?? ""}`);
                          setMatches([]);
                        }}
                        className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-[12px] hover:bg-accent"
                      >
                        <span className="min-w-0 flex-1 truncate">
                          {`${c.first_name ?? ""} ${c.last_name ?? ""}`.trim() || c.email}
                        </span>
                        {c.mint_number && (
                          <span className="rounded bg-muted px-1 py-0.5 text-[10px] font-mono text-muted-foreground">
                            {c.mint_number}
                          </span>
                        )}
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>
            <div>
              <label htmlFor="ozone-amount" className="mb-1 block text-[12px] font-semibold text-foreground">
                Amount (R)
              </label>
              <Input
                id="ozone-amount"
                type="number"
                min="0"
                step="0.01"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0.00"
              />
            </div>
            <div>
              <label
                htmlFor="ozone-reference"
                className="mb-1 block text-[12px] font-semibold text-foreground"
              >
                Ozone reference
              </label>
              <Input
                id="ozone-reference"
                value={reference}
                onChange={(e) => setReference(e.target.value)}
                placeholder="OZ-XXXXXXX"
              />
            </div>
          </div>

          <div className="flex justify-end gap-2">
            <Button onClick={submit} disabled={busy || isUnconfigured}>
              {busy ? (
                <span className="inline-flex items-center gap-1.5">
                  <Zap className="h-3.5 w-3.5" />
                  Initiating…
                </span>
              ) : (
                <>
                  <Plus className="h-3.5 w-3.5" />
                  Initiate top-up
                </>
              )}
            </Button>
          </div>

          <div className="grid gap-3 md:grid-cols-3">
            <GlassKpi
              label="Provider"
              value={(providerMode ?? "checking").toUpperCase()}
              sub={
                isUnconfigured
                  ? "Real Ozone contract pending — Tsie"
                  : providerMode === "mock"
                    ? "Simulated redirect + callback"
                    : "Live transport"
              }
              accent={isUnconfigured ? "negative" : "primary"}
            />
            <GlassKpi
              label="Persists to"
              value="wallet_transactions"
              sub="topup_method='ozone'"
              accent="primary"
            />
            <GlassKpi
              label="Picked client"
              value={picked ? picked.email || picked.mint_number || "—" : "—"}
              sub="Ledger row keyed on user_id"
            />
          </div>

          <div className="pt-2">
            <Button
              variant="secondary"
              onClick={() => toast.message("See Banking · EFT for the active deposit queue.")}
            >
              <ArrowRight className="h-3.5 w-3.5" /> Go to EFT deposits
            </Button>
          </div>
        </div>
        {/* Schema sanity (kept as a hidden accessibility hint) */}
        <span className="sr-only" aria-hidden>
          Ozone top-up — initiated via /api/admin/eft/ozone-topup.
        </span>
      </GlassSection>
    </PageCanvas>
  );
}

void Wallet; // reserved for the iconography pass; avoids unused-import warning.
