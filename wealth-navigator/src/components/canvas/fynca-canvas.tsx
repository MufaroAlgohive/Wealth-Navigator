"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Users } from "lucide-react";

import type { CompanyAnalysis } from "@/lib/company-analysis/yahoo";
import { computeMomentum, computeRsi } from "@/lib/canvas/indicators";
import type { AiResearchResponse } from "@/lib/research-ai/provider";
import { queryOpts } from "@/lib/store/query-provider";
import { cn } from "@/lib/cn";
import { useCanvasPresence } from "@/hooks/use-canvas-presence";
import { DataSourceBadge } from "@/components/oems/primitives/data-source-badge";

import type { CanvasBoardSettings, CanvasEdge, CanvasNode } from "./types";
import { DEFAULT_BOARD_SETTINGS } from "./types";
import { GraphCanvas } from "./graph-canvas";
import { WorkflowPanel } from "./workflow-panel";

import type { CanvasNodeType } from "@/lib/chatsight/types";

interface ChartSummaryResp {
  ok: boolean;
  symbol: string;
  currency: string;
  range: string;
  points: Array<{ t: number; c: number }>;
  firstClose: number | null;
  lastClose: number | null;
  changePct: number | null;
  cagrPct: number | null;
  source?: "iress" | "yahoo";
  error?: string;
}

interface NewsSummaryResp {
  ok: boolean;
  items: Array<{ title: string; publisher: string | null }>;
  detail?: string;
  error?: string;
}

function asPct(v: number | null, dp = 1) {
  if (v == null || !Number.isFinite(v)) return "—";
  const sign = v >= 0 ? "+" : "";
  return `${sign}${v.toFixed(dp)}%`;
}

function formatMoney(v: number | null, currency: string) {
  if (v == null || !Number.isFinite(v)) return "—";
  const sym = currency === "ZAR" ? "R" : currency === "USD" ? "$" : `${currency} `;
  const abs = Math.abs(v);
  const dp = abs >= 1e6 ? 1 : abs >= 1e3 ? 0 : 2;
  return `${sym}${v.toLocaleString("en-US", { maximumFractionDigits: dp })}`;
}

function ccySym(code: string): string {
  switch (code?.toUpperCase()) {
    case "USD":
      return "$";
    case "ZAR":
    case "ZAC":
      return "R";
    default:
      return code ? `${code} ` : "";
  }
}

function formatAnalysisMetric(m: CompanyAnalysis["groups"][string][string]) {
  if (m.value == null || !Number.isFinite(m.value)) return "—";

  switch (m.fmt) {
    case "pct":
      return `${(m.value * 100).toFixed(1)}%`;
    case "pct100":
      return `${m.value.toFixed(1)}%`;
    case "money":
      return formatMoney(m.value, "USD");
    case "int":
      return Math.round(m.value).toLocaleString("en-US");
    case "x":
    case "ratio":
      return `${m.value.toFixed(2)}x`;
    case "price":
      return `${m.value.toFixed(2)}`;
    default:
      return String(m.value);
  }
}

function summarizeChart(d: ChartSummaryResp | undefined) {
  if (!d || !d.ok) return "Chart evidence: not loaded (no price history yet).";
  if (d.lastClose == null) return `Chart evidence: ${d.error ?? "no last close"}.`;
  const src = d.source === "iress" ? "IRESS" : d.source === "yahoo" ? "Yahoo" : "unknown";
  return [
    `Chart evidence (range=${d.range}, source=${src}):`,
    `- lastClose=${d.lastClose}`,
    `- changePct=${asPct(d.changePct)}`,
    `- cagrPct=${d.cagrPct == null ? "—" : asPct(d.cagrPct)}`,
    `- closes=${d.points?.length ?? 0}`,
  ].join("\n");
}

