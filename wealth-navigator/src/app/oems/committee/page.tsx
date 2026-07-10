import { InvestmentCommitteePage } from "@/components/research-ic/investment-committee-page";
import { resolveResearchSession } from "@/components/research-ic/server";

export const dynamic = "force-dynamic";

export default async function Page() {
  const s = await resolveResearchSession();
  return <InvestmentCommitteePage perms={s.perms} viewerEmail={s.viewerEmail} viewerName={s.viewerName} />;
}
