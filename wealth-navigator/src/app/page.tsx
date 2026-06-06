import { redirect } from "next/navigation";

/**
 * The OEMS desk is the front door. The marketing landing page is gone;
 * this server component is a thin redirect so `/` always resolves to a
 * useful surface. The middleware does the real work of deciding whether
 * the user lands at `/login` (unauthenticated) or `/oems` (signed in).
 */
export default function Home() {
  redirect("/oems");
}
