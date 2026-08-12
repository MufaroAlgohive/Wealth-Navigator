import { ResearchLibraryPage } from "@/components/research-ic/research-library-page";
import { resolveResearchSession } from "@/components/research-ic/server";
import { Suspense } from "react";

export const dynamic = "force-dynamic";

export default async function Page() {
  const s = await resolveResearchSession();
  return (
    <Suspense fallback={<div className="p-6 text-sm text-muted-foreground">Loading research library…</div>}>
      <ResearchLibraryPage perms={s.perms} viewerEmail={s.viewerEmail} viewerName={s.viewerName} canSeeUat={s.canSeeUat} />
    </Suspense>
  );
}
