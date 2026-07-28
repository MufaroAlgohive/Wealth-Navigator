"use client";

import * as React from "react";
import JSZip from "jszip";
import { toast } from "sonner";
import { Download, Eye, Package, Pencil, Search, X } from "lucide-react";

import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { cn } from "@/lib/cn";
import { DataSourceBadge } from "@/components/oems/primitives/data-source-badge";
import { buildMandatePdfReport } from "@/lib/pdf/mandate";

type Kyc = "not_initiated" | "pending" | "verified" | "rejected" | "resubmission_required";
type KycFilter = "all" | Kyc;
type FamilyFilter = "all" | "parent" | "child";
interface ClientRow { id: string; name: string; email: string | null; mint_number: string | null; is_test: boolean | null; kyc: Kyc; bank_linked: boolean; family_role: "parent" | "child" | "other"; family_member_id?: string | null; is_linked_child?: boolean; }
interface Holding { symbol: string; name: string; qty: number; valueCents: number; pnlCents: number; strategy: string | null; purchaseValueCents?: number | null; }
interface Txn { id: string; name: string | null; description: string | null; amount: number; direction: string; status: string | null; transaction_date: string | null; }
interface ClientDocument { id: string; name: string; fileType: string; addedDate: string | null; url: string; source: "experian" | "sumsub" | "signed"; }
interface DocumentGroups { experian: ClientDocument[]; sumsub: ClientDocument[]; signed: ClientDocument[]; }
interface ClientStats { total: number; completed: number; pending: number; rejected: number; }
interface RichField { value: unknown; source: string; }
interface RichDetails { fields: Record<string, RichField>; providers: { profile: boolean; sumsub: boolean; experian: boolean }; }
interface Detail {
  profile: Record<string, unknown> | null;
  onboarding: Record<string, unknown> | null;
  kyc: Kyc;
  holdings: Holding[];
  transactions: Txn[];
  is_unlinked_child?: boolean;
  child_family_member_id?: string | null;
  onboarding_pack?: Record<string, unknown> | null;
  mandate?: { available: boolean; data: Record<string, unknown>; signed_agreement_url?: string | null };
  child_certificate?: { url?: string | null; status?: string | null; reviewed_at?: string | null };
  rich_details?: RichDetails | null;
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
  const [clientStats, setClientStats] = React.useState<ClientStats | null>(null);
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
  const [computershareBusy, setComputershareBusy] = React.useState(false);
  const [mandateBusy, setMandateBusy] = React.useState(false);
  const [computershareEditorOpen, setComputershareEditorOpen] = React.useState(false);
  const [computershareNumber, setComputershareNumber] = React.useState("");
  const [computersharePassword, setComputersharePassword] = React.useState("");
  const [computershareSaving, setComputershareSaving] = React.useState(false);

