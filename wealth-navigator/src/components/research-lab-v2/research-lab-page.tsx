"use client";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Beaker, ClipboardCheck, Scale, ShieldCheck } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import * as React from "react";

import { GlassBadge, ResearchLabCanvas } from "@/components/oems/primitives/glass";
import { ApprovedNotesView } from "@/components/research-lab-v2/approved-notes-view";
import { IcReviewView } from "@/components/research-lab-v2/ic-review-view";
import { RebalanceBuilder } from "@/components/research-lab-v2/rebalance-builder";
import { ResearchNoteEditor } from "@/components/research-lab-v2/research-note-editor";
import { ResearchNoteList, type ResearchNoteRow } from "@/components/research-lab-v2/research-note-list";

/**
 * Research Lab v2 — Phase B1.
 *
 * Replaces the session-only Research Lab with the four-tab flow Lonwabo
 * walked through: Research | Investment Committee | Rebalance Builder |
 * Approved. Default tab is Research. The legacy `/oems/research-lab/page.tsx`
 * is replaced by this orchestrator and the old page content is preserved
 * at `/oems/research-lab-legacy/page.tsx` for reference.
 */

type TabKey = "research" | "ic" | "rebalance" | "approved";

const TAB_VALUES: TabKey[] = ["research", "ic", "rebalance", "approved"];

function readTabFromQuery(raw: string | null): TabKey {
  if (raw && (TAB_VALUES as string[]).includes(raw)) return raw as TabKey;
  return "research";
}

export function ResearchLabPage() {
  const router = useRouter();
  const params = useSearchParams();
  const [tab, setTab] = React.useState<TabKey>(readTabFromQuery(params.get("tab")));
  const [refreshKey, setRefreshKey] = React.useState<number>(Date.now());

  React.useEffect(() => {
    const t = readTabFromQuery(params.get("tab"));
    if (t !== tab) setTab(t);
  }, [params, tab]);

  const onTabChange = (next: string) => {
    setTab(next as TabKey);
    const sp = new URLSearchParams(params.toString());
    sp.set("tab", next);
    router.replace(`/oems/research-lab?${sp.toString()}`, { scroll: false });
    setRefreshKey(Date.now());
  };

  const [selectedDraft, setSelectedDraft] = React.useState<ResearchNoteRow | null>(null);

  return (
    <ResearchLabCanvas>
      <header className="glass-panel relative overflow-hidden p-6 md:p-8">
        <div className="pointer-events-none absolute -right-20 -top-20 h-56 w-56 rounded-full bg-primary/15 blur-3xl" />
        <div className="relative flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 flex-1 space-y-4">
            <GlassBadge tone="primary">
              <Beaker className="h-3.5 w-3.5" />
              MINT Research Lab
            </GlassBadge>
            <div>
              <h1 className="text-display">Research → IC → Rebalance</h1>
              <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
                Analyst drafts → Investment Committee voting → IC-gated rebalance → executed. The "anyone can
                rebalance" risk is closed here: the Rebalance Builder only renders IC-approved notes.
              </p>
            </div>
          </div>
        </div>
      </header>

      <Tabs value={tab} onValueChange={onTabChange} className="space-y-4">
        <TabsList className="glass-inset h-auto gap-1 p-1">
          <TabsTrigger
            value="research"
            className="rounded-lg px-4 py-2 text-sm font-medium data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=active]:shadow-[0_2px_12px_hsl(var(--primary)/0.35)]"
          >
            <Beaker className="mr-1.5 h-4 w-4" />
            Research
          </TabsTrigger>
          <TabsTrigger
            value="ic"
            className="rounded-lg px-4 py-2 text-sm font-medium data-[state=active]:bg-primary data-[state=active]:text-primary-foreground"
          >
            <Scale className="mr-1.5 h-4 w-4" />
            Investment Committee
          </TabsTrigger>
          <TabsTrigger
            value="rebalance"
            className="rounded-lg px-4 py-2 text-sm font-medium data-[state=active]:bg-primary data-[state=active]:text-primary-foreground"
          >
            <ClipboardCheck className="mr-1.5 h-4 w-4" />
            Rebalance Builder
          </TabsTrigger>
          <TabsTrigger
            value="approved"
            className="rounded-lg px-4 py-2 text-sm font-medium data-[state=active]:bg-primary data-[state=active]:text-primary-foreground"
          >
            <ShieldCheck className="mr-1.5 h-4 w-4" />
            Approved
          </TabsTrigger>
        </TabsList>

        <TabsContent value="research" className="mt-0 space-y-4">
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-[420px_1fr]">
            <ResearchNoteList
              status="draft"
              title="Drafts"
              emptyMessage="No drafts in flight. Open the editor to start a new note."
              onSelect={(n) => setSelectedDraft(n)}
              selectedId={selectedDraft?.id}
              refreshKey={refreshKey}
            />
            <ResearchNoteEditor
              initialNote={selectedDraft ?? undefined}
              onNoteChange={() => {
                // The editor manages its own save lifecycle; no-op here.
              }}
            />
          </div>
        </TabsContent>

        <TabsContent value="ic" className="mt-0">
          <IcReviewView refreshKey={refreshKey} />
        </TabsContent>

        <TabsContent value="rebalance" className="mt-0">
          <RebalanceBuilder refreshKey={refreshKey} />
        </TabsContent>

        <TabsContent value="approved" className="mt-0">
          <ApprovedNotesView refreshKey={refreshKey} />
        </TabsContent>
      </Tabs>
    </ResearchLabCanvas>
  );
}
