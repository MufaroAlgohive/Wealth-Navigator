"use client";

import { FilePlus2, Plus, Save, Send, Trash2 } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";

import { GlassBadge, GlassSection } from "@/components/oems/primitives/glass";
import { PanelSkeleton } from "@/components/oems/primitives/panel-skeleton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/cn";
import { queryOpts } from "@/lib/store/query-provider";
import { useQuery, useQueryClient } from "@tanstack/react-query";

/**
 * ResearchNoteEditor — Phase B1 analyst draft form.
 *
 * Owns the full shape of a research note (bull/bear, risks, catalysts,
 * ratios, numericals, valuation, triggers, likes/dislikes on management).
 * Save Draft persists to /api/research/notes (status='draft'); Submit to IC
 * walks draft → in_review → ic_pending via the transition endpoint.
 *
 * Lonwabo to specify the canonical key-ratio list. Defaults (P/E, P/B, ROE,
 * Dividend Yield, Debt/Equity) ship until he confirms.
 */

interface EquityUniverse {
  symbol: string;
  name: string | null;
}

interface NoteRecord {
  id: string;
  symbol: string;
  author_email: string;
  status: string;
  thesis: unknown;
  triggers: unknown | null;
  valuation: unknown | null;
  ic_session_id: string | null;
  created_at: string;
  updated_at: string;
  submitted_at: string | null;
  approved_at: string | null;
}

interface TriggerShape {
  sell_above: number | null;
  review_at: number | null;
  stop_loss: number | null;
}

interface ValuationShape {
  pe_multiple?: number | null;
  override?: boolean;
}

interface NumericShape {
  label: string;
  prior: number | null;
  current: number | null;
  forecast: number | null;
}

interface ThesisShape {
  bull?: string;
  bear?: string;
  risks?: string[];
  catalysts?: string[];
  key_ratios?: { label: string; value: string }[];
  key_numericals?: NumericShape[];
  likes_management?: string;
  dislikes_management?: string;
  proposed_composition?: Array<{
    symbol?: string;
    action?: "remove" | "decrease" | "increase" | "add" | "hold";
    shares?: number;
    weight?: number;
  }>;
  rating?: "hold" | "accumulate" | "buy";
  rationale?: string;
}

const DEFAULT_NUMERICALS: NumericShape[] = [
  { label: "Revenue (R m)", prior: null, current: null, forecast: null },
  { label: "EPS (cents)", prior: null, current: null, forecast: null },
  { label: "FCF (R m)", prior: null, current: null, forecast: null },
];

const DEFAULT_RATIOS = [
  { label: "P/E", value: "" },
  { label: "P/B", value: "" },
  { label: "ROE", value: "" },
  { label: "Dividend Yield", value: "" },
  { label: "Debt/Equity", value: "" },
];

const DEFAULT_TRIGGERS: TriggerShape = { sell_above: null, review_at: null, stop_loss: null };
const DEFAULT_VALUATION: ValuationShape = { pe_multiple: null, override: false };

function emptyNote(): NoteRecord {
  const now = new Date().toISOString();
  return {
    id: "",
    symbol: "",
    author_email: "",
    status: "draft",
    thesis: {
      bull: "",
      bear: "",
      risks: [],
      catalysts: [],
      key_ratios: DEFAULT_RATIOS.map((r) => ({ ...r })),
      key_numericals: DEFAULT_NUMERICALS.map((n) => ({ ...n })),
      likes_management: "",
      dislikes_management: "",
    } satisfies ThesisShape,
    triggers: { ...DEFAULT_TRIGGERS },
    valuation: { ...DEFAULT_VALUATION },
    ic_session_id: null,
    created_at: now,
    updated_at: now,
    submitted_at: null,
    approved_at: null,
  };
}

