import { NextResponse } from "next/server";

import type { ChatsightAskRequest, ChatsightAskResponse } from "@/lib/chatsight/types";
import { chatsightAsk } from "@/lib/chatsight/provider";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    const res: ChatsightAskResponse = { ok: false, configured: false, error: "Invalid JSON body" };
    return NextResponse.json(res, { status: 400 });
  }

  const b = body as Partial<ChatsightAskRequest> | null;
  const symbol = typeof b?.symbol === "string" ? b.symbol.trim().toUpperCase() : "";
  const question = typeof b?.question === "string" ? b.question.trim() : "";
  const context = b?.context as ChatsightAskRequest["context"] | undefined;

  if (!symbol) {
    const res: ChatsightAskResponse = { ok: false, configured: false, error: "`symbol` is required" };
    return NextResponse.json(res, { status: 400 });
  }
  if (!question) {
    const res: ChatsightAskResponse = { ok: false, configured: false, error: "`question` is required" };
    return NextResponse.json(res, { status: 400 });
  }
  if (!context || !Array.isArray(context.nodes) || !Array.isArray(context.edges)) {
    return NextResponse.json(
      ({ ok: false, configured: false, error: "`context` must include { nodes: [], edges: [] }" } satisfies ChatsightAskResponse),
      { status: 400 },
    );
  }

  const result = await chatsightAsk({ symbol, question, context });
  return NextResponse.json(result, { status: 200 });
}