  React.useEffect(() => {
    fetch("/api/admin/clients?action=list").then((r) => r.json()).then((d) => {
      setClients(d.ok ? d.clients || [] : []);
      setClientStats(d.ok ? d.stats || null : null);
    }).catch(() => { setClients([]); setClientStats(null); });
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

  const syncSumsub = async () => {
    if (!selId) return;
    setSumsub("Checking…");
    const d = await fetch("/api/admin/clients?action=sumsub-refresh", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ user_id: selId }) }).then((r) => r.json()).catch(() => ({ ok: false }));
    if (!d.ok) { setSumsub("SumSub request failed"); return; }
    if (d.configured === false) { setSumsub(d.notice || "SumSub not configured"); return; }
    const data = d.sumsub?.data as { review?: { reviewResult?: { reviewAnswer?: string } }; reviewStatus?: string } | undefined;
    await openClient(selId);
    setSumsub(`SumSub: ${data?.review?.reviewResult?.reviewAnswer || data?.reviewStatus || "refreshed"}`);
  };

  const saveComputershareNumber = async () => {
    if (!sel) return;
    setComputershareSaving(true);
    const response = await fetch("/api/admin/clients?action=computershare-number", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: sel.family_member_id ? undefined : sel.id, family_member_id: sel.family_member_id || undefined, computershare_number: computershareNumber, password: computersharePassword }),
    }).then((result) => result.json()).catch(() => ({ ok: false, error: "Request failed" }));
    setComputershareSaving(false);
    if (!response.ok) return toast.error(response.error || "Could not save Computershare number");
    toast.success("Computershare number saved");
    setComputershareEditorOpen(false); setComputersharePassword("");
    await openClient(sel.id);
  };

  const childCertificateAction = async (decision: "approve" | "reject" | "reevaluate") => {
    if (!sel) return;
    const familyMemberId = sel?.family_member_id || detail?.child_family_member_id;
    if (!familyMemberId) return;
    const d = await fetch("/api/admin/clients?action=child-certificate-review", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ family_member_id: familyMemberId, decision }),
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
      // Bundle the Computershare account-creation PDF into the pack (mirrors
      // the CRM, which includes it in the client pack download). Best-effort:
      // a generation failure must never sink the rest of the pack.
      let computershareIncluded = false;
      let mandateIncluded = false;
      if (detail) {
        try {
          const report = await buildComputersharePdf(p, ob, detail.onboarding_pack ?? {});
          zip.file(report.filename, report.doc.output("blob"));
          computershareIncluded = true;
          added += 1;
        } catch (csErr) {
          console.error("Computershare PDF for pack failed:", csErr);
        }
        try {
          const mandateReport = await buildMandatePdfReport(p, ob, detail.onboarding_pack ?? {});
          zip.file(mandateReport.filename, mandateReport.doc.output("blob"));
          mandateIncluded = true;
          added += 1;
        } catch (mErr) {
          console.error("Mandate PDF for pack failed:", mErr);
        }
      }
      zip.file("manifest.json", JSON.stringify({ profile_id: sel.id, client: sel.name, generated_at: new Date().toISOString(), document_count: added, computershare_included: computershareIncluded, mandate_included: mandateIncluded }, null, 2));
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

  const openComputershareDocument = async (mode: "view" | "download") => {
    if (!detail) return;
    setComputershareBusy(true);
    try {
      const report = await buildComputersharePdf(p, ob, detail.onboarding_pack ?? {});
      if (mode === "download") report.doc.save(report.filename);
      else {
        const blobUrl = URL.createObjectURL(report.doc.output("blob"));
        const opened = window.open(blobUrl, "_blank", "noopener,noreferrer");
        if (!opened) report.doc.save(report.filename);
        window.setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not generate Computershare document");
    } finally {
      setComputershareBusy(false);
    }
  };

  const openMandateDocument = async (mode: "view" | "download") => {
    if (!detail) return;
    setMandateBusy(true);
    try {
      const report = await buildMandatePdfReport(p, ob, detail.onboarding_pack ?? {});
      if (mode === "download") report.doc.save(report.filename);
      else {
        const blobUrl = URL.createObjectURL(report.doc.output("blob"));
        const opened = window.open(blobUrl, "_blank", "noopener,noreferrer");
        if (!opened) report.doc.save(report.filename);
        window.setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not generate mandate document");
    } finally {
      setMandateBusy(false);
    }
  };

  const filtered = (clients ?? [])
    .filter((c) => kycFilter === "all" || c.kyc === kycFilter)
    .filter((c) => familyFilter === "all" || c.family_role === familyFilter)
    .filter((c) => !search.trim() || `${c.name} ${c.email} ${c.mint_number}`.toLowerCase().includes(search.toLowerCase()));
  const sel = clients?.find((c) => c.id === selId) || null;
  const p = detail?.profile ?? {};
  const ob = detail?.onboarding ?? {};

  return (
    <div className="mx-auto max-w-6xl">
      <div className="mb-2 flex justify-end"><DataSourceBadge source="supabase" db="retail" /></div>
      <div className="mb-3 grid grid-cols-2 gap-2 lg:grid-cols-4">
        <ClientMetric label="Total clients" value={clientStats?.total ?? "—"} tone="primary" />
        <ClientMetric label="KYC completed" value={clientStats?.completed ?? "—"} tone="success" />
        <ClientMetric label="KYC pending" value={clientStats?.pending ?? "—"} tone="warning" />
        <ClientMetric label="KYC rejected" value={clientStats?.rejected ?? "—"} tone="danger" />
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
                    <div className="flex items-center gap-1.5"><span className="truncate text-sm font-medium text-foreground">{c.name}</span>{c.is_test && <span className="rounded bg-muted px-1 text-[9px] text-muted-foreground">TEST</span>}{c.family_role === "child" && <span className="rounded bg-primary/10 px-1 text-[9px] text-primary">{c.is_linked_child ? "CHILD PROFILE" : "MANAGED CHILD"}</span>}</div>
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
                  <DataSourceBadge source="supabase" db="retail" />
                  <span className={cn("rounded-full px-2.5 py-1 text-[11px] font-semibold capitalize", kycCls(detail.kyc))}>{kycLabel(detail.kyc)}</span>
                </div>

                {!detail.is_unlinked_child && <div className="flex flex-wrap justify-end gap-2">
                  <Button size="sm" variant="secondary" onClick={openDocuments}><Eye />Documents</Button>
                  <Button size="sm" onClick={downloadPack} disabled={packBusy}><Package />{packBusy ? "Preparing pack…" : "Download pack"}</Button>
                </div>}

                <Tabs value={tab} onValueChange={setTab}>
                  <TabsList><TabsTrigger value="profile">Profile</TabsTrigger><TabsTrigger value="kyc">KYC</TabsTrigger>{!detail.is_unlinked_child && <TabsTrigger value="mandate">Mandate</TabsTrigger>}<TabsTrigger value="holdings">Holdings</TabsTrigger><TabsTrigger value="activity">Activity</TabsTrigger></TabsList>

                  <TabsContent value="profile">
                    {detail.rich_details && <RichClientDetails details={detail.rich_details} />}
                    <dl className="mt-4 grid grid-cols-1 gap-px overflow-hidden rounded-xl border border-border bg-border sm:grid-cols-2">
                      <Row label="Email" value={str(p.email ?? detail.rich_details?.fields.email?.value)} /><Row label="Phone" value={str(p.phone_number ?? detail.rich_details?.fields.phone?.value)} />
                      <Row label="Date of birth" value={str(p.date_of_birth ?? detail.rich_details?.fields.date_of_birth?.value)} /><Row label="Gender" value={str(p.gender ?? detail.rich_details?.fields.gender?.value)} />
                      <Row label="ID number" value={str(p.id_number ?? detail.rich_details?.fields.id_number?.value)} /><Row label="Currency" value={str(p.preferred_currency ?? "ZAR")} />
                      <Row label="MINT number" value={str(p.mint_number)} />
                      <div className="flex items-center justify-between gap-3 bg-card px-3 py-2.5"><dt className="text-[11px] text-muted-foreground">Computershare</dt><dd className="flex items-center gap-2 truncate text-[13px] font-medium text-foreground"><span>{str(p.computershare_number)}</span>{!p.computershare_number&&<button type="button" title="Add Computershare number" aria-label="Add Computershare number" onClick={()=>{setComputershareNumber("");setComputersharePassword("");setComputershareEditorOpen(true);}} className="flex h-6 w-6 items-center justify-center rounded-full bg-primary/10 text-primary hover:bg-primary/20"><Pencil className="h-3 w-3" /></button>}</dd></div>
                      <Row label="Address" value={str(p.address ?? detail.rich_details?.fields.address?.value)} /><Row label="Joined" value={p.created_at ? new Date(String(p.created_at)).toLocaleDateString("en-ZA") : "—"} />
                      <Row label="Managing parent" value={str(p.managing_parent ?? p.guardian_name ?? p.parent_name)} /><Row label="Relationship" value={str(p.parent_relationship ?? p.relationship)} />
                    </dl>
                  </TabsContent>

                  <TabsContent value="mandate" className="space-y-3">
                    {/* The Discretionary FSP Mandate PDF is generatable for every
                        client — the document itself stamps a "not yet signed"
                        banner when no mandate has been captured (mirrors the CRM,
                        which offers the mandate download on every client). */}
                    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-gradient-to-br from-primary/10 to-transparent p-3">
                      <div><p className="text-xs font-semibold text-foreground">Client investment mandate</p><p className="text-[10px] text-muted-foreground">Captured authorisations, discretion and client acknowledgements</p></div>
                      <div className="flex gap-2"><Button size="sm" variant="secondary" disabled={mandateBusy} onClick={()=>openMandateDocument("view")}><Eye />{mandateBusy?"Preparing…":"View mandate"}</Button><Button size="sm" disabled={mandateBusy} onClick={()=>openMandateDocument("download")}><Download />Download PDF</Button></div>
                    </div>
                    {!detail.mandate?.available && <p className="rounded-xl border border-dashed border-border py-6 text-center text-xs text-muted-foreground">No captured mandate is on file yet — the PDF will generate with a &ldquo;not yet signed&rdquo; notice.</p>}
                    {detail.mandate?.data && <MandateView data={detail.mandate.data} profile={p} />}
                    {detail.mandate?.signed_agreement_url && <a href={detail.mandate.signed_agreement_url} target="_blank" rel="noreferrer" className="block text-[10px] text-primary underline underline-offset-2">Open separately stored signed agreement</a>}
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
                    {!detail.is_unlinked_child && <div className="flex items-center gap-3 rounded-xl border border-border bg-card px-3 py-2.5">
                      <div className="min-w-0 flex-1"><p className="text-xs font-semibold text-foreground">ComputerShare account creation doc</p><p className="text-[10px] text-muted-foreground">Details authorised for share-account creation</p></div>
                      <Button size="sm" variant="secondary" disabled={computershareBusy} onClick={() => openComputershareDocument("view")}><Eye />View</Button>
                      <button type="button" disabled={computershareBusy} onClick={() => openComputershareDocument("download")} title="Download Computershare document" aria-label="Download Computershare document" className="flex h-7 w-7 items-center justify-center rounded-full bg-primary/10 text-primary transition-colors hover:bg-primary/20 disabled:opacity-50"><Download className="h-3.5 w-3.5" /></button>
                    </div>}
                    <div className="flex flex-wrap items-center gap-2">
                      {detail.is_unlinked_child || detail.child_family_member_id ? <>
                        {detail.child_certificate?.url ? <Button size="sm" variant="secondary" asChild><a href={detail.child_certificate.url} target="_blank" rel="noreferrer">View certificate</a></Button> : <span className="text-[11px] text-muted-foreground">No child certificate has been uploaded.</span>}
                        {detail.child_certificate?.url && detail.kyc !== "verified" && <Button size="sm" variant="success" onClick={() => childCertificateAction("approve")}>Accept certificate</Button>}
                        {detail.child_certificate?.url && detail.kyc !== "rejected" && <Button size="sm" variant="destructive" onClick={() => childCertificateAction("reject")}>Reject certificate</Button>}
                        {detail.child_certificate?.url && detail.kyc === "rejected" && <Button size="sm" variant="warning" onClick={() => childCertificateAction("reevaluate")}>Re-evaluate</Button>}
                      </> : <>
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
                            <span className={cn("text-sm font-medium", t.direction === "credit" ? "text-success" : "text-foreground")}>{t.direction === "credit" ? "+" : "-"}{new Intl.NumberFormat("en-ZA", { style: "currency", currency: "ZAR", minimumFractionDigits: 2 }).format(Math.abs(Number(t.amount) || 0) / 100)}</span>
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
      {computershareEditorOpen && <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true" aria-label="Add Computershare number"><div className="w-full max-w-sm space-y-4 rounded-2xl border border-border bg-card p-5 shadow-2xl"><div className="flex items-center justify-between"><div><h2 className="text-sm font-bold text-foreground">Add Computershare number</h2><p className="text-[10px] text-muted-foreground">Admin password confirmation is required.</p></div><Button size="icon-sm" variant="ghost" onClick={()=>setComputershareEditorOpen(false)}><X /></Button></div><label className="block text-[11px] font-semibold text-foreground">Computershare number<Input className="mt-1" value={computershareNumber} onChange={(event)=>setComputershareNumber(event.target.value)} autoComplete="off" /></label><label className="block text-[11px] font-semibold text-foreground">Your admin password<Input className="mt-1" type="password" value={computersharePassword} onChange={(event)=>setComputersharePassword(event.target.value)} autoComplete="current-password" /></label><div className="flex justify-end gap-2"><Button variant="secondary" onClick={()=>setComputershareEditorOpen(false)}>Cancel</Button><Button disabled={computershareSaving||!computershareNumber.trim()||!computersharePassword} onClick={saveComputershareNumber}>{computershareSaving?"Saving…":"Save"}</Button></div></div></div>}
    </div>
  );
}

function RichClientDetails({ details }: { details: RichDetails }) {
  const labels: Record<string,string>={first_name:"First name",last_name:"Last name",email:"Email",phone:"Phone",date_of_birth:"Date of birth",gender:"Gender",id_number:"ID number",address:"Residential address",employer:"Employer",employment_status:"Employment status"};
  const populated=Object.entries(details.fields).filter(([,field])=>field.value!=null&&field.value!=="");
  return <details className="group rounded-xl border border-primary/20 bg-gradient-to-br from-primary/10 via-transparent to-transparent p-3">
    <summary className="flex cursor-pointer list-none flex-wrap items-center gap-2"><div className="mr-auto"><p className="text-xs font-bold uppercase tracking-wider text-foreground">Rich client record</p><p className="text-[10px] text-muted-foreground">Best available confirmed value with source provenance · click to expand</p></div>{details.providers.profile&&<ProviderBadge source="Profile"/>}{details.providers.sumsub&&<ProviderBadge source="SumSub"/>}{details.providers.experian&&<ProviderBadge source="Experian"/>}<span className="text-xs text-muted-foreground transition-transform group-open:rotate-180">⌄</span></summary>
    <dl className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">{populated.map(([key,field])=><div key={key} className="rounded-lg border border-border bg-card px-3 py-2"><dt className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">{labels[key]||key.replaceAll("_"," ")}</dt><dd className="mt-0.5 break-words text-[13px] font-medium text-foreground">{formatDetailValue(field.value)}</dd><ProviderBadge source={field.source}/></div>)}</dl>
  </details>;
}

function ProviderBadge({source}:{source:string}){return <span className={cn("mt-1 inline-flex rounded-full px-1.5 py-0.5 text-[8px] font-bold uppercase tracking-wide",source==="Experian"?"bg-success/15 text-success":source==="SumSub"?"bg-primary/15 text-primary":source==="Onboarding"||source==="Derived from SA ID"?"bg-warning/15 text-warning":"bg-muted text-muted-foreground")}>{source}</span>}

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

function mandateLabel(key: string) {
  return key.replace(/([a-z])([A-Z])/g, "$1 $2").replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function mandateEntries(data: Record<string, unknown>) {
  const checked = objectValue(data.checkedBoxes);
  const details = Object.entries(data).filter(([key]) => key !== "checkedBoxes");
  return { checked, details };
}

function MandateView({ data, profile }: { data: Record<string, unknown>; profile: Record<string, unknown> }) {
  const { checked, details } = mandateEntries(data);
  const fullName = `${String(profile.first_name || "")} ${String(profile.last_name || "")}`.trim() || String(profile.email || "Client");
  const accepted = Object.entries(checked).filter(([, value]) => value === true || String(value).toLowerCase() === "true");
  return <div className="space-y-3">
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
      <MandateMetric label="Client" value={fullName} />
      <MandateMetric label="Discretion" value={mandateLabel(String(data.discretionType || data.discretion_type || "Full discretion"))} />
      <MandateMetric label="Acknowledgements" value={`${accepted.length} accepted`} />
    </div>
    {details.length > 0 && <section className="overflow-hidden rounded-xl border border-border"><div className="border-b border-border bg-muted/30 px-3 py-2 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">Mandate instructions</div><dl className="grid grid-cols-1 gap-px bg-border sm:grid-cols-2">{details.map(([key,value])=><Row key={key} label={mandateLabel(key)} value={formatDetailValue(value)} />)}</dl></section>}
    <section className="overflow-hidden rounded-xl border border-border"><div className="border-b border-border bg-muted/30 px-3 py-2 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">Client acknowledgements</div>{Object.keys(checked).length?<div className="grid grid-cols-1 gap-px bg-border sm:grid-cols-2">{Object.entries(checked).map(([key,value])=><div key={key} className="flex items-start gap-2 bg-card px-3 py-2"><span className={cn("mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[9px] font-bold",value===true||String(value).toLowerCase()==="true"?"bg-success/15 text-success":"bg-muted text-muted-foreground")}>{value===true||String(value).toLowerCase()==="true"?"✓":"—"}</span><span className="text-[10px] leading-relaxed text-foreground">{mandateLabel(key)}</span></div>)}</div>:<p className="p-3 text-xs text-muted-foreground">No checkbox acknowledgements were captured.</p>}</section>
  </div>;
}

function MandateMetric({ label, value }: { label: string; value: string }) {
  return <div className="rounded-lg border border-border bg-card px-3 py-2"><p className="text-[8px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</p><p className="mt-1 truncate text-xs font-semibold text-foreground">{value}</p></div>;
}


function extensionForDocument(document: ClientDocument, mimeType: string): string {
  if (/\.[a-zA-Z0-9]{2,5}$/.test(document.name)) return "";
  if (mimeType.includes("pdf") || document.fileType.toLowerCase().includes("pdf")) return ".pdf";
  if (mimeType.includes("png")) return ".png";
  if (mimeType.includes("jpeg") || mimeType.includes("jpg")) return ".jpg";
  if (mimeType.includes("json")) return ".json";
  return ".bin";
}

function objectValue(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch { /* empty */ }
  }
  return {};
}

function pickPath(source: Record<string, unknown>, paths: string[]): unknown {
  for (const path of paths) {
    let current: unknown = source;
    for (const part of path.split(".")) current = current && typeof current === "object" ? (current as Record<string, unknown>)[part] : undefined;
    if (current != null && String(current).trim()) return current;
  }
  return null;
}

function firstValue(values: unknown[], fallback = "N/A"): string {
  const found = values.find((value) => value != null && String(value).trim());
  return found == null ? fallback : String(found).trim();
}

// Computershare letterhead logo — same public asset the CRM's account-creation
// PDF draws top-right (MyMintAdmin index.html COMPUTERSHARE_LOGO_URL).
const COMPUTERSHARE_LOGO_URL =
  "https://mfxnghmuccevsxwcetej.supabase.co/storage/v1/object/public/Mint%20Assets/tMOmeIOo4KE20Yh1bIuk8PFMlFHZ421rVESa2dcn.jpg";

async function loadImageAsDataUrl(url: string): Promise<string> {
  const imageUrl = String(url || "").trim();
  if (!imageUrl) return "";
  const response = await fetch(imageUrl);
  if (!response.ok) throw new Error(`Logo request failed: ${response.status}`);
  const blob = await response.blob();
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("Could not read logo data."));
    reader.readAsDataURL(blob);
  });
}

