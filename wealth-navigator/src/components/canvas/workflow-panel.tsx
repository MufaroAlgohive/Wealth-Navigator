"use client";

import { useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Loader2, Plus } from "lucide-react";

import { EmptyDataState } from "@/components/oems/primitives/empty-data-state";
import { PanelSkeleton } from "@/components/oems/primitives/panel-skeleton";
import { Pill } from "@/components/oems/primitives/pill";
import { cn } from "@/lib/cn";

import type { CanvasEdge, CanvasNode } from "./types";
import type { CanvasBuildProposal, ChatsightAskResponse, ChatsightBuildResponse } from "@/lib/chatsight/types";

function buildContextPayload(sym: string, nodes: CanvasNode[], edges: CanvasEdge[]) {
  const notesText = nodes
    .filter((n) => n.type === "notes")
    .map((n) => (n.data.text ?? n.contentText ?? "").trim())
    .filter(Boolean)
    .join("\n\n")
    .trim();
  return {
    symbol: sym,
    nodes: nodes.map((n) => ({
      id: n.id,
      type: n.type,
      title: n.title,
      contentText:
        n.type === "notes" ? (n.data.text ?? n.contentText ?? "") : n.contentText,
    })),
    edges: edges.map((e) => ({ from: e.from, to: e.to })),
    notesText,
  };
}

function evidenceStillLoading(nodes: CanvasNode[]): boolean {
  return nodes.some(
    (n) =>
      n.type !== "engine" &&
      n.type !== "notes" &&
      /loading|not loaded/i.test(n.contentText ?? ""),
  );
}

