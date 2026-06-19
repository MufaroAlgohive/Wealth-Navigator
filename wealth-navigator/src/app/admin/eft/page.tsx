"use client";

import * as React from "react";
import { toast } from "sonner";
import { ChevronRight } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { cn } from "@/lib/cn";

interface Profile { id: string; first_name: string | null; last_name: string | null; email: string | null; mint_number: string | null; }
interface Child { id: string; first_name: string | null; last_name: string | null; available_balance: number | null; }
interface Wallet { id: string; user_id: string; balance: number; currency: string | null; status: string; mint_number: string | null; mailer: string | null; updated_at: string; profile: Profile | null; children: Child[]; }
interface PendingTxn { id: string; user_id: string; amount: number; created_at: string; status: string; profile: Profile | null; }

const ZAR = (n: number) => new Intl.NumberFormat("en-ZA", { style: "currency", currency: "ZAR", minimumFractionDigits: 2 }).format(Number(n || 0));
const fullName = (p: Profile | null) => (p ? `${p.first_name || ""} ${p.last_name || ""}`.trim() || p.email || "—" : "—");
const fmtDate = (iso: string) => new Date(iso).toLocaleDateString("en-ZA");

const card = "rounded-xl border border-border bg-card";
const th = "px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground";
const tdc = "px-4 py-3 align-middle text-[13px] text-foreground";

