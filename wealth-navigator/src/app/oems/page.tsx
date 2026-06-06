import { CockpitClient } from "./cockpit-client";

// Server component. The masthead date is computed here on the server and
// passed to the client child as a plain string, so the SSR HTML and the
// CSR hydration see the same characters — no Date() drift, no flash, no
// React hydration-mismatch warning.
//
// We pin the timezone to Africa/Johannesburg to match the rest of the
// desk's time formatting (see lib/format.ts) so the day boundary is
// stable regardless of the host machine's locale.
export default function CockpitPage() {
  const mastheadDate = new Date().toLocaleDateString("en-ZA", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "Africa/Johannesburg",
  });

  return <CockpitClient mastheadDate={mastheadDate} />;
}
