"use client";

import * as React from "react";
import JSZip from "jszip";
import { toast } from "sonner";
import { Download, Eye, Package, Search, X } from "lucide-react";

import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { cn } from "@/lib/cn";

type Kyc = "not_initiated" | "pending" | "verified" | "rejected" | "resubmission_required";
type KycFilter = "all" | Kyc;
type FamilyFilter = "all" | "parent" | "child";
interface ClientRow { id: string; name: string; email: string | null; mint_number: string | null; is_test: boolean | null; kyc: Kyc; bank_linked: boolean; family_role: "parent" | "child" | "other"; family_member_id?: string | null; is_linked_child?: boolean; }
interface Holding { symbol: string; name: string; qty: number; valueCents: number; pnlCents: number; strategy: string | null; purchaseValueCents?: number | null; }
interface Txn { id: string; name: string | null; description: string | null; amount: number; direction: string; status: string | null; transaction_date: string | null; }
interface ClientDocument { id: string; name: string; fileType: string; addedDate: string | null; url: string; source: "experian" | "sumsub" | "signed"; }
interface DocumentGroups { experian: ClientDocument[]; sumsub: ClientDocument[]; signed: ClientDocument[]; }
interface Detail {
  profile: Record<string, unknown> | null;
  onboarding: Record<string, unknown> | null;
  kyc: Kyc;
  holdings: Holding[];
  transactions: Txn[];
  is_unlinked_child?: boolean;
  onboarding_pack?: Record<string, unknown> | null;
  mandate?: { available: boolean; data: Record<string, unknown>; signed_agreement_url?: string | null };
  child_certificate?: { url?: string | null; status?: string | null; reviewed_at?: string | null };
}

const R = (cents: number) => new Intl.NumberFormat("en-ZA", { style: "currency", currency: "ZAR", maximumFractionDigits: 0 }).format(cents / 100);
const pnlCls = (n: number) => (n >= 0 ? "text-success" : "text-destructive");
const initials = (name: string) => name.split(" ").map((w) => w[0]).join("").slice(0, 2).toUpperCase() || "?";
const kycCls = (k: Kyc) => (k === "verified" ? "bg-success/15 text-success" : k === "rejected" || k === "resubmission_required" ? "bg-destructive/15 text-destructive" : k === "pending" ? "bg-warning/15 text-warning" : "bg-muted text-muted-foreground");
const kycLabel = (k: Kyc) => k.replaceAll("_", " ");
const kycSelectCls = (value: KycFilter) => value === "verified" ? "border-success/40 bg-success/10 text-success" : value === "rejected" || value === "resubmission_required" ? "border-destructive/40 bg-destructive/10 text-destructive" : value === "pending" ? "border-warning/50 bg-warning/10 text-warning" : value === "not_initiated" ? "border-chart-5/40 bg-chart-5/10 text-chart-5" : "border-primary/35 bg-primary/10 text-primary";
const familySelectCls = (value: FamilyFilter) => value === "parent" ? "border-chart-5/40 bg-chart-5/10 text-chart-5" : value === "child" ? "border-success/40 bg-success/10 text-success" : "border-primary/35 bg-primary/10 text-primary";
const str = (v: unknown) => (v == null || v === "" ? "—" : String(v));