export default function EftPage() {
  const [tab, setTab] = React.useState("active");

  const [wallets, setWallets] = React.useState<Wallet[] | null>(null);
  const [stats, setStats] = React.useState<{ count: number; total: number }>({ count: 0, total: 0 });
  const [pending, setPending] = React.useState<PendingTxn[] | null>(null);
  const [expanded, setExpanded] = React.useState<Set<string>>(new Set());

  // Add-to-wallet form
  const [query, setQuery] = React.useState("");
  const [results, setResults] = React.useState<Profile[]>([]);
  const [showResults, setShowResults] = React.useState(false);
  const [client, setClient] = React.useState<Profile | null>(null);
  const [children, setChildren] = React.useState<Child[]>([]);
  const [childId, setChildId] = React.useState<string>("");
  const [walletType, setWalletType] = React.useState("active");
  const [amount, setAmount] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  const loadWallets = React.useCallback(async (filter: "active" | "test") => {
    setWallets(null);
    const d = await fetch(`/api/admin/eft?action=list-wallets&filter=${filter}`).then((r) => r.json()).catch(() => ({ ok: false }));
    setWallets(d.ok ? d.wallets || [] : []);
    setStats(d.ok && d.stats ? d.stats : { count: 0, total: 0 });
  }, []);
  const loadPending = React.useCallback(async () => {
    setPending(null);
    const d = await fetch("/api/admin/eft?action=pending-transactions").then((r) => r.json()).catch(() => ({ ok: false }));
    setPending(d.ok ? d.transactions || [] : []);
  }, []);

  React.useEffect(() => {
    if (tab === "active") void loadWallets("active");
    else if (tab === "test") void loadWallets("test");
    else void loadPending();
  }, [tab, loadWallets, loadPending]);

  // Client search (debounced)
  React.useEffect(() => {
    if (query.trim().length < 1) { setResults([]); return; }
    const t = setTimeout(async () => {
      const d = await fetch(`/api/admin/eft?action=search-clients&q=${encodeURIComponent(query.trim())}`).then((r) => r.json()).catch(() => ({ ok: false }));
      setResults(d.ok ? d.clients || [] : []);
    }, 250);
    return () => clearTimeout(t);
  }, [query]);

  const pickClient = async (p: Profile) => {
    setClient(p);
    setQuery(fullName(p));
    setShowResults(false);
    setChildId("");
    const d = await fetch(`/api/admin/eft?action=member-children&parent_id=${p.id}`).then((r) => r.json()).catch(() => ({ ok: false }));
    setChildren(d.ok ? d.children || [] : []);
  };

  const submitAdd = async () => {
    if (!client) return toast.error("Select a client");
    const amt = Number(amount);
    if (!amt || amt <= 0) return toast.error("Enter a valid amount");
    setBusy(true);
    try {
      const body = childId
        ? { user_id: childId, amount: amt, account_type: "child", wallet_status: walletType }
        : { user_id: client.id, amount: amt, account_type: "parent", wallet_status: walletType };
      const d = await fetch("/api/admin/eft?action=add-wallet", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      }).then((r) => r.json());
      if (d.ok) { toast.success("Added"); setAmount(""); }
      else toast.message(d.error || "Deferred");
    } finally { setBusy(false); }
  };

  const sendNotice = async (w: Wallet) => {
    const d = await fetch("/api/admin/eft?action=send-notice", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ walletId: w.id, to: w.profile?.email }),
    }).then((r) => r.json());
    toast.message(d.error || (d.ok ? "Sent" : "Deferred"));
  };

  const decide = async (t: PendingTxn, decision: "approve" | "reject") => {
    const action = decision === "approve" ? "approve-deposit" : "reject-deposit";
    const reason = decision === "reject" ? window.prompt("Reason (optional)?") || undefined : undefined;
    const d = await fetch(`/api/admin/eft?action=${action}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ transaction_id: t.id, reason }),
    }).then((r) => r.json());
    toast.message(d.error || (d.ok ? "Done" : "Deferred"));
  };

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      {/* Stats */}
      <div className="grid grid-cols-2 gap-3">
        <div className={cn(card, "px-5 py-4")}>
          <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Client Wallets</div>
          <div className="mt-1 text-2xl font-bold text-foreground">{stats.count}</div>
        </div>
        <div className={cn(card, "px-5 py-4")}>
          <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Total Wallet Amount</div>
          <div className="mt-1 text-2xl font-bold text-foreground">{ZAR(stats.total)}</div>
        </div>
      </div>

      {/* Add to wallet */}
      <div className={cn(card, "p-5")}>
        <h2 className="text-[15px] font-bold text-foreground">Add to Client Wallet</h2>
        <div className="mt-4 grid gap-3 md:grid-cols-[2fr_1fr_1fr_auto] md:items-end">
          <div className="relative">
            <label className="mb-1 block text-[12px] font-semibold text-foreground">Client</label>
            <Input
              value={query}
              onChange={(e) => { setQuery(e.target.value); setShowResults(true); setClient(null); setChildren([]); setChildId(""); }}
              onFocus={() => setShowResults(true)}
              placeholder="Search name / email / MINT number"
            />
            {showResults && results.length > 0 && (
              <div className="absolute z-20 mt-1 w-full overflow-hidden rounded-lg border border-border bg-popover shadow-lg">
                {results.map((p) => (
                  <button key={p.id} type="button" onClick={() => pickClient(p)} className="flex w-full flex-col items-start px-3 py-2 text-left hover:bg-accent/50">
                    <span className="text-sm text-foreground">{fullName(p)}</span>
                    <span className="text-[11px] text-muted-foreground">{p.email} · {p.mint_number || "no MINT #"}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <div>
            <label className="mb-1 block text-[12px] font-semibold text-foreground">Wallet type</label>
            <Select value={walletType} onValueChange={setWalletType}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="active">Active (needs approval)</SelectItem>
                <SelectItem value="test">Test (immediate)</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="mb-1 block text-[12px] font-semibold text-foreground">Amount (R)</label>
            <Input type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" />
          </div>
          <Button onClick={submitAdd} disabled={busy}>{busy ? "Adding…" : "Add to Wallet"}</Button>
        </div>
        {client && children.length > 0 && (
          <div className="mt-3">
            <label className="mb-1 block text-[12px] font-semibold text-foreground">Fund a child account instead?</label>
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={() => setChildId("")} className={cn("rounded-lg border px-3 py-1.5 text-[12px]", childId === "" ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground")}>
                {fullName(client)} (parent)
              </button>
              {children.map((c) => (
                <button key={c.id} type="button" onClick={() => setChildId(c.id)} className={cn("rounded-lg border px-3 py-1.5 text-[12px]", childId === c.id ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground")}>
                  {`${c.first_name || ""} ${c.last_name || ""}`.trim()} · {ZAR(Number(c.available_balance || 0) / 100)}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Wallet list / pending */}
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="active">Active Wallets</TabsTrigger>
          <TabsTrigger value="test">Test Wallets</TabsTrigger>
          <TabsTrigger value="pending">Pending Approvals</TabsTrigger>
        </TabsList>

        <TabsContent value="active"><WalletTable wallets={wallets} expanded={expanded} setExpanded={setExpanded} onNotice={sendNotice} /></TabsContent>
        <TabsContent value="test"><WalletTable wallets={wallets} expanded={expanded} setExpanded={setExpanded} onNotice={sendNotice} /></TabsContent>

        <TabsContent value="pending">
          <div className={cn(card, "overflow-x-auto")}>
            <table className="w-full border-collapse">
              <thead><tr className="border-b border-border">
                <th className={th}>Date</th><th className={th}>User</th><th className={th}>Amount</th><th className={th}>Reference</th><th className={th}>Action</th>
              </tr></thead>
              <tbody>
                {pending === null ? (
                  <tr><td colSpan={5} className="px-4 py-10 text-center text-sm text-muted-foreground">Loading…</td></tr>
                ) : pending.length === 0 ? (
                  <tr><td colSpan={5} className="px-4 py-10 text-center text-sm text-muted-foreground">No pending approvals.</td></tr>
                ) : (
                  pending.map((t) => (
                    <tr key={t.id} className="border-b border-border/40 last:border-b-0">
                      <td className={tdc}>{fmtDate(t.created_at)}</td>
                      <td className={tdc}>{fullName(t.profile)}</td>
                      <td className={cn(tdc, "font-semibold text-success")}>+ {ZAR(t.amount)}</td>
                      <td className={tdc}>Pending Deposit</td>
                      <td className={tdc}>
                        <div className="flex gap-1.5">
                          <Button size="sm" variant="success" className="h-7 px-2 text-[11px]" onClick={() => decide(t, "approve")}>Approve</Button>
                          <Button size="sm" variant="destructive" className="h-7 px-2 text-[11px]" onClick={() => decide(t, "reject")}>Reject</Button>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function WalletTable({ wallets, expanded, setExpanded, onNotice }: {
  wallets: Wallet[] | null;
  expanded: Set<string>;
  setExpanded: React.Dispatch<React.SetStateAction<Set<string>>>;
  onNotice: (w: Wallet) => void;
}) {
  const toggle = (id: string) => setExpanded((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  return (
    <div className={cn(card, "overflow-x-auto")}>
      <table className="w-full border-collapse">
        <thead><tr className="border-b border-border">
          <th className={th}>Date</th><th className={th}>User</th><th className={th}>Amount</th><th className={th}>Reference</th><th className={th}>Send Notice</th>
        </tr></thead>
        <tbody>
          {wallets === null ? (
            <tr><td colSpan={5} className="px-4 py-10 text-center text-sm text-muted-foreground">Loading…</td></tr>
          ) : wallets.length === 0 ? (
            <tr><td colSpan={5} className="px-4 py-10 text-center text-sm text-muted-foreground">No wallets with a balance.</td></tr>
          ) : (
            wallets.map((w) => (
              <React.Fragment key={w.id}>
                <tr className="border-b border-border/40">
                  <td className={tdc}>{new Date(w.updated_at).toLocaleDateString("en-ZA")}</td>
                  <td className={tdc}>
                    <button type="button" onClick={() => w.children.length > 0 && toggle(w.id)} className="flex items-center gap-1.5 text-left">
                      {w.children.length > 0 && <ChevronRight className={cn("h-3.5 w-3.5 text-muted-foreground transition-transform", expanded.has(w.id) && "rotate-90")} />}
                      <span className="font-medium">{fullName(w.profile)}</span>
                    </button>
                  </td>
                  <td className={cn(tdc, "font-semibold")}>{ZAR(w.balance)}</td>
                  <td className={tdc}>{w.mint_number || w.profile?.mint_number || "—"}</td>
                  <td className={tdc}>
                    <Button size="sm" variant={w.mailer === "sent" ? "secondary" : "default"} className="h-7 px-2.5 text-[11px]" disabled={w.mailer === "sent"} onClick={() => onNotice(w)}>
                      {w.mailer === "sent" ? "Sent" : "Send Notice"}
                    </Button>
                  </td>
                </tr>
                {expanded.has(w.id) && w.children.map((c) => (
                  <tr key={c.id} className="border-b border-border/30 bg-muted/20">
                    <td className={tdc} />
                    <td className={cn(tdc, "pl-8 text-muted-foreground")}>↳ {`${c.first_name || ""} ${c.last_name || ""}`.trim()} (child)</td>
                    <td className={cn(tdc, "text-muted-foreground")}>{ZAR(Number(c.available_balance || 0) / 100)}</td>
                    <td className={tdc} colSpan={2} />
                  </tr>
                ))}
              </React.Fragment>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
