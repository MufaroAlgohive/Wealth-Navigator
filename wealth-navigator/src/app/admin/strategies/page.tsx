import { redirect } from "next/navigation";
import type { Route } from "next";

/** Merged into the unified Strategies page (Builder tab). */
export default function AdminStrategiesRedirect() {
  redirect("/strategies?tab=builder" as Route);
}