function summarizeFundamentals(d: CompanyAnalysis | undefined) {
  if (!d) return "Fundamentals evidence: not loaded.";
  if (!d.ok) return `Fundamentals evidence unavailable: ${d.error ?? "—"}`;

  const overview = d.overview;
  const profile = d.groups.Profile ?? {};
  const margins = d.groups.Margins ?? {};
  const returns = d.groups.Returns ?? {};
  const valuationTtm = d.groups["Valuation (TTM)"] ?? {};
  const growth = d.groups["Growth (CAGR)"] ?? {};
  const dividends = d.groups.Dividends ?? {};

  const lines = [
    `Fundamentals evidence:`,
    `- name=${overview.name ?? d.symbol}`,
    `- sector=${overview.sector ?? "—"}`,
    `- industry=${overview.industry ?? "—"}`,
    `- CEO=${overview.ceo ?? "—"}`,
    "",
    `Key snapshot:`,
    `- Market Cap=${profile["Market Cap"] ? formatAnalysisMetric(profile["Market Cap"]) : "—"}`,
    `- EV=${profile["EV"] ? formatAnalysisMetric(profile["EV"]) : "—"}`,
    `- Gross margin=${margins["Gross"] ? formatAnalysisMetric(margins["Gross"]) : "—"}`,
    `- EBITDA margin=${margins["EBITDA"] ? formatAnalysisMetric(margins["EBITDA"]) : "—"}`,
    `- ROE=${returns["ROE"] ? formatAnalysisMetric(returns["ROE"]) : "—"}`,
    `- P/E=${valuationTtm["P/E"] ? formatAnalysisMetric(valuationTtm["P/E"]) : "—"}`,
    `- Rev 3Yr CAGR=${growth["Rev 3Yr"] ? formatAnalysisMetric(growth["Rev 3Yr"]) : "—"}`,
    `- Dil EPS 3Yr CAGR=${growth["Dil EPS 3Yr"] ? formatAnalysisMetric(growth["Dil EPS 3Yr"]) : "—"}`,
    `- Dividend Yield=${dividends["Yield"] ? formatAnalysisMetric(dividends["Yield"]) : "—"}`,
    "",
    d.notes?.length ? `Notes: ${d.notes.slice(0, 4).join(" | ")}` : "",
  ].filter(Boolean);

  return lines.join("\n");
}

function summarizeThesis(d: AiResearchResponse | undefined) {
  if (!d) return "AI thesis evidence: not loaded.";
  if (!d.configured) return "AI thesis evidence deferred (provider not configured).";
  if (!d.outlook) return `AI thesis evidence unavailable: ${d.error ?? "—"}`;

  const o = d.outlook;
  return [
    `AI thesis evidence:`,
    `- summary: ${o.summary}`,
    `- shortTerm (0–3m): call=${o.shortTerm.call} confidence=${o.shortTerm.confidence}`,
    `  rationale: ${o.shortTerm.rationale}`,
    `- mediumTerm (3–12m): call=${o.mediumTerm.call} confidence=${o.mediumTerm.confidence}`,
    `  rationale: ${o.mediumTerm.rationale}`,
    `- longTerm (1–3y): call=${o.longTerm.call} confidence=${o.longTerm.confidence}`,
    `  rationale: ${o.longTerm.rationale}`,
    `- risks:`,
    ...(o.risks.length ? o.risks.map((r) => `  - ${r}`) : ["  - —"]),
  ].join("\n");
}

function summarizeTechnicals(d: ChartSummaryResp | undefined) {
  if (!d || !d.ok) return "Technicals: chart closes not loaded.";
  const closes = d.points.map((p) => p.c).filter((c) => Number.isFinite(c));
  const rsi = computeRsi(closes, 14);
  const mom20 = computeMomentum(closes, 20);
  const mom60 = computeMomentum(closes, 60);
  const src = d.source === "iress" ? "IRESS" : d.source === "yahoo" ? "Yahoo" : "unknown";
  if (rsi == null) {
    return `Technicals: not enough closes for RSI(14) (got ${closes.length} from ${src}).`;
  }
  return [
    `Technicals (derived from ${closes.length} real ${src} closes):`,
    `- RSI(14)=${rsi.toFixed(1)}`,
    `- momentum20d=${mom20 == null ? "—" : asPct(mom20)}`,
    `- momentum60d=${mom60 == null ? "—" : asPct(mom60)}`,
  ].join("\n");
}

function summarizeNews(d: NewsSummaryResp | undefined) {
  if (!d) return "News evidence: not loaded.";
  if (!d.items?.length) return `News evidence empty: ${d.detail ?? d.error ?? "no headlines"}`;
  return [
    `News headlines (Yahoo, ${d.items.length} item(s)):`,
    ...d.items.slice(0, 6).map((it) => `- ${it.title}${it.publisher ? ` (${it.publisher})` : ""}`),
  ].join("\n");
}

