import { RebalanceBuilderPage } from "@/components/research-ic/rebalance-builder-page";
import { resolveResearchSession } from "@/components/research-ic/server";

export const dynamic = "force-dynamic";

export default async function Page() {
  const s = await resolveResearchSession();
  return <RebalanceBuilderPage perms={s.perms} viewerEmail={s.viewerEmail} />;
}
