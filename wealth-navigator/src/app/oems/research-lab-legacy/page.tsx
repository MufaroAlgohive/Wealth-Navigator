import { ResearchLabPage as LegacyResearchLabPage } from "@/components/research-lab/research-lab-page";

/**
 * Phase B1 — the legacy session-only Research Lab is preserved here while
 * `/oems/research-lab` carries the new four-tab flow. Kept for reference
 * until the new flow reaches feature parity with the composition editor.
 */
export default function Page() {
  return <LegacyResearchLabPage />;
}