function makeStarterNodes({ sym }: { sym: string }): { nodes: CanvasNode[]; edges: CanvasEdge[] } {
  const techEngine: CanvasNode = {
    id: "node_engine_tech",
    type: "engine",
    title: "Technical Engine",
    x: 48,
    y: 56,
    contentText:
      "Structural hub: wires Price history + Technicals (RSI/MOM from real /chart closes — IRESS or Yahoo).",
    data: {},
  };

  const chart: CanvasNode = {
    id: "node_chart",
    type: "chart",
    title: "Price history",
    x: 360,
    y: 40,
    contentText: `Chart evidence for ${sym} (loading…)`,
    data: {},
  };

  const technicals: CanvasNode = {
    id: "node_technicals",
    type: "technicals",
    title: "Technicals",
    x: 360,
    y: 440,
    contentText: `Technicals for ${sym} (loading…)`,
    data: {},
  };

  const fundEngine: CanvasNode = {
    id: "node_engine_fund",
    type: "engine",
    title: "Fundamental Engine",
    x: 860,
    y: 56,
    contentText:
      "Structural hub: wires Fundamentals (Yahoo company-analysis) + AI thesis (research-ai).",
    data: {},
  };

  const fundamentals: CanvasNode = {
    id: "node_fundamentals",
    type: "fundamentals",
    title: "Fundamentals",
    x: 1170,
    y: 40,
    contentText: `Fundamentals evidence for ${sym} (loading…)`,
    data: {},
  };

  const thesis: CanvasNode = {
    id: "node_thesis",
    type: "thesis",
    title: "AI thesis",
    x: 1170,
    y: 440,
    contentText: `AI thesis for ${sym} (loading…)`,
    data: {},
  };

  const newsEngine: CanvasNode = {
    id: "node_engine_news",
    type: "engine",
    title: "News Engine",
    x: 48,
    y: 760,
    contentText:
      "Structural hub: wires News (Yahoo headlines) + Notes (analyst input for Ask/Build).",
    data: {},
  };

  const news: CanvasNode = {
    id: "node_news",
    type: "news",
    title: "News",
    x: 360,
    y: 740,
    contentText: `News for ${sym} (loading…)`,
    data: {},
  };

  const notes: CanvasNode = {
    id: "node_notes_0",
    type: "notes",
    title: "Notes",
    x: 760,
    y: 740,
    contentText: "",
    data: { text: "" },
  };

  const edges: CanvasEdge[] = [
    { id: "edge_tech_engine_chart", from: techEngine.id, to: chart.id },
    { id: "edge_tech_engine_tech", from: techEngine.id, to: technicals.id },
    { id: "edge_fund_engine_funds", from: fundEngine.id, to: fundamentals.id },
    { id: "edge_fund_engine_thesis", from: fundEngine.id, to: thesis.id },
    { id: "edge_chart_to_thesis", from: chart.id, to: thesis.id },
    { id: "edge_news_engine_news", from: newsEngine.id, to: news.id },
    { id: "edge_news_engine_notes", from: newsEngine.id, to: notes.id },
    { id: "edge_notes_to_thesis", from: notes.id, to: thesis.id },
  ];

  return {
    nodes: [techEngine, chart, technicals, fundEngine, fundamentals, thesis, newsEngine, news, notes],
    edges,
  };
}