function asThesis(input: unknown): ThesisShape {
  const t = (input ?? {}) as ThesisShape;
  return {
    bull: typeof t.bull === "string" ? t.bull : "",
    bear: typeof t.bear === "string" ? t.bear : "",
    risks: Array.isArray(t.risks) ? t.risks.filter((r) => typeof r === "string") : [],
    catalysts: Array.isArray(t.catalysts) ? t.catalysts.filter((c) => typeof c === "string") : [],
    key_ratios:
      Array.isArray(t.key_ratios) && t.key_ratios.length > 0
        ? t.key_ratios
        : DEFAULT_RATIOS.map((r) => ({ ...r })),
    key_numericals:
      Array.isArray(t.key_numericals) && t.key_numericals.length > 0
        ? t.key_numericals
        : DEFAULT_NUMERICALS.map((n) => ({ ...n })),
    likes_management: typeof t.likes_management === "string" ? t.likes_management : "",
    dislikes_management: typeof t.dislikes_management === "string" ? t.dislikes_management : "",
    proposed_composition: Array.isArray(t.proposed_composition) ? t.proposed_composition : [],
    rating: t.rating,
    rationale: typeof t.rationale === "string" ? t.rationale : "",
  };
}

function asTriggers(input: unknown): TriggerShape {
  const t = (input ?? {}) as TriggerShape;
  return {
    sell_above: typeof t.sell_above === "number" ? t.sell_above : null,
    review_at: typeof t.review_at === "number" ? t.review_at : null,
    stop_loss: typeof t.stop_loss === "number" ? t.stop_loss : null,
  };
}

function asValuation(input: unknown): ValuationShape {
  const v = (input ?? {}) as ValuationShape;
  return {
    pe_multiple: typeof v.pe_multiple === "number" ? v.pe_multiple : null,
    override: Boolean(v.override),
  };
}

