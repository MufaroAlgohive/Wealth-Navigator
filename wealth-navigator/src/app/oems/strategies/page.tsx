import { redirect } from "next/navigation";
import type { Route } from "next";

/**
 * Merged into the unified Strategies page (Mandates tab). Kept as a redirect so
 * existing deep-links (e.g. command-palette `?focus=<id>`) keep working.
 */
export default async function OemsStrategiesRedirect({
  searchParams,
}: {
  searchParams: Promise<{ focus?: string }>;
}) {
  const { focus } = await searchParams;
  redirect(
    (focus ? `/strategies?tab=mandates&focus=${encodeURIComponent(focus)}` : "/strategies") as Route,
  );
}
