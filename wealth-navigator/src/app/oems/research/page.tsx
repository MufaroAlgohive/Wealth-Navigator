import { ResearchLibraryPage } from "@/components/research-ic/research-library-page";
import { resolveResearchSession } from "@/components/research-ic/server";

export const dynamic = "force-dynamic";

export default async function Page() {
  const s = await resolveResearchSession();
  return <ResearchLibraryPage perms={s.perms} viewerEmail={s.viewerEmail} viewerName={s.viewerName} />;
}