export function ResearchNoteEditor({
  initialNote,
  onNoteChange,
}: {
  initialNote?: NoteRecord | null;
  onNoteChange?: (note: NoteRecord | null) => void;
}) {
  const queryClient = useQueryClient();
  const [note, setNote] = React.useState<NoteRecord>(initialNote ?? emptyNote());
  const [busy, setBusy] = React.useState<null | "save" | "submit">(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-sync only when the note identity or revision changes
  React.useEffect(() => {
    if (initialNote) setNote(initialNote);
  }, [initialNote?.id, initialNote?.updated_at]);

  React.useEffect(() => {
    onNoteChange?.(note.id ? note : null);
  }, [note, onNoteChange]);

  const thesis = asThesis(note.thesis);
  const triggers = asTriggers(note.triggers);
  const valuation = asValuation(note.valuation);

  const universeQ = useQuery<{ securities: EquityUniverse[] }>({
    queryKey: ["equities-universe-v2"],
    queryFn: async () => {
      const r = await fetch("/api/equities", { cache: "no-store" });
      if (!r.ok) throw new Error(`equities ${r.status}`);
      return r.json();
    },
    ...queryOpts("reference"),
  });

  const symbols = universeQ.data?.securities ?? [];

  const update = <K extends keyof NoteRecord>(key: K, value: NoteRecord[K]) =>
    setNote((prev) => ({ ...prev, [key]: value, updated_at: new Date().toISOString() }));

  const updateThesis = (patch: Partial<ThesisShape>) =>
    setNote((prev) => ({
      ...prev,
      thesis: { ...asThesis(prev.thesis), ...patch },
      updated_at: new Date().toISOString(),
    }));

  const updateTrigger = (key: keyof TriggerShape, raw: string) => {
    const n = raw === "" ? null : Number(raw);
    const next: TriggerShape = { ...triggers, [key]: Number.isFinite(n) ? n : null };
    setNote((prev) => ({ ...prev, triggers: next, updated_at: new Date().toISOString() }));
  };

  const updateValuation = (patch: Partial<ValuationShape>) =>
    setNote((prev) => ({
      ...prev,
      valuation: { ...valuation, ...patch },
      updated_at: new Date().toISOString(),
    }));

  const saveDraft = async (): Promise<NoteRecord | null> => {
    setBusy("save");
    try {
      const payload = {
        symbol: note.symbol,
        thesis,
        triggers,
        valuation,
      };
      const res = await fetch("/api/research/notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        toast.error(data?.error ?? data?.message ?? "Failed to save draft");
        return null;
      }
      const saved = (data.note ?? { ...note, id: data.id }) as NoteRecord;
      setNote(saved);
      toast.success("Draft saved");
      queryClient.invalidateQueries({ queryKey: ["bff-research-notes"] });
      return saved;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Save failed");
      return null;
    } finally {
      setBusy(null);
    }
  };

  const submitToIc = async () => {
    setBusy("submit");
    try {
      const saved = note.id ? note : await saveDraft();
      if (!saved || !saved.id) {
        setBusy(null);
        return;
      }
      // draft → in_review
      const t1 = await fetch(`/api/research/notes/${saved.id}/transition`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to_status: "in_review" }),
      }).then((r) => r.json());
      if (!t1.ok) {
        toast.error(t1.error ?? "Could not advance to in_review");
        setBusy(null);
        return;
      }
      // in_review → ic_pending
      const t2 = await fetch(`/api/research/notes/${saved.id}/transition`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to_status: "ic_pending" }),
      }).then((r) => r.json());
      if (!t2.ok) {
        toast.error(t2.error ?? "Could not advance to ic_pending");
        setBusy(null);
        return;
      }
      setNote(t2.note ?? { ...saved, status: "ic_pending" });
      toast.success("Submitted to IC");
      queryClient.invalidateQueries({ queryKey: ["bff-research-notes"] });
    } finally {
      setBusy(null);
    }
  };

  const resetForm = () => setNote(emptyNote());

  return (
    <div className="space-y-4">
      <GlassSection
        title="Research note"
        subtitle="Analyst draft · bull/bear thesis, triggers, valuation, management view"
        endpoint="POST /api/research/notes"
        db="institutional"
        dataSource="supabase"
        right={
          <div className="flex flex-wrap items-center gap-2">
            <GlassBadge
              tone={
                note.status === "draft" ? "neutral" : note.status === "ic_pending" ? "primary" : "success"
              }
            >
              {note.id ? note.status : "new"}
            </GlassBadge>
            <Button size="sm" variant="outline" onClick={resetForm} className="gap-1.5">
              <FilePlus2 className="h-3.5 w-3.5" /> New Note
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={!note.symbol || busy !== null}
              onClick={() => void saveDraft()}
              className="gap-1.5"
            >
              <Save className="h-3.5 w-3.5" />
              {busy === "save" ? "Saving…" : "Save Draft"}
            </Button>
            <Button
              size="sm"
              disabled={!note.symbol || busy !== null}
              onClick={() => void submitToIc()}
              className="gap-1.5"
            >
              <Send className="h-3.5 w-3.5" />
              {busy === "submit" ? "Submitting…" : "Submit to IC"}
            </Button>
          </div>
        }
      >
        {universeQ.isLoading ? (
          <PanelSkeleton rows={6} />
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Symbol</Label>
              <Select value={note.symbol} onValueChange={(v) => update("symbol", v)}>
                <SelectTrigger className="glass-inset h-10 border-0">
                  <SelectValue placeholder="Select JSE ticker" />
                </SelectTrigger>
                <SelectContent className="max-h-[300px]">
                  {symbols.length === 0 ? (
                    <SelectItem value="__none" disabled>
                      No equities loaded
                    </SelectItem>
                  ) : (
                    symbols.map((s) => (
                      <SelectItem key={s.symbol} value={s.symbol}>
                        <span className="font-semibold">{s.symbol}</span>
                        <span className="ml-2 text-muted-foreground">{s.name ?? ""}</span>
                      </SelectItem>
                    ))
                  )}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label>Author</Label>
              <Input className="glass-inset h-10 border-0" value={note.author_email || "you"} readOnly />
            </div>

            <div className="space-y-1.5">
              <Label>Bull thesis</Label>
              <textarea
                rows={5}
                className="glass-inset min-h-[120px] w-full rounded-xl border-0 bg-transparent p-3 text-sm shadow-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                placeholder="Why this is a buy…"
                value={thesis.bull ?? ""}
                onChange={(e) => updateThesis({ bull: e.target.value })}
              />
            </div>

            <div className="space-y-1.5">
              <Label>Bear thesis</Label>
              <textarea
                rows={5}
                className="glass-inset min-h-[120px] w-full rounded-xl border-0 bg-transparent p-3 text-sm shadow-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                placeholder="What could go wrong…"
                value={thesis.bear ?? ""}
                onChange={(e) => updateThesis({ bear: e.target.value })}
              />
            </div>

            <div className="space-y-1.5">
              <Label>Risks</Label>
              <EditableList
                items={thesis.risks ?? []}
                placeholder="Add a risk…"
                onChange={(risks) => updateThesis({ risks })}
              />
            </div>

            <div className="space-y-1.5">
              <Label>Catalysts</Label>
              <EditableList
                items={thesis.catalysts ?? []}
                placeholder="Add a catalyst…"
                onChange={(catalysts) => updateThesis({ catalysts })}
              />
            </div>

            <div className="space-y-1.5 md:col-span-2">
              <Label>Key ratios</Label>
              <p className="text-[10px] italic text-muted-foreground">
                Lonwabo to confirm the canonical ratio list; defaults shown below.
              </p>
              <KeyRatiosEditor
                ratios={thesis.key_ratios ?? DEFAULT_RATIOS}
                onChange={(key_ratios) => updateThesis({ key_ratios })}
              />
            </div>

            <div className="space-y-1.5 md:col-span-2">
              <Label>Key numericals</Label>
              <KeyNumericalsEditor
                rows={thesis.key_numericals ?? DEFAULT_NUMERICALS}
                onChange={(key_numericals) => updateThesis({ key_numericals })}
              />
            </div>

            <div className="space-y-1.5">
              <Label>Valuation (P/E multiple)</Label>
              <div className="flex flex-wrap items-center gap-3">
                <Input
                  type="number"
                  step="0.1"
                  className="glass-inset h-10 w-32 border-0"
                  value={valuation.pe_multiple ?? ""}
                  onChange={(e) =>
                    updateValuation({
                      pe_multiple: e.target.value === "" ? null : Number(e.target.value),
                    })
                  }
                />
                <div className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
                  <Switch
                    checked={valuation.override ?? false}
                    onCheckedChange={(checked) => updateValuation({ override: checked })}
                    aria-label="Override consensus"
                  />
                  <span>Override consensus</span>
                </div>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label>Triggers</Label>
              <div className="grid grid-cols-3 gap-2">
                <NumberField
                  label="Sell above"
                  value={triggers.sell_above}
                  onChange={(v) => updateTrigger("sell_above", v)}
                />
                <NumberField
                  label="Review at"
                  value={triggers.review_at}
                  onChange={(v) => updateTrigger("review_at", v)}
                />
                <NumberField
                  label="Stop loss"
                  value={triggers.stop_loss}
                  onChange={(v) => updateTrigger("stop_loss", v)}
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label>Likes about management</Label>
              <textarea
                rows={3}
                className="glass-inset min-h-[80px] w-full rounded-xl border-0 bg-transparent p-3 text-sm shadow-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                value={thesis.likes_management ?? ""}
                onChange={(e) => updateThesis({ likes_management: e.target.value })}
              />
            </div>

            <div className="space-y-1.5">
              <Label>Dislikes about management</Label>
              <textarea
                rows={3}
                className="glass-inset min-h-[80px] w-full rounded-xl border-0 bg-transparent p-3 text-sm shadow-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                value={thesis.dislikes_management ?? ""}
                onChange={(e) => updateThesis({ dislikes_management: e.target.value })}
              />
            </div>
          </div>
        )}
      </GlassSection>
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{children}</p>
  );
}

