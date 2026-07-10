"use client";

/**
 * Create / edit a research note. Writes the rich JSONB contract (thesis /
 * triggers / valuation) via POST /api/research/notes (create) or
 * PATCH /api/research/notes/[id] (edit). Kept compact but covers every field
 * the detail view renders so a note authored here shows up complete.
 */

import * as React from "react";
import { Plus, X, Save } from "lucide-react";

import { cn } from "@/lib/cn";
import { GlassSection } from "@/components/oems/primitives/glass";
import type { ResearchNote, Rating, Esg, Fundamental, Peer, NoteThesis, NoteTriggers, NoteValuation } from "./types";

const INPUT =
  "w-full rounded-lg border border-[hsl(var(--glass-border))] bg-[hsl(var(--foreground)/0.03)] px-3 py-2 text-sm outline-none focus:border-primary/50";
const LABEL = "text-[11px] font-semibold uppercase tracking-wide text-muted-foreground";

function Field({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <label className={cn("block space-y-1", className)}>
      <span className={LABEL}>{label}</span>
      {children}
    </label>
  );
}

const RATINGS: Rating[] = ["BUY", "ACCUMULATE", "HOLD", "SELL"];
const ESGS: (Esg | "")[] = ["", "GREEN", "AMBER", "RED"];

interface TriggerForm {
  price: string;
  note: string;
}
const emptyTrigger = (): TriggerForm => ({ price: "", note: "" });

function buildTrigger(t: TriggerForm) {
  const price = Number(t.price);
  if (!t.price || !Number.isFinite(price)) return undefined;
  return { price, note: t.note.trim() || undefined };
}