/**
 * Computershare "ACCOUNT DETAILS" account-creation PDF. A field-for-field,
 * layout-for-layout port of MyMintAdmin's buildComputerSharePdfReport
 * (public/index.html): same 16-row table, same logo top-right, same box
 * borders and vertical rhythm, and the same data-mapping fallback chains so
 * the same fields populate (rather than reading "N/A").
 *
 * When `existingDoc` is supplied, the ACCOUNT DETAILS page is appended to it
 * (used to bundle this into the client pack ZIP) instead of a new document.
 */
async function buildComputersharePdf(
  profile: Record<string, unknown>,
  onboarding: Record<string, unknown>,
  packValue: Record<string, unknown>,
  existingDoc?: import("jspdf").jsPDF,
) {
  const { jsPDF } = await import("jspdf");
  const pack = objectValue(packValue);
  const sumsubRaw = objectValue(onboarding.sumsub_raw);
  const mandate = objectValue(sumsubRaw.mandate_data);
  const tax = objectValue(sumsubRaw.tax_details);
  const bank = objectValue(sumsubRaw.bank_details);

  const firstName = firstValue([profile.first_name, pickPath(pack, ["info.firstName", "fixedInfo.firstName", "firstName"])], "");
  const lastName = firstValue([profile.last_name, pickPath(pack, ["info.lastName", "fixedInfo.lastName", "lastName"])], "");
  const fullName = `${firstName} ${lastName}`.trim() || firstValue([pickPath(pack, ["fullName", "info.fullName", "fixedInfo.fullName"])]);

  // De-duplicating multi-part address join (mirrors the CRM's composeAddress).
  const composeAddress = (parts: unknown[]): string => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const part of parts) {
      const value = String(part ?? "").trim();
      if (!value || value.toLowerCase() === "n/a") continue;
      const key = value.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(value);
    }
    return out.join("\n");
  };

  const physicalAddress = firstValue([
    pickPath(pack, [
      "info.addresses.0.streetEn", "info.addresses.0.street",
      "info.idDocs.1.address.streetEn", "info.idDocs.1.address.street",
      "fixedInfo.address", "fixedInfo.residentialAddress", "info.address", "info.residentialAddress",
      "address.formattedAddress", "address.fullAddress", "address.street", "address.line1",
      "addresses.residential.formatted", "addresses.residential.fullAddress", "addresses.residential.addressLine", "addresses.residential.street",
      "addresses.0.streetEn", "addresses.0.street", "addresses.0.fullAddress", "addresses.0.formattedAddress", "addresses.0.addressLine",
    ]),
    onboarding.physical_address, onboarding.residential_address, onboarding.address, onboarding.street_address, onboarding.address_line_1, onboarding.address_line1, onboarding.line1,
    profile.address, profile.street_address, profile.address_line_1, profile.address_line1, profile.line1,
    composeAddress([
      onboarding.address_line_2, onboarding.suburb, onboarding.city, onboarding.province, onboarding.postal_code, onboarding.country,
      profile.suburb, profile.city, profile.province, profile.postal_code, profile.country,
    ]),
  ]);

  const postalAddress = firstValue([
    pickPath(pack, [
      "info.addresses.0.formattedAddress", "info.idDocs.1.address.formattedAddress", "info.addresses.0.fullAddress",
      "fixedInfo.postalAddress", "fixedInfo.address", "info.postalAddress", "info.address",
      "addresses.postal.formatted", "addresses.postal.formattedAddress", "addresses.postal.fullAddress", "addresses.postal.addressLine", "addresses.postal.street",
      "addresses.0.formattedAddress", "addresses.0.fullAddress", "addresses.0.addressLine", "address.postalAddress", "address.formattedAddress",
    ]),
    onboarding.postal_address, onboarding.postalAddress, onboarding.postal_line_1, onboarding.postal_line1,
    profile.postal_address, profile.postalAddress, profile.postal_line_1, profile.postal_line1,
    composeAddress([
      onboarding.postal_line_2, onboarding.postal_suburb, onboarding.postal_city, onboarding.postal_province, onboarding.postal_code, onboarding.postal_country,
      profile.postal_suburb, profile.postal_city, profile.postal_province, profile.postal_code, profile.postal_country,
    ]),
  ], physicalAddress);

  const rows: [string, string][] = [
    ["ASSET / FUND MANAGER", firstValue([onboarding.asset_fund_manager, onboarding.company_name, "MINT PLATFORMS (pty) Ltd"])],
    ["ACCOUNT NAME", fullName],
    ["CONTACT NAME", fullName],
    ["IDENTITY / REGISTRATION NUMBER", firstValue([profile.identity_number, profile.id_number, onboarding.id_number, onboarding.identity_number, pickPath(pack, ["info.idNumber", "info.identityNumber", "fixedInfo.idNumber", "fixedInfo.identityNumber", "idNumber"]), mandate.id_number])],
    ["INCOME TAX NUMBER", firstValue([tax.tax_number, sumsubRaw.tax_number, onboarding.tax_number, onboarding.income_tax_number, profile.tax_number, pickPath(pack, ["info.taxId", "fixedInfo.taxId"])])],
    ["PHYSICAL ADDRESS", physicalAddress],
    ["POSTAL ADDRESS", postalAddress],
    ["TEL NO (O/H)", firstValue([onboarding.tel_no, profile.tel_no])],
    ["FAX NO", firstValue([onboarding.fax_no, profile.fax_no])],
    ["CELL NO", firstValue([profile.phone_number, onboarding.phone_number, pickPath(pack, ["phone", "phoneNumber", "info.phone"])])],
    ["E-MAIL", firstValue([profile.email, onboarding.email, pickPath(pack, ["email", "info.email"])])],
    ["BANK ACCOUNT NUMBER", firstValue([onboarding.bank_account_number, profile.bank_account_number, profile.bank_account])],
    ["BRANCH NUMBER", firstValue([onboarding.bank_branch_code, onboarding.branch_code, profile.branch_number])],
    ["BANK NAME", firstValue([onboarding.bank_name, profile.bank_name])],
    ["ACCOUNT NAME", firstValue([onboarding.bank_account_name, profile.bank_account_name, mandate.bank_account_name, mandate.account_name, mandate.account_holder_name, pickPath(pack, ["bankAccountName", "bank_account_name", "accountName", "account_name", "info.bankAccountName", "info.accountName"]), fullName])],
    ["ACCOUNT TYPE", firstValue([bank.bank_account_type, bank.account_type, bank.type, onboarding.bank_account_type, profile.bank_account_type, onboarding.account_type, profile.account_type, mandate.bank_account_type, mandate.account_type, pickPath(pack, ["bankAccountType", "bank_account_type", "accountType", "account_type", "info.bankAccountType", "info.accountType"])])],
  ];

  const doc = existingDoc ?? new jsPDF({ unit: "pt", format: "a4" });
  if (existingDoc) doc.addPage();
  const width = doc.internal.pageSize.getWidth();
  const height = doc.internal.pageSize.getHeight();
  const margin = 38;
  const contentWidth = width - margin * 2;
  const leftWidth = Math.round(contentWidth * 0.34);
  const rightWidth = contentWidth - leftWidth;
  let y = margin + 12;

  // Logo top-right (170×44 JPEG), optional — never block the PDF on it.
  try {
    const logoDataUrl = await loadImageAsDataUrl(COMPUTERSHARE_LOGO_URL);
    if (logoDataUrl) {
      const logoWidth = 170;
      const logoHeight = 44;
      doc.addImage(logoDataUrl, "JPEG", width - margin - logoWidth, y, logoWidth, logoHeight);
    }
  } catch { /* logo optional */ }

  y += 58;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(18);
  doc.text("ACCOUNT DETAILS", width / 2, y + 10, { align: "center" });
  y += 32;

  for (const [label, value] of rows) {
    const labelLines = doc.splitTextToSize(label, leftWidth - 16);
    const valueLines = doc.splitTextToSize(value || "N/A", rightWidth - 16);
    const rowHeight = Math.max(label.includes("ADDRESS") ? 88 : 30, Math.max(labelLines.length, valueLines.length) * 13 + 12);
    if (y + rowHeight > height - margin) { doc.addPage(); y = margin; }
    doc.setDrawColor(17, 17, 17); doc.setLineWidth(1); doc.rect(margin, y, leftWidth, rowHeight); doc.rect(margin + leftWidth, y, rightWidth, rowHeight);
    doc.setFont("helvetica", "normal"); doc.setFontSize(10); doc.text(labelLines, margin + 8, y + 16); doc.setFontSize(11); doc.text(valueLines, margin + leftWidth + 8, y + 16); y += rowHeight;
  }
  return { doc, filename: `computershare-account-creation-${safeFilename(`${firstName}_${lastName}` || String(profile.id || "client"))}.pdf` };
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