export function WorkflowPanel({
  sym,
  nodes,
  edges,
  thesisConfigured,
  onAcceptProposal,
  onAddNotesNode,
}: {
  sym: string;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  thesisConfigured: boolean | null;
  onAcceptProposal: (proposal: CanvasBuildProposal) => void;
  onAddNotesNode: () => void;
}) {
  const [mode, setMode] = useState<"ask" | "build">("ask");
  const [text, setText] = useState("");

  const context = useMemo(() => buildContextPayload(sym, nodes, edges), [edges, nodes, sym]);

  const askMutation = useMutation({
    mutationFn: async (): Promise<ChatsightAskResponse> => {
      const r = await fetch("/api/chatsight/ask", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          symbol: sym,
          question: text,
          context,
        }),
      });
      if (!r.ok) throw new Error(`ask ${r.status}`);
      return r.json();
    },
  });

  const buildMutation = useMutation({
    mutationFn: async (): Promise<ChatsightBuildResponse> => {
      const r = await fetch("/api/chatsight/build", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          symbol: sym,
          instruction: text,
          context,
        }),
      });
      if (!r.ok) throw new Error(`build ${r.status}`);
      return r.json();
    },
  });

  const loading = askMutation.isPending || buildMutation.isPending;
  const askResult = askMutation.data;
  const buildResult = buildMutation.data;
  const boardStillLoading = evidenceStillLoading(nodes);

  const configuredEmpty = thesisConfigured === false;
  const configuredLoading = thesisConfigured === null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Dock header */}
      <header className="shrink-0 border-b border-[hsl(var(--glass-border))]/40 px-5 py-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 space-y-0.5">
            <h2 className="text-[15px] font-semibold tracking-tight">Chatsight</h2>
            <p className="text-[11.5px] text-muted-foreground">Ask with canvas context · Build wiring drafts</p>
          </div>
          <button
            type="button"
            onClick={onAddNotesNode}
            className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-xl border border-[hsl(var(--glass-border))]/60 px-3 text-[12px] font-medium text-muted-foreground transition-colors hover:text-foreground"
            title="Add another notes node"
          >
            <Plus className="h-3.5 w-3.5" /> Node
          </button>
        </div>

        {/* Ask / Build segmented control */}
        <div className="mt-4 inline-flex w-full rounded-xl bg-[hsl(var(--foreground)/0.04)] p-1">
          {(["ask", "build"] as const).map((id) => (
            <button
              key={id}
              type="button"
              onClick={() => setMode(id)}
              className={cn(
                "h-9 flex-1 rounded-lg text-[12.5px] font-semibold capitalize transition-all duration-200",
                mode === id
                  ? "bg-[hsl(var(--foreground)/0.1)] text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {id}
            </button>
          ))}
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-5">
        {configuredLoading ? (
          <PanelSkeleton rows={8} />
        ) : configuredEmpty ? (
          <EmptyDataState
            reason="empty"
            badgeLabel="unconfigured"
            title="AI provider not configured"
            message="Ask / Build needs MiniMax (or Anthropic) in this environment."
            hint="Chart and fundamentals nodes still render."
          />
        ) : (
          <>
            <label className="block shrink-0">
              <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                {mode === "ask" ? "Question" : "Change request"}
              </span>
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder={
                  mode === "ask"
                    ? "Summarize what’s on the board for this name — price, fundamentals, technicals, thesis, news."
                    : "Wire Notes → AI thesis and add a “neutral if evidence thin” constraint."
                }
                className="mt-2 h-32 w-full resize-none rounded-xl border-0 bg-[hsl(var(--foreground)/0.035)] p-3.5 text-[13px] leading-relaxed outline-none placeholder:text-muted-foreground/50 focus:bg-[hsl(var(--foreground)/0.05)]"
              />
            </label>

            {mode === "ask" && boardStillLoading ? (
              <p className="text-[11.5px] leading-snug text-muted-foreground">
                Some evidence nodes are still loading. Ask will use whatever is already on the board —
                wait a few seconds for a fuller answer.
              </p>
            ) : null}

            <div className="flex shrink-0 items-center gap-2">
              <button
                type="button"
                disabled={!text.trim().length || loading}
                onClick={() => {
                  if (mode === "ask") askMutation.mutate();
                  else buildMutation.mutate();
                }}
                className="inline-flex h-10 items-center justify-center gap-2 rounded-xl bg-primary px-5 text-[13px] font-semibold text-primary-foreground shadow-[0_2px_12px_hsl(var(--primary)/0.28)] disabled:opacity-45"
              >
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : mode === "ask" ? "Ask" : "Build"}
              </button>

              {mode === "ask" && askMutation.isError ? (
                <span className="text-[12px] text-destructive">
                  {askMutation.error instanceof Error ? askMutation.error.message : "Ask failed"}
                </span>
              ) : null}
            </div>

            {/* Response surface — single calm area, no nested empty stacks */}
            <div className="min-h-0 flex-1 rounded-xl bg-[hsl(var(--foreground)/0.025)] p-4">
              {mode === "ask" ? (
                askMutation.isPending ? (
                  <PanelSkeleton rows={4} />
                ) : askResult && askResult.configured === false ? (
                  <p className="text-[12.5px] text-muted-foreground">{askResult.error ?? "Provider not configured."}</p>
                ) : askResult && askResult.ok ? (
                  <div className="space-y-3">
                    <Pill tone="neutral" size="xs">
                      Answer
                    </Pill>
                    <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-foreground/90">
                      {askResult.answer}
                    </p>
                  </div>
                ) : askResult && !askResult.ok ? (
                  <p className="text-[12.5px] text-destructive">{askResult.error ?? "Ask failed"}</p>
                ) : (
                  <p className="text-[12.5px] leading-relaxed text-muted-foreground/75">
                    Answers are grounded on the current board — chart, fundamentals, technicals, thesis,
                    news, and notes. Buy/sell questions get a compliance refusal plus a full board summary.
                  </p>
                )
              ) : buildMutation.isPending ? (
                <PanelSkeleton rows={5} />
              ) : buildResult && buildResult.configured === false ? (
                <p className="text-[12.5px] text-muted-foreground">{buildResult.error ?? "Provider not configured."}</p>
              ) : buildResult && buildResult.ok && buildResult.proposal ? (
                <div className="space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <Pill tone="neutral" size="xs">
                      Proposal
                    </Pill>
                    <span className="font-mono text-[10px] text-muted-foreground">
                      {buildResult.proposal.operations.length} ops
                    </span>
                  </div>

                  <p className="text-[13px] leading-relaxed text-foreground/85">{buildResult.proposal.summary}</p>

                  <pre className="max-h-48 overflow-auto rounded-lg bg-[hsl(var(--background)/0.4)] p-3 font-mono text-[11px] leading-snug text-muted-foreground">
                    {JSON.stringify(buildResult.proposal, null, 2)}
                  </pre>

                  <div className="flex gap-2 pt-1">
                    <button
                      type="button"
                      className="inline-flex h-10 flex-1 items-center justify-center rounded-xl bg-primary px-3 text-[13px] font-semibold text-primary-foreground disabled:opacity-45"
                      onClick={() => onAcceptProposal(buildResult.proposal!)}
                    >
                      Accept
                    </button>
                    <button
                      type="button"
                      className="inline-flex h-10 flex-1 items-center justify-center rounded-xl border border-[hsl(var(--glass-border))]/60 bg-transparent px-3 text-[13px] font-semibold text-muted-foreground hover:text-foreground"
                      onClick={() => buildMutation.reset()}
                    >
                      Reject
                    </button>
                  </div>
                </div>
              ) : buildResult && !buildResult.ok ? (
                <p className="text-[12.5px] text-destructive">{buildResult.error ?? "Build failed"}</p>
              ) : (
                <p className="text-[12.5px] leading-relaxed text-muted-foreground/75">
                  Describe a wiring change. You’ll get a draft proposal to accept or reject — nothing applies until you accept.
                </p>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
