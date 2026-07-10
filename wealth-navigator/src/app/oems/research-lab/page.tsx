import { redirect } from "next/navigation";

/**
 * The legacy Research Lab is superseded by the "Research & IC" section
 * (/oems/research, /oems/rebalance, /oems/committee, /oems/rhythm). Old links
 * and bookmarks land on the new Research Library. The v1 editor is still
 * reachable at /oems/research-lab-legacy.
 */
export default function Page() {
  redirect("/oems/research");
}
