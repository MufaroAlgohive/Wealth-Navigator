// Health check / adapter info — useful for ops and for the Integration page.
import { iressConfig } from "@/lib/iress";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json({
    status: "ok",
    iress: {
      mode: iressConfig.mode,
      baseUrl: iressConfig.baseUrl,
      methods: iressConfig.methods,
    },
    ts: Date.now(),
  });
}