export default function ClientsPage() {
  const [clients, setClients] = React.useState<ClientRow[] | null>(null);
  const [search, setSearch] = React.useState("");
  const [selId, setSelId] = React.useState<string | null>(null);
  const [detail, setDetail] = React.useState<Detail | null>(null);
  const [tab, setTab] = React.useState("profile");
  const [sumsub, setSumsub] = React.useState<string | null>(null);
  const [kycFilter, setKycFilter] = React.useState<KycFilter>("all");
  const [familyFilter, setFamilyFilter] = React.useState<FamilyFilter>("all");
  const [documentsOpen, setDocumentsOpen] = React.useState(false);
  const [documents, setDocuments] = React.useState<DocumentGroups | null>(null);
  const [documentsBusy, setDocumentsBusy] = React.useState(false);
  const [packBusy, setPackBusy] = React.useState(false);

  React.useEffect(() => {
    fetch("/api/admin/clients?action=list").then((r) => r.json()).then((d) => setClients(d.ok ? d.clients || [] : [])).catch(() => setClients([]));
  }, []);

  const openClient = async (id: string) => {
    setSelId(id); setDetail(null); setTab("profile"); setSumsub(null);
    const client = clients?.find((item) => item.id === id);
    const target = client?.family_member_id
      ? `family_member_id=${encodeURIComponent(client.family_member_id)}`
      : `user_id=${encodeURIComponent(id)}`;
    const d = await fetch(`/api/admin/clients?action=detail&${target}`).then((r) => r.json()).catch(() => ({ ok: false }));
    if (d.ok) setDetail(d);
  };

  const kycAction = async (decision: string) => {
    if (!selId) return;
    const d = await fetch("/api/admin/clients?action=kyc-review", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ user_id: selId, decision }) }).then((r) => r.json());
    if (d.ok) { toast.success(decision === "approve" ? "KYC approved" : "KYC rejected"); await openClient(selId); }
    else toast.error(d.error || "Failed");
  };

  const syncSumsub = async () => {
    if (!selId) return;
    setSumsub("Checking…");
    const d = await fetch(`/api/admin/clients?action=sumsub&user_id=${selId}`).then((r) => r.json()).catch(() => ({ ok: false }));
    if (!d.ok) { setSumsub("SumSub request failed"); return; }
    if (d.configured === false) { setSumsub(d.notice || "SumSub not configured"); return; }
    const data = d.sumsub?.data as { review?: { reviewResult?: { reviewAnswer?: string } }; reviewStatus?: string } | undefined;
    setSumsub(`SumSub: ${data?.review?.reviewResult?.reviewAnswer || data?.reviewStatus || "unknown"}`);
  };

  const childCertificateAction = async (decision: "approve" | "reject" | "reevaluate") => {
    if (!sel?.family_member_id) return;
    const d = await fetch("/api/admin/clients?action=child-certificate-review", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ family_member_id: sel.family_member_id, decision }),
    }).then((response) => response.json()).catch(() => ({ ok: false }));
    if (!d.ok) return toast.error(d.error || "Certificate review failed");
    toast.success(decision === "approve" ? "Child certificate verified" : decision === "reject" ? "Child certificate rejected" : "Certificate returned to review");
    await openClient(sel.id);
  };

  const loadDocuments = async () => {
    if (!sel || sel.family_member_id) return null;
    setDocumentsBusy(true);
    const data = await fetch(`/api/admin/clients/documents?profile_id=${encodeURIComponent(sel.id)}`)
      .then((response) => response.json())
      .catch(() => ({ ok: false }));
    setDocumentsBusy(false);
    if (!data.ok) {
      toast.error(data.error || "Could not load client documents");
      return null;
    }
    const groups = data.groups as DocumentGroups;
    setDocuments(groups);
    return groups;
  };

  const openDocuments = async () => {
    setDocumentsOpen(true);
    setDocuments(null);
    await loadDocuments();
  };

  const downloadPack = async () => {
    if (!sel || sel.family_member_id) return;
    setPackBusy(true);
    try {
      const groups = documents ?? (await loadDocuments());
      if (!groups) return;
      const zip = new JSZip();
      const folders = {
        experian: zip.folder("documents/experian"),
        sumsub: zip.folder("documents/sumsub"),
        signed: zip.folder("documents/signed"),
      };
      let added = 0;
      for (const [source, items] of Object.entries(groups) as [keyof DocumentGroups, ClientDocument[]][]) {
        for (const [index, document] of items.entries()) {
          const response = await fetch(document.url);
          if (!response.ok) continue;
          const blob = await response.blob();
          const extension = extensionForDocument(document, blob.type);
          folders[source]?.file(`${String(index + 1).padStart(2, "0")}-${safeFilename(document.name)}${extension}`, blob);
          added += 1;
        }
      }
      zip.file("manifest.json", JSON.stringify({ profile_id: sel.id, client: sel.name, generated_at: new Date().toISOString(), document_count: added }, null, 2));
      const blob = await zip.generateAsync({ type: "blob" });
      const objectUrl = URL.createObjectURL(blob);
      const anchor = window.document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = `client-pack-${safeFilename(sel.name || sel.id)}.zip`;
      anchor.click();
      URL.revokeObjectURL(objectUrl);
      toast.success(`Downloaded pack with ${added} document${added === 1 ? "" : "s"}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not download client pack");
    } finally {
      setPackBusy(false);
    }
  };

  const filtered = (clients ?? [])
    .filter((c) => kycFilter === "all" || c.kyc === kycFilter)
    .filter((c) => familyFilter === "all" || c.family_role === familyFilter)
    .filter((c) => !search.trim() || `${c.name} ${c.email} ${c.mint_number}`.toLowerCase().includes(search.toLowerCase()));
  const countKyc = (status: Kyc) => (clients ?? []).filter((client) => client.kyc === status).length;
  const sel = clients?.find((c) => c.id === selId) || null;
  const p = detail?.profile ?? {};
  const ob = detail?.onboarding ?? {};

  return (
    <div className="mx-auto max-w-6xl">
      <div className="mb-3 grid grid-cols-2 gap-2 lg:grid-cols-4">
        <ClientMetric label="Total clients" value={clients?.length ?? "—"} tone="primary" />
        <ClientMetric label="KYC completed" value={clients ? countKyc("verified") : "—"} tone="success" />
        <ClientMetric label="KYC pending" value={clients ? countKyc("pending") + countKyc("resubmission_required") : "—"} tone="warning" />
        <ClientMetric label="KYC rejected" value={clients ? countKyc("rejected") : "—"} tone="danger" />
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[320px_1fr]">
        {/* Roster */}
        <div className="rounded-2xl border border-border bg-card p-4">
          <div className="mb-2 grid grid-cols-2 gap-2">
            <label className="space-y-1">
              <span className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">KYC status</span>
              <select value={kycFilter} onChange={(event) => setKycFilter(event.target.value as KycFilter)} className={cn("h-8 w-full rounded-lg border px-2 text-xs font-semibold outline-none transition-colors focus:ring-2 focus:ring-primary/25", kycSelectCls(kycFilter))}>
                <option value="all">All statuses</option>
                <option value="verified">Verified</option>
                <option value="pending">Pending</option>
                <option value="rejected">Rejected</option>
                <option value="resubmission_required">Resubmission required</option>
                <option value="not_initiated">Not initiated</option>
              </select>
            </label>
            <label className="space-y-1">
              <span className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">Family role</span>
              <select value={familyFilter} onChange={(event) => setFamilyFilter(event.target.value as FamilyFilter)} className={cn("h-8 w-full rounded-lg border px-2 text-xs font-semibold outline-none transition-colors focus:ring-2 focus:ring-primary/25", familySelectCls(familyFilter))}>
                <option value="all">All clients</option>
                <option value="parent">Parents</option>
                <option value="child">Children</option>
              </select>
            </label>
          </div>
          <div className="relative mb-3">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search clients…" className="h-8 pl-8" />
          </div>
          <div className="max-h-[70vh] space-y-1 overflow-y-auto">
            {clients === null ? <p className="py-6 text-center text-xs text-muted-foreground">Loading…</p>
              : filtered.length === 0 ? <p className="py-6 text-center text-xs text-muted-foreground">No clients.</p>
              : filtered.map((c) => (
                <button key={c.id} onClick={() => openClient(c.id)} className={cn("flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left", selId === c.id ? "bg-primary/10" : "hover:bg-accent/50")}>
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-primary to-chart-5 text-[11px] font-bold text-primary-foreground">{initials(c.name)}</div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5"><span className="truncate text-sm font-medium text-foreground">{c.name}</span>{c.is_test && <span className="rounded bg-muted px-1 text-[9px] text-muted-foreground">TEST</span>}{c.family_role === "child" && <span className="rounded bg-primary/10 px-1 text-[9px] text-primary">{c.is_linked_child ? "LINKED CHILD" : "UNLINKED CHILD"}</span>}</div>
                    <div className="truncate text-[11px] text-muted-foreground">{c.mint_number || c.email}</div>
                  </div>
                  <span title={kycLabel(c.kyc)} className={cn("rounded-full px-1.5 py-0.5 text-[9px] font-bold uppercase", kycCls(c.kyc))}>{c.kyc === "not_initiated" ? "N" : c.kyc === "resubmission_required" ? "R!" : c.kyc[0]}</span>
                </button>
              ))}
          </div>
        </div>

        {/* Detail */}
        <div className="rounded-2xl border border-border bg-card p-5">
          {!sel ? <div className="flex h-full min-h-[300px] items-center justify-center text-sm text-muted-foreground">Select a client.</div>
            : detail === null ? <p className="py-16 text-center text-sm text-muted-foreground">Loading…</p>
            : (
              <div className="space-y-4">
                <div className="flex items-center gap-3 border-b border-border pb-4">
                  <div className="flex h-12 w-12 items-center justify-center rounded-full bg-gradient-to-br from-primary to-chart-5 text-base font-bold text-primary-foreground">{initials(sel.name)}</div>
                  <div className="min-w-0 flex-1">
                    <div className="text-lg font-bold text-foreground">{sel.name}</div>
                    <div className="text-xs text-muted-foreground">{sel.email} {sel.mint_number ? `· ${sel.mint_number}` : ""}</div>
                  </div>
                  <span className={cn("rounded-full px-2.5 py-1 text-[11px] font-semibold capitalize", kycCls(detail.kyc))}>{kycLabel(detail.kyc)}</span>
                </div>

                {!detail.is_unlinked_child && <div className="flex flex-wrap justify-end gap-2">
                  <Button size="sm" variant="secondary" onClick={openDocuments}><Eye />Documents</Button>
                  <Button size="sm" onClick={downloadPack} disabled={packBusy}><Package />{packBusy ? "Preparing pack…" : "Download pack"}</Button>
                </div>}

                <Tabs value={tab} onValueChange={setTab}>
                  <TabsList><TabsTrigger value="profile">Profile</TabsTrigger><TabsTrigger value="kyc">KYC</TabsTrigger>{!detail.is_unlinked_child && <TabsTrigger value="mandate">Mandate</TabsTrigger>}<TabsTrigger value="holdings">Holdings</TabsTrigger><TabsTrigger value="activity">Activity</TabsTrigger></TabsList>

                  <TabsContent value="profile">
                    <dl className="grid grid-cols-1 gap-px overflow-hidden rounded-xl border border-border bg-border sm:grid-cols-2">
                      <Row label="Email" value={str(p.email)} /><Row label="Phone" value={str(p.phone_number)} />
                      <Row label="Date of birth" value={str(p.date_of_birth)} /><Row label="Gender" value={str(p.gender)} />
                      <Row label="ID number" value={str(p.id_number)} /><Row label="Currency" value={str(p.preferred_currency)} />
                      <Row label="MINT number" value={str(p.mint_number)} /><Row label="Computershare" value={str(p.computershare_number)} />
                      <Row label="Address" value={str(p.address)} /><Row label="Joined" value={p.created_at ? new Date(String(p.created_at)).toLocaleDateString("en-ZA") : "—"} />
                      <Row label="Managing parent" value={str(p.managing_parent ?? p.guardian_name ?? p.parent_name)} /><Row label="Relationship" value={str(p.parent_relationship ?? p.relationship)} />
                    </dl>
                  </TabsContent>

                  <TabsContent value="mandate" className="space-y-3">
                    {!detail.mandate?.available ? <p className="rounded-xl border border-dashed border-border py-8 text-center text-xs text-muted-foreground">No captured mandate is available for this client.</p> : <>
                      <dl className="grid grid-cols-1 gap-px overflow-hidden rounded-xl border border-border bg-border sm:grid-cols-2">
                        {Object.entries(detail.mandate.data).map(([key, value]) => <Row key={key} label={key.replaceAll("_", " ")} value={formatDetailValue(value)} />)}
                      </dl>
                      {detail.mandate.signed_agreement_url && <Button size="sm" variant="secondary" asChild><a href={detail.mandate.signed_agreement_url} target="_blank" rel="noreferrer">View signed agreement</a></Button>}
                    </>}
                    {detail.onboarding_pack && <details className="rounded-xl border border-border p-3"><summary className="cursor-pointer text-xs font-semibold text-foreground">Captured onboarding pack</summary><dl className="mt-3 grid grid-cols-1 gap-px overflow-hidden rounded-lg bg-border sm:grid-cols-2">{Object.entries(detail.onboarding_pack).map(([key, value]) => <Row key={key} label={key.replaceAll("_", " ")} value={formatDetailValue(value)} />)}</dl></details>}
                  </TabsContent>

                  <TabsContent value="kyc" className="space-y-4">
                    <dl className="grid grid-cols-1 gap-px overflow-hidden rounded-xl border border-border bg-border sm:grid-cols-2">
                      <Row label="KYC status" value={str(ob.kyc_status)} /><Row label="SumSub answer" value={str(ob.sumsub_review_answer)} />
                      <Row label="SumSub status" value={str(ob.sumsub_review_status)} /><Row label="Verified at" value={ob.kyc_verified_at ? new Date(String(ob.kyc_verified_at)).toLocaleDateString("en-ZA") : "—"} />
                      <Row label="Bank" value={str(ob.bank_name)} /><Row label="Account #" value={str(ob.bank_account_number)} />
                      <Row label="Employer" value={str(ob.employer_name)} /><Row label="Employment" value={str(ob.employment_status)} />
                      <Row label="Annual income" value={str(ob.annual_income_amount)} /><Row label="Agreement" value={ob.signed_agreement_url ? "Signed" : "—"} />
                    </dl>
                    <div className="flex flex-wrap items-center gap-2">
                      {detail.is_unlinked_child ? <>
                        {detail.child_certificate?.url ? <Button size="sm" variant="secondary" asChild><a href={detail.child_certificate.url} target="_blank" rel="noreferrer">View certificate</a></Button> : <span className="text-[11px] text-muted-foreground">No child certificate has been uploaded.</span>}
                        {detail.child_certificate?.url && detail.kyc !== "verified" && <Button size="sm" variant="success" onClick={() => childCertificateAction("approve")}>Accept certificate</Button>}
                        {detail.child_certificate?.url && detail.kyc !== "rejected" && <Button size="sm" variant="destructive" onClick={() => childCertificateAction("reject")}>Reject certificate</Button>}
                        {detail.child_certificate?.url && detail.kyc === "rejected" && <Button size="sm" variant="warning" onClick={() => childCertificateAction("reevaluate")}>Re-evaluate</Button>}
                      </> : <>
                      <Button size="sm" variant="success" onClick={() => kycAction("approve")}>Approve KYC</Button>
                      <Button size="sm" variant="destructive" onClick={() => kycAction("reject")}>Reject</Button>
                      <Button size="sm" variant="secondary" onClick={syncSumsub}>Sync SumSub</Button>
                      {sumsub && <span className="text-[11px] text-muted-foreground">{sumsub}</span>}
                      </>}
                    </div>
                  </TabsContent>

                  <TabsContent value="holdings">
                    <div className="overflow-x-auto rounded-xl border border-border">
                      <table className="w-full border-collapse">
                        <thead><tr className="border-b border-border">{["Instrument", "Strategy", "Qty", "Purchase Value", "Market Value", "Total P&L"].map((h) => <th key={h} className="px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{h}</th>)}</tr></thead>
                        <tbody>
                          {detail.holdings.length === 0 ? <tr><td colSpan={6} className="px-3 py-8 text-center text-xs text-muted-foreground">No holdings.</td></tr>
                            : detail.holdings.map((h, i) => (
                              <tr key={`${h.symbol}-${i}`} className="border-b border-border/40 last:border-b-0">
                                <td className="px-3 py-2 text-[12px]"><span className="font-semibold text-foreground">{h.symbol}</span>{h.name ? <span className="ml-2 text-[11px] text-muted-foreground">{h.name}</span> : null}</td>
                                <td className="px-3 py-2 text-[12px] text-muted-foreground">{h.strategy || "—"}</td>
                                <td className="px-3 py-2 text-[12px] text-foreground">{h.qty}</td>
                                <td className="px-3 py-2 text-[12px] text-foreground">{h.purchaseValueCents != null ? R(h.purchaseValueCents) : "—"}</td>
                                <td className="px-3 py-2 text-[12px] text-foreground">{R(h.valueCents)}</td>
                                <td className={cn("px-3 py-2 text-[12px]", pnlCls(h.pnlCents))}>{R(h.pnlCents)}</td>
                              </tr>
                            ))}
                        </tbody>
                      </table>
                    </div>
                  </TabsContent>

                  <TabsContent value="activity">
                    <div className="divide-y divide-border">
                      {detail.transactions.length === 0 ? <p className="py-8 text-center text-xs text-muted-foreground">No activity.</p>
                        : detail.transactions.map((t) => (
                          <div key={t.id} className="flex items-center justify-between gap-3 py-2.5">
                            <div className="min-w-0"><p className="truncate text-sm text-foreground">{t.name || t.description || "—"}</p><p className="text-[11px] text-muted-foreground">{t.transaction_date ? new Date(t.transaction_date).toLocaleDateString("en-ZA") : ""} · {t.status || ""}</p></div>
                            <span className={cn("text-sm font-medium", t.direction === "credit" ? "text-success" : "text-foreground")}>{t.direction === "credit" ? "+" : "-"}R {Math.abs(Number(t.amount) || 0).toLocaleString("en-ZA")}</span>
                          </div>
                        ))}
                    </div>
                  </TabsContent>
                </Tabs>
              </div>
            )}
        </div>
      </div>
      {documentsOpen && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4" role="dialog" aria-modal="true" aria-label="Select document">
        <div className="flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-2xl">
          <div className="flex items-center justify-between border-b border-border px-5 py-4"><h2 className="text-base font-bold text-foreground">Select document</h2><Button size="icon-sm" variant="ghost" aria-label="Close" onClick={() => setDocumentsOpen(false)}><X /></Button></div>
          <div className="space-y-5 overflow-y-auto p-5">
            {documentsBusy || documents === null ? <p className="py-12 text-center text-sm text-muted-foreground">Loading documents…</p> : <>
              <DocumentSection title="Experian documents" items={documents.experian} empty="No Experian documents archived for this user." />
              <DocumentSection title="Sumsub documents" items={documents.sumsub} empty="No Sumsub documents found for this user." />
              <DocumentSection title="Signed documents" items={documents.signed} empty="No signed documents found for this user." />
            </>}
          </div>
          <div className="flex items-center justify-between border-t border-border px-5 py-3"><small className="text-[11px] text-muted-foreground">Tip: You can preview or download any document directly.</small><Button size="sm" onClick={downloadPack} disabled={packBusy}><Download />{packBusy ? "Preparing…" : "Download pack"}</Button></div>
        </div>
      </div>}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return <div className="flex items-center justify-between gap-3 bg-card px-3 py-2.5"><dt className="text-[11px] text-muted-foreground">{label}</dt><dd className="truncate text-[13px] font-medium text-foreground">{value}</dd></div>;
}

function formatDetailValue(value: unknown): string {
  if (value == null || value === "") return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function DocumentSection({ title, items, empty }: { title: string; items: ClientDocument[]; empty: string }) {
  return <section><div className="mb-2 flex items-center gap-2"><h3 className="text-xs font-bold uppercase tracking-wider text-foreground">{title}</h3><span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-bold text-primary">{items.length}</span></div>{items.length === 0 ? <div className="rounded-xl border border-dashed border-border px-4 py-5 text-center text-xs text-muted-foreground">{empty}</div> : <div className="space-y-2">{items.map((document) => <div key={`${document.source}-${document.id}`} className="flex items-center gap-3 rounded-xl border border-border bg-background px-3 py-2.5"><div className="min-w-0 flex-1"><p className="truncate text-sm font-semibold text-foreground">{document.name}</p><p className="text-[10px] text-muted-foreground">{document.fileType}{document.addedDate ? ` · ${new Date(document.addedDate).toLocaleDateString("en-ZA")}` : ""}</p></div><Button size="sm" variant="ghost" asChild><a href={document.url} target="_blank" rel="noreferrer"><Eye />Preview</a></Button><Button size="sm" variant="secondary" asChild><a href={document.url} download><Download />Download</a></Button></div>)}</div>}</section>;
}

function safeFilename(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "document";
}

function extensionForDocument(document: ClientDocument, mimeType: string): string {
  if (/\.[a-zA-Z0-9]{2,5}$/.test(document.name)) return "";
  if (mimeType.includes("pdf") || document.fileType.toLowerCase().includes("pdf")) return ".pdf";
  if (mimeType.includes("png")) return ".png";
  if (mimeType.includes("jpeg") || mimeType.includes("jpg")) return ".jpg";
  if (mimeType.includes("json")) return ".json";
  return ".bin";
}

function ClientMetric({ label, value, tone }: { label: string; value: number | string; tone: "primary" | "success" | "warning" | "danger" }) {
  const accent = tone === "success" ? "bg-success" : tone === "warning" ? "bg-warning" : tone === "danger" ? "bg-destructive" : "bg-primary";
  return (
    <div className="flex h-14 items-center gap-3 rounded-xl border border-border bg-card px-3.5 shadow-sm">
      <span className={cn("h-7 w-1 rounded-full", accent)} aria-hidden="true" />
      <div className="min-w-0">
        <div className="font-mono text-lg font-bold leading-none text-foreground">{value}</div>
        <div className="mt-1 truncate text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</div>
      </div>
    </div>
  );
}