export function NoteEditor({
  note,
  onSaved,
  onCancel,
}: {
  note?: ResearchNote | null;
  onSaved: (noteId: string) => void;
  onCancel: () => void;
}) {
  const th = note?.thesis ?? {};
  const tr = note?.triggers ?? {};
  const val = note?.valuation ?? {};
  const editing = !!note;

  const [symbol, setSymbol] = React.useState(note?.symbol ?? "");
  const [companyName, setCompanyName] = React.useState(th.companyName ?? "");
  const [sector, setSector] = React.useState(th.sector ?? "");
  const [isin, setIsin] = React.useState(th.isin ?? "");
  const [horizon, setHorizon] = React.useState(th.horizon ?? "");
  const [rating, setRating] = React.useState<Rating>(th.rating ?? "BUY");
  const [style, setStyle] = React.useState(th.style ?? "");
  const [conviction, setConviction] = React.useState(th.conviction ?? "");
  const [esg, setEsg] = React.useState<Esg | "">(th.esg ?? "");
  const [targetPrice, setTargetPrice] = React.useState(th.targetPrice != null ? String(th.targetPrice) : "");
  const [linkedStrategies, setLinkedStrategies] = React.useState((th.linkedStrategies ?? []).join(", "));
  const [bull, setBull] = React.useState(th.bull ?? "");
  const [bear, setBear] = React.useState(th.bear ?? "");
  const [catalysts, setCatalysts] = React.useState((th.catalysts ?? []).join("\n"));
  const [risks, setRisks] = React.useState((th.risks ?? []).join("\n"));
  const [likes, setLikes] = React.useState(th.likesManagement ?? "");
  const [dislikes, setDislikes] = React.useState(th.dislikesManagement ?? "");
  const [peMultiple, setPeMultiple] = React.useState(val.pe_multiple != null ? String(val.pe_multiple) : "");

  const [triggers, setTriggers] = React.useState<Record<string, TriggerForm>>({
    buy_below: { price: tr.buy_below?.price != null ? String(tr.buy_below.price) : "", note: tr.buy_below?.note ?? "" },
    add_below: { price: tr.add_below?.price != null ? String(tr.add_below.price) : "", note: tr.add_below?.note ?? "" },
    trim_above: { price: tr.trim_above?.price != null ? String(tr.trim_above.price) : "", note: tr.trim_above?.note ?? "" },
    sell_above: { price: tr.sell_above?.price != null ? String(tr.sell_above.price) : "", note: tr.sell_above?.note ?? "" },
    stop_loss: { price: tr.stop_loss?.price != null ? String(tr.stop_loss.price) : "", note: tr.stop_loss?.note ?? "" },
  });
  const setTrig = (k: string, patch: Partial<TriggerForm>) =>
    setTriggers((prev) => ({ ...prev, [k]: { ...prev[k]!, ...patch } }));

  const [funds, setFunds] = React.useState<Fundamental[]>(th.fundamentals ?? []);
  const [peers, setPeers] = React.useState<Peer[]>(val.peers ?? []);

  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const toList = (s: string) => s.split("\n").map((x) => x.trim()).filter(Boolean);

  async function save() {
    setError(null);
    const sym = symbol.trim().toUpperCase();
    if (!sym) {
      setError("Ticker is required.");
      return;
    }
    const thesis: NoteThesis = {
      ...th,
      companyName: companyName.trim() || undefined,
      sector: sector.trim() || undefined,
      isin: isin.trim() || undefined,
      horizon: horizon.trim() || undefined,
      rating,
      style: style.trim() || undefined,
      conviction: conviction.trim() || undefined,
      esg: esg || null,
      targetPrice: targetPrice ? Number(targetPrice) : undefined,
      linkedStrategies: linkedStrategies.split(",").map((x) => x.trim()).filter(Boolean),
      bull: bull.trim() || undefined,
      bear: bear.trim() || undefined,
      catalysts: toList(catalysts),
      risks: toList(risks),
      fundamentals: funds.filter((f) => f.metric.trim()),
      likesManagement: likes.trim() || undefined,
      dislikesManagement: dislikes.trim() || undefined,
    };
    const trg: NoteTriggers = {
      buy_below: buildTrigger(triggers.buy_below!),
      add_below: buildTrigger(triggers.add_below!),
      trim_above: buildTrigger(triggers.trim_above!),
      sell_above: buildTrigger(triggers.sell_above!),
      stop_loss: buildTrigger(triggers.stop_loss!),
    };
    const valuation: NoteValuation = {
      pe_multiple: peMultiple ? Number(peMultiple) : undefined,
      peers: peers.filter((p) => p.name.trim() && Number.isFinite(p.pe)),
    };

    setBusy(true);
    try {
      const res = await fetch(editing ? `/api/research/notes/${note!.id}` : "/api/research/notes", {
        method: editing ? "PATCH" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ symbol: sym, thesis, triggers: trg, valuation }),
      });
      const json = (await res.json().catch(() => ({}))) as { ok?: boolean; note?: { id: string }; error?: string };
      if (!res.ok || !json.ok || !json.note?.id) {
        setError(json.error ?? `Save failed (${res.status}).`);
        return;
      }
      onSaved(json.note.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <GlassSection
      title={editing ? `Edit note · ${note!.symbol}` : "New research note"}
      right={
        <div className="flex items-center gap-2">
          <button type="button" onClick={onCancel} className="rounded-lg border border-[hsl(var(--glass-border))] px-3 py-1.5 text-xs hover:bg-[hsl(var(--foreground)/0.05)]">
            Cancel
          </button>
          <button
            type="button"
            onClick={save}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
          >
            <Save className="h-3.5 w-3.5" /> {busy ? "Saving…" : "Save draft"}
          </button>
        </div>
      }
    >
      {error && <p className="mb-3 rounded-lg border border-[hsl(var(--down)/0.35)] bg-[hsl(var(--down)/0.1)] px-3 py-2 text-xs text-down">{error}</p>}

      <div className="space-y-5">
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Ticker">
            <input className={INPUT} value={symbol} onChange={(e) => setSymbol(e.target.value)} placeholder="NPN" disabled={editing} />
          </Field>
          <Field label="Company" className="sm:col-span-2">
            <input className={INPUT} value={companyName} onChange={(e) => setCompanyName(e.target.value)} placeholder="Naspers" />
          </Field>
          <Field label="Sector">
            <input className={INPUT} value={sector} onChange={(e) => setSector(e.target.value)} />
          </Field>
          <Field label="ISIN">
            <input className={INPUT} value={isin} onChange={(e) => setIsin(e.target.value)} />
          </Field>
          <Field label="Horizon">
            <input className={INPUT} value={horizon} onChange={(e) => setHorizon(e.target.value)} placeholder="12M" />
          </Field>
          <Field label="Rating">
            <select className={INPUT} value={rating} onChange={(e) => setRating(e.target.value as Rating)}>
              {RATINGS.map((r) => (
                <option key={r} value={r}>{r}</option>
              ))}
            </select>
          </Field>
          <Field label="Conviction">
            <input className={INPUT} value={conviction} onChange={(e) => setConviction(e.target.value)} placeholder="HIGH CONVICTION" />
          </Field>
          <Field label="ESG">
            <select className={INPUT} value={esg} onChange={(e) => setEsg(e.target.value as Esg | "")}>
              {ESGS.map((v) => (
                <option key={v || "none"} value={v}>{v || "—"}</option>
              ))}
            </select>
          </Field>
          <Field label="Style tag">
            <input className={INPUT} value={style} onChange={(e) => setStyle(e.target.value)} placeholder="BUY & HOLD" />
          </Field>
          <Field label="Target price (R)">
            <input className={INPUT} value={targetPrice} onChange={(e) => setTargetPrice(e.target.value)} inputMode="decimal" />
          </Field>
          <Field label="P/E multiple">
            <input className={INPUT} value={peMultiple} onChange={(e) => setPeMultiple(e.target.value)} inputMode="decimal" />
          </Field>
          <Field label="Linked strategies (comma-sep)" className="sm:col-span-3">
            <input className={INPUT} value={linkedStrategies} onChange={(e) => setLinkedStrategies(e.target.value)} placeholder="MINT SA Equity Alpha" />
          </Field>
        </div>

        <div className="grid gap-3 lg:grid-cols-2">
          <Field label="Bull thesis">
            <textarea className={cn(INPUT, "min-h-[96px]")} value={bull} onChange={(e) => setBull(e.target.value)} />
          </Field>
          <Field label="Bear case / risks">
            <textarea className={cn(INPUT, "min-h-[96px]")} value={bear} onChange={(e) => setBear(e.target.value)} />
          </Field>
          <Field label="Catalysts (one per line)">
            <textarea className={cn(INPUT, "min-h-[72px]")} value={catalysts} onChange={(e) => setCatalysts(e.target.value)} />
          </Field>
          <Field label="Risks (one per line)">
            <textarea className={cn(INPUT, "min-h-[72px]")} value={risks} onChange={(e) => setRisks(e.target.value)} />
          </Field>
          <Field label="Management — what we love">
            <textarea className={cn(INPUT, "min-h-[72px]")} value={likes} onChange={(e) => setLikes(e.target.value)} />
          </Field>
          <Field label="Management — what worries us">
            <textarea className={cn(INPUT, "min-h-[72px]")} value={dislikes} onChange={(e) => setDislikes(e.target.value)} />
          </Field>
        </div>

        {/* triggers */}
        <div>
          <p className={LABEL}>Triggers</p>
          <div className="mt-2 space-y-2">
            {([
              ["buy_below", "Buy below"],
              ["add_below", "Add below"],
              ["trim_above", "Trim above"],
              ["sell_above", "Sell above"],
              ["stop_loss", "Stop loss"],
            ] as const).map(([k, label]) => (
              <div key={k} className="grid grid-cols-[110px_100px_1fr] items-center gap-2">
                <span className="text-xs text-muted-foreground">{label}</span>
                <input className={INPUT} value={triggers[k]!.price} onChange={(e) => setTrig(k, { price: e.target.value })} placeholder="price" inputMode="decimal" />
                <input className={INPUT} value={triggers[k]!.note} onChange={(e) => setTrig(k, { note: e.target.value })} placeholder="note" />
              </div>
            ))}
          </div>
        </div>

        {/* fundamentals */}
        <ListEditor
          label="Fundamentals"
          rows={funds}
          onAdd={() => setFunds((p) => [...p, { metric: "", prior: "", current: "", forecast: "", trend: "flat" }])}
          onRemove={(i) => setFunds((p) => p.filter((_, idx) => idx !== i))}
          render={(f, i) => (
            <div className="grid grid-cols-[1.4fr_1fr_1fr_1fr_90px] gap-2">
              <input className={INPUT} value={f.metric} placeholder="Metric" onChange={(e) => setFunds((p) => p.map((x, idx) => (idx === i ? { ...x, metric: e.target.value } : x)))} />
              <input className={INPUT} value={String(f.prior)} placeholder="Prior" onChange={(e) => setFunds((p) => p.map((x, idx) => (idx === i ? { ...x, prior: e.target.value } : x)))} />
              <input className={INPUT} value={String(f.current)} placeholder="Current" onChange={(e) => setFunds((p) => p.map((x, idx) => (idx === i ? { ...x, current: e.target.value } : x)))} />
              <input className={INPUT} value={String(f.forecast)} placeholder="Forecast" onChange={(e) => setFunds((p) => p.map((x, idx) => (idx === i ? { ...x, forecast: e.target.value } : x)))} />
              <select className={INPUT} value={f.trend ?? "flat"} onChange={(e) => setFunds((p) => p.map((x, idx) => (idx === i ? { ...x, trend: e.target.value as Fundamental["trend"] } : x)))}>
                <option value="up">up</option>
                <option value="flat">flat</option>
                <option value="down">down</option>
              </select>
            </div>
          )}
        />

        {/* peers */}
        <ListEditor
          label="Valuation vs peers (P/E)"
          rows={peers}
          onAdd={() => setPeers((p) => [...p, { name: "", pe: 0 }])}
          onRemove={(i) => setPeers((p) => p.filter((_, idx) => idx !== i))}
          render={(p, i) => (
            <div className="grid grid-cols-[1fr_120px] gap-2">
              <input className={INPUT} value={p.name} placeholder="Peer" onChange={(e) => setPeers((prev) => prev.map((x, idx) => (idx === i ? { ...x, name: e.target.value } : x)))} />
              <input className={INPUT} value={String(p.pe)} placeholder="P/E" inputMode="decimal" onChange={(e) => setPeers((prev) => prev.map((x, idx) => (idx === i ? { ...x, pe: Number(e.target.value) } : x)))} />
            </div>
          )}
        />
      </div>
    </GlassSection>
  );
}

function ListEditor<T>({
  label,
  rows,
  onAdd,
  onRemove,
  render,
}: {
  label: string;
  rows: T[];
  onAdd: () => void;
  onRemove: (i: number) => void;
  render: (row: T, i: number) => React.ReactNode;
}) {
  return (
    <div>
      <div className="flex items-center justify-between">
        <p className={LABEL}>{label}</p>
        <button type="button" onClick={onAdd} className="inline-flex items-center gap-1 rounded-md border border-[hsl(var(--glass-border))] px-2 py-1 text-[11px] hover:bg-[hsl(var(--foreground)/0.05)]">
          <Plus className="h-3 w-3" /> Add
        </button>
      </div>
      <div className="mt-2 space-y-2">
        {rows.map((row, i) => (
          <div key={i} className="flex items-center gap-2">
            <div className="min-w-0 flex-1">{render(row, i)}</div>
            <button type="button" onClick={() => onRemove(i)} className="shrink-0 rounded-md p-1.5 text-muted-foreground hover:text-down">
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
        {rows.length === 0 && <p className="text-caption">None yet.</p>}
      </div>
    </div>
  );
}