function PriceHeaderStrip({
  sym,
  chart,
  fundamentals,
}: {
  sym: string;
  chart: ChartSummaryResp | undefined;
  fundamentals: CompanyAnalysis | undefined;
}) {
  const up = (chart?.changePct ?? 0) >= 0;
  const name = fundamentals?.overview?.name ?? sym;
  const price = chart?.lastClose;
  const ccy = ccySym(chart?.currency ?? fundamentals?.currency ?? "USD");
  const source =
    chart?.ok && chart.lastClose != null
      ? chart.source === "iress"
        ? ("iress" as const)
        : ("yahoo" as const)
      : ("unavailable" as const);

  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-xl border border-[hsl(var(--glass-border))]/40 bg-[hsl(var(--background)/0.45)] px-4 py-2.5 backdrop-blur-sm">
      <div className="min-w-0">
        <p className="truncate text-[13px] font-semibold tracking-tight">{name}</p>
        <p className="font-mono text-[10.5px] uppercase tracking-wider text-muted-foreground">{sym}</p>
      </div>
      <div className="flex items-baseline gap-2.5">
        <span className="font-mono text-xl font-semibold tabular-nums tracking-tight">
          {price != null
            ? `${ccy}${price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
            : "—"}
        </span>
        <span
          className={cn(
            "font-mono text-[12px] font-medium tabular-nums",
            chart?.changePct == null ? "text-muted-foreground" : up ? "text-up" : "text-down",
          )}
        >
          {asPct(chart?.changePct ?? null)}
        </span>
        <span className="text-[10.5px] text-muted-foreground/70">5Y range</span>
        <DataSourceBadge source={source} />
      </div>
      {fundamentals?.overview?.sector ? (
        <span className="ml-auto truncate text-[11px] text-muted-foreground">
          {[fundamentals.overview.sector, fundamentals.overview.industry].filter(Boolean).join(" · ")}
        </span>
      ) : null}
    </div>
  );
}

export function FyncaCanvas({ sym, boardId }: { sym: string; boardId?: string }) {
  const [refreshKey, setRefreshKey] = useState(0);
  const [nodeCounter, setNodeCounter] = useState(1);
  const [settings, setSettings] = useState<CanvasBoardSettings>({ ...DEFAULT_BOARD_SETTINGS });
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  const canvasId = boardId?.trim() || `sym-${sym.toLowerCase()}`;

  const presence = useCanvasPresence(canvasId, true);

  const chartQ = useQuery<ChartSummaryResp>({
    queryKey: ["canvas-chart", sym],
    queryFn: async () => {
      const r = await fetch(`/api/company-analysis/${encodeURIComponent(sym)}/chart?range=5Y`, {
        cache: "no-store",
      });
      if (!r.ok) throw new Error(`chart ${r.status}`);
      return r.json();
    },
    ...queryOpts("reference"),
    enabled: Boolean(sym),
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    retry: false,
  });

  const chart1yQ = useQuery<ChartSummaryResp>({
    queryKey: ["canvas-chart-1y", sym],
    queryFn: async () => {
      const r = await fetch(`/api/company-analysis/${encodeURIComponent(sym)}/chart?range=1Y`, {
        cache: "no-store",
      });
      if (!r.ok) throw new Error(`chart ${r.status}`);
      return r.json();
    },
    ...queryOpts("reference"),
    enabled: Boolean(sym),
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    retry: false,
  });

  const fundamentalsQ = useQuery<CompanyAnalysis>({
    queryKey: ["canvas-fundamentals", sym],
    queryFn: async () => {
      const r = await fetch(`/api/company-analysis/${encodeURIComponent(sym)}`, { cache: "no-store" });
      if (!r.ok) throw new Error(`company-analysis ${r.status}`);
      return r.json();
    },
    ...queryOpts("reference"),
    enabled: Boolean(sym),
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    retry: false,
  });

  const thesisQ = useQuery<AiResearchResponse>({
    queryKey: ["canvas-thesis", sym, refreshKey],
    queryFn: async () => {
      const r = await fetch(
        `/api/research-ai?symbol=${encodeURIComponent(sym)}${refreshKey > 0 ? "&refresh=1" : ""}`,
        { cache: "no-store" },
      );
      if (!r.ok) throw new Error(`research-ai ${r.status}`);
      return r.json();
    },
    ...queryOpts("reference"),
    enabled: Boolean(sym),
    staleTime: Infinity,
    gcTime: 30 * 60_000,
    refetchOnWindowFocus: false,
    retry: false,
  });

  const newsQ = useQuery<NewsSummaryResp>({
    queryKey: ["canvas-news-summary", sym, fundamentalsQ.data?.overview?.name ?? ""],
    queryFn: async () => {
      const name = fundamentalsQ.data?.overview?.name?.trim();
      const qs = name ? `?q=${encodeURIComponent(name)}` : "";
      const r = await fetch(`/api/company-analysis/${encodeURIComponent(sym)}/news${qs}`, {
        cache: "no-store",
      });
      if (!r.ok) throw new Error(`news ${r.status}`);
      return r.json();
    },
    ...queryOpts("reference"),
    enabled: Boolean(sym),
    staleTime: 10 * 60_000,
    refetchOnWindowFocus: false,
    retry: false,
  });

  const [nodes, setNodes] = useState<CanvasNode[]>([]);
  const [edges, setEdges] = useState<CanvasEdge[]>([]);

  const resetStarter = useCallback(() => {
    const { nodes: starterNodes, edges: starterEdges } = makeStarterNodes({ sym });
    setNodes(starterNodes);
    setEdges(starterEdges);
    setNodeCounter(1);
    setSelectedNodeId(null);
  }, [sym]);

  useEffect(() => {
    resetStarter();
  }, [resetStarter]);

  useEffect(() => {
    const chartText = summarizeChart(chartQ.data);
    setNodes((prev) => prev.map((n) => (n.type === "chart" ? { ...n, contentText: chartText } : n)));
  }, [chartQ.data]);

  useEffect(() => {
    const fundText = summarizeFundamentals(fundamentalsQ.data);
    setNodes((prev) =>
      prev.map((n) => (n.type === "fundamentals" ? { ...n, contentText: fundText } : n)),
    );
  }, [fundamentalsQ.data]);

  useEffect(() => {
    const thesisText = summarizeThesis(thesisQ.data);
    setNodes((prev) => prev.map((n) => (n.type === "thesis" ? { ...n, contentText: thesisText } : n)));
  }, [thesisQ.data]);

  useEffect(() => {
    const techText = summarizeTechnicals(chart1yQ.data);
    setNodes((prev) =>
      prev.map((n) => (n.type === "technicals" ? { ...n, contentText: techText } : n)),
    );
  }, [chart1yQ.data]);

  useEffect(() => {
    const newsText = summarizeNews(newsQ.data);
    setNodes((prev) => prev.map((n) => (n.type === "news" ? { ...n, contentText: newsText } : n)));
  }, [newsQ.data]);

  const { onRemoteNodeMove, publishCursor, publishNodeMove } = presence;

  // Apply remote node moves (broadcast from peers)
  useEffect(() => {
    return onRemoteNodeMove((nodeId, x, y) => {
      setNodes((prev) => prev.map((n) => (n.id === nodeId ? { ...n, x, y } : n)));
    });
  }, [onRemoteNodeMove]);

  const onCursorMove = useCallback(
    (x: number, y: number) => {
      publishCursor(x, y, selectedNodeId);
    },
    [publishCursor, selectedNodeId],
  );

  const onNodeDragEnd = useCallback(
    (nodeId: string, x: number, y: number) => {
      publishNodeMove(nodeId, x, y);
    },
    [publishNodeMove],
  );

  const thesisConfigured = thesisQ.isLoading ? null : Boolean(thesisQ.data?.configured);

  const onlineCount = presence.peers.length + (presence.available ? 1 : 0);

  const onAddNotesNode = () => {
    const id = `node_notes_${nodeCounter}`;
    setNodeCounter((c) => c + 1);

    const existingNotes = nodes.filter((n) => n.type === "notes");
    const idx = existingNotes.length;
    const x = 760 + (idx % 3) * 36;
    const y = 740 + Math.floor(idx / 3) * 36;

    const newNode: CanvasNode = {
      id,
      type: "notes",
      title: "Notes",
      x,
      y,
      contentText: "",
      data: { text: "" },
    };

    setNodes((prev) => [...prev, newNode]);
    setEdges((prev) => [...prev, { id: `edge_${id}_to_thesis`, from: id, to: "node_thesis" }]);
  };

  const onAcceptProposal = (proposal: {
    operations?: Array<Record<string, unknown>>;
  }) => {
    const operations = Array.isArray(proposal?.operations) ? proposal.operations : [];

    const nextNodes = [...nodes];
    const nextEdges = [...edges];

    const hasNode = (id: string) => nextNodes.some((n) => n.id === id);

    for (const op of operations) {
      if (!op || typeof op !== "object") continue;
      const type = op.type;

      if (type === "add_node") {
        const node = op.node as
          | {
              id?: string;
              type?: CanvasNodeType;
              title?: string;
              contentText?: string;
              position?: { x?: number; y?: number };
            }
          | undefined;
        if (!node?.id || hasNode(node.id)) continue;
        const newNode: CanvasNode = {
          id: String(node.id),
          type: (node.type ?? "notes") as CanvasNodeType,
          title: String(node.title ?? "Notes / prompt"),
          x: typeof node.position?.x === "number" ? node.position.x : 760,
          y: typeof node.position?.y === "number" ? node.position.y : 740,
          contentText: String(node.contentText ?? ""),
          data: { text: String(node.contentText ?? "") },
        };
        nextNodes.push(newNode);
      }

      if (type === "update_node") {
        const id = String(op.id ?? "");
        const idx = nextNodes.findIndex((n) => n.id === id);
        if (idx === -1) continue;
        const current = nextNodes[idx];
        if (!current) continue;
        const patch = (op.patch ?? {}) as { title?: string; contentText?: string };
        const title = typeof patch.title === "string" ? patch.title : undefined;
        const contentText = typeof patch.contentText === "string" ? patch.contentText : undefined;
        if (title != null || contentText != null) {
          nextNodes[idx] = {
            ...current,
            ...(title != null ? { title } : {}),
            ...(contentText != null ? { contentText } : {}),
            data:
              contentText != null && current.type === "notes"
                ? { ...current.data, text: contentText }
                : current.data,
          };
        }
      }

      if (type === "add_edge") {
        const from = String(op.from ?? "");
        const to = String(op.to ?? "");
        if (!from || !to) continue;
        if (!hasNode(from) || !hasNode(to)) continue;
        const already = nextEdges.some((e) => e.from === from && e.to === to);
        if (already) continue;
        nextEdges.push({
          id: `edge_${from}_to_${to}_${nextEdges.length}`,
          from,
          to,
        });
      }

      if (type === "remove_edge") {
        const from = String(op.from ?? "");
        const to = String(op.to ?? "");
        if (!from || !to) continue;
        const filtered = nextEdges.filter((e) => !(e.from === from && e.to === to));
        nextEdges.splice(0, nextEdges.length, ...filtered);
      }
    }

    setNodes(nextNodes);
    setEdges(nextEdges);
  };

  const presenceHint = useMemo(() => {
    if (!presence.ready) return "Connecting…";
    if (!presence.available) return "Presence offline (Supabase env missing)";
    return `${onlineCount} online · ${presence.self.name}`;
  }, [onlineCount, presence.available, presence.ready, presence.self.name]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <PriceHeaderStrip sym={sym} chart={chartQ.data} fundamentals={fundamentalsQ.data} />
        <div
          className={cn(
            "inline-flex h-9 items-center gap-2 rounded-xl border border-[hsl(var(--glass-border))]/50",
            "bg-[hsl(var(--background)/0.55)] px-3 text-[11px] text-muted-foreground backdrop-blur-sm",
          )}
          title={
            presence.available
              ? "Live cursors via Supabase Realtime. Graph edits stay local for now (node moves broadcast)."
              : "Set NEXT_PUBLIC_SUPABASE_URL + ANON_KEY for live presence."
          }
        >
          <Users className="h-3.5 w-3.5" />
          <span className={cn(presence.available && "text-foreground/85")}>{presenceHint}</span>
          {presence.peers.length > 0 ? (
            <span className="flex -space-x-1.5">
              {presence.peers.slice(0, 4).map((p) => (
                <span
                  key={p.clientId}
                  className="inline-block h-2.5 w-2.5 rounded-full ring-2 ring-[hsl(var(--background))]"
                  style={{ backgroundColor: p.color }}
                  title={p.name}
                />
              ))}
            </span>
          ) : null}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_480px]">
        <div className="min-w-0">
          <GraphCanvas
            sym={sym}
            nodes={nodes}
            edges={edges}
            onNodesChange={setNodes}
            settings={settings}
            onSettingsChange={setSettings}
            onResetLayout={resetStarter}
            remoteCursors={presence.remoteCursors}
            onCursorMove={onCursorMove}
            onNodeDragEnd={onNodeDragEnd}
            selectedNodeId={selectedNodeId}
            onSelectNode={setSelectedNodeId}
          />
        </div>

        <aside className="flex min-h-0 min-w-0 flex-col gap-3">
          <div className="flex min-h-[70vh] h-[min(78vh,860px)] flex-col overflow-hidden rounded-2xl border border-[hsl(var(--glass-border))]/40 bg-[hsl(var(--background)/0.55)] backdrop-blur-md">
            <WorkflowPanel
              sym={sym}
              nodes={nodes}
              edges={edges}
              thesisConfigured={thesisConfigured}
              onAcceptProposal={onAcceptProposal}
              onAddNotesNode={onAddNotesNode}
            />
          </div>

          <div className="flex items-center justify-between gap-3 px-1">
            <button
              type="button"
              className="h-8 rounded-lg border border-[hsl(var(--glass-border))]/60 px-3 text-[11px] font-mono text-muted-foreground transition-colors hover:text-foreground"
              onClick={() => setRefreshKey((k) => k + 1)}
              disabled={!sym || thesisQ.isFetching}
              title="Force refresh AI thesis evidence"
            >
              {thesisQ.isFetching ? "Refreshing AI…" : "Refresh thesis"}
            </button>
            <span className="text-[10px] text-muted-foreground/55">Draft-only · Accept to apply.</span>
          </div>
        </aside>
      </div>
    </div>
  );
}