function EditableList({
  items,
  placeholder,
  onChange,
}: {
  items: string[];
  placeholder: string;
  onChange: (next: string[]) => void;
}) {
  const [draft, setDraft] = React.useState("");
  const add = () => {
    const v = draft.trim();
    if (!v) return;
    onChange([...items, v]);
    setDraft("");
  };
  return (
    <div className="space-y-2">
      {items.length === 0 ? (
        <p className="text-xs italic text-muted-foreground">No entries yet.</p>
      ) : (
        <ul className="space-y-1.5">
          {items.map((it) => (
            <li key={it} className="glass-inset flex items-start gap-2 px-2.5 py-1.5 text-xs">
              <span className="flex-1 leading-relaxed">{it}</span>
              <button
                type="button"
                onClick={() => onChange(items.filter((entry) => entry !== it))}
                className="text-muted-foreground hover:text-destructive"
                aria-label="Remove"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex gap-2">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={placeholder}
          className="glass-inset h-9 border-0"
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
        />
        <Button size="sm" variant="outline" onClick={add} className="gap-1.5">
          <Plus className="h-3.5 w-3.5" /> Add
        </Button>
      </div>
    </div>
  );
}

function KeyRatiosEditor({
  ratios,
  onChange,
}: {
  ratios: { label: string; value: string }[];
  onChange: (next: { label: string; value: string }[]) => void;
}) {
  const [draft, setDraft] = React.useState({ label: "", value: "" });
  const add = () => {
    if (!draft.label.trim()) return;
    onChange([...ratios, { label: draft.label.trim(), value: draft.value.trim() }]);
    setDraft({ label: "", value: "" });
  };
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {ratios.map((r, idx) => (
          <span
            key={`${r.label}-${idx}`}
            className="glass-inset inline-flex items-center gap-1.5 px-2 py-1 text-[11px]"
          >
            <span className="font-semibold">{r.label}:</span>
            <span className="font-mono text-muted-foreground">{r.value || "—"}</span>
            <button
              type="button"
              onClick={() => onChange(ratios.filter((_, i) => i !== idx))}
              className="text-muted-foreground hover:text-destructive"
              aria-label="Remove ratio"
            >
              ×
            </button>
          </span>
        ))}
      </div>
      <div className="grid grid-cols-3 gap-2">
        <Input
          placeholder="Label (e.g. ROIC)"
          value={draft.label}
          onChange={(e) => setDraft((d) => ({ ...d, label: e.target.value }))}
          className="glass-inset h-9 border-0"
        />
        <Input
          placeholder="Value (e.g. 18%)"
          value={draft.value}
          onChange={(e) => setDraft((d) => ({ ...d, value: e.target.value }))}
          className="glass-inset h-9 border-0"
        />
        <Button size="sm" variant="outline" onClick={add} className="gap-1.5">
          <Plus className="h-3.5 w-3.5" /> Add ratio
        </Button>
      </div>
    </div>
  );
}

function KeyNumericalsEditor({
  rows,
  onChange,
}: {
  rows: NumericShape[];
  onChange: (next: NumericShape[]) => void;
}) {
  const update = (idx: number, patch: Partial<NumericShape>) =>
    onChange(rows.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  return (
    <div className="space-y-1.5">
      <div className="grid grid-cols-12 gap-1.5 px-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        <span className="col-span-4">Metric</span>
        <span className="col-span-2">Prior</span>
        <span className="col-span-2">Current</span>
        <span className="col-span-2">Forecast</span>
        <span className="col-span-2 text-right">Δ cur→fcst</span>
      </div>
      {rows.map((r, idx) => {
        const delta =
          r.current != null && r.forecast != null ? Number((r.forecast - r.current).toFixed(2)) : null;
        const cls = delta == null ? "" : delta >= 0 ? "text-up" : "text-down";
        return (
          <div key={`${r.label}-${idx}`} className="grid grid-cols-12 items-center gap-1.5">
            <Input
              value={r.label}
              onChange={(e) => update(idx, { label: e.target.value })}
              className="glass-inset col-span-4 h-9 border-0"
            />
            <Input
              type="number"
              step="0.01"
              value={r.prior ?? ""}
              onChange={(e) => update(idx, { prior: e.target.value === "" ? null : Number(e.target.value) })}
              className="glass-inset col-span-2 h-9 border-0"
            />
            <Input
              type="number"
              step="0.01"
              value={r.current ?? ""}
              onChange={(e) =>
                update(idx, { current: e.target.value === "" ? null : Number(e.target.value) })
              }
              className="glass-inset col-span-2 h-9 border-0"
            />
            <Input
              type="number"
              step="0.01"
              value={r.forecast ?? ""}
              onChange={(e) =>
                update(idx, { forecast: e.target.value === "" ? null : Number(e.target.value) })
              }
              className="glass-inset col-span-2 h-9 border-0"
            />
            <span className={cn("col-span-2 text-right font-mono text-xs", cls)}>
              {delta == null ? "—" : `${delta >= 0 ? "+" : ""}${delta.toFixed(2)}`}
            </span>
          </div>
        );
      })}
      <Button
        size="sm"
        variant="outline"
        onClick={() =>
          onChange([...rows, { label: "New metric", prior: null, current: null, forecast: null }])
        }
        className="gap-1.5"
      >
        <Plus className="h-3.5 w-3.5" /> Add metric
      </Button>
    </div>
  );
}

function NumberField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number | null;
  onChange: (raw: string) => void;
}) {
  return (
    <div className="space-y-1">
      <Label>{label}</Label>
      <Input
        type="number"
        step="0.01"
        className="glass-inset h-10 border-0"
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}
