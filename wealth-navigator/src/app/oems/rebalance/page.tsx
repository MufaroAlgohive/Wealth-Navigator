import { RebalanceBuilderPage } from "@/components/research-ic/rebalance-builder-page";
import { resolveResearchSession } from "@/components/research-ic/server";

export const dynamic = "force-dynamic";

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ strategy?: string; name?: string }>;
}) {
  const s = await resolveResearchSession();
  const sp = await searchParams;
  return (
    <RebalanceBuilderPage
      perms={s.perms}
      viewerEmail={s.viewerEmail}
      initialStrategyId={sp.strategy}
      initialStrategyName={sp.name}
    />
  );
}
