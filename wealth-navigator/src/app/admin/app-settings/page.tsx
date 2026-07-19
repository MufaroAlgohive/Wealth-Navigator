"use client";

import * as React from "react";
import { toast } from "sonner";
import { AlertTriangle } from "lucide-react";

import { useAdmin } from "@/lib/admin/context";
import { isAdminRole } from "@/lib/admin/pages";
import { Button } from "@/components/ui/button";
import { DataSourceBadge } from "@/components/oems/primitives/data-source-badge";
import { cn } from "@/lib/cn";

type Kind = "money" | "percent";

const GROUPS = [
  { id: "purchase", label: "Purchase fees (app)" },
  { id: "cash", label: "Cash asset class" },
  { id: "strategy", label: "Strategy" },
  { id: "rebalance", label: "CRM rebalance engine" },
] as const;
type GroupId = (typeof GROUPS)[number]["id"];

interface FeeField {
  key: string;
  group: GroupId;
  kind: Kind;
  label: string;
  hint: string;
}

// Mirrors legacy app-settings.html FIELDS exactly (keys, groups, kinds).
const FIELDS: FeeField[] = [
  { key: "isinFeePerAsset",      group: "purchase",  kind: "money",   label: "Custody fee per asset",          hint: "Charged per underlying security in a basket" },
  { key: "brokerFeeRate",        group: "purchase",  kind: "percent", label: "Broker fee",                     hint: "Percent of the buffered investment" },
  { key: "executionReserveRate", group: "cash",      kind: "percent", label: "Execution reserve",              hint: "Held cash set aside on every buy — a cash asset, not a fee" },
  { key: "transactionFeeRate",   group: "purchase",  kind: "percent", label: "Transaction fee",                hint: "Percent of the buffered investment" },
  { key: "monthlyStrategyFee",   group: "strategy",  kind: "money",   label: "Monthly additional-strategy fee", hint: "Charged per extra strategy, per month" },
  { key: "rebBrokerageRate",     group: "rebalance", kind: "percent", label: "Rebalance brokerage",            hint: "Brokerage applied during rebalances" },
  { key: "rebCustodyFee",        group: "rebalance", kind: "money",   label: "Rebalance custody fee",          hint: "Custody per asset, per affected client" },
];

const toInput = (kind: Kind, val: unknown): string => {
  const n = Number(val);
  if (val == null || Number.isNaN(n)) return "";
  return kind === "percent" ? String(+(n * 100).toFixed(6)) : String(n);
};
const fromInput = (kind: Kind, raw: string): number =>
  kind === "percent" ? Number(raw) / 100 : Number(raw);

const emptyValues = (): Record<string, string> =>
  Object.fromEntries(FIELDS.map((f) => [f.key, ""]));

export default function AppSettingsPage() {
  const { ctx } = useAdmin();
  const admin = isAdminRole(ctx);

  const [values, setValues] = React.useState<Record<string, string>>(emptyValues);
  const [original, setOriginal] = React.useState<Record<string, string>>(emptyValues);
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [meta, setMeta] = React.useState<string>("");

  const populate = React.useCallback((value: Record<string, unknown> | null) => {
    const next: Record<string, string> = {};
    for (const f of FIELDS) next[f.key] = value && value[f.key] != null ? toInput(f.kind, value[f.key]) : "";
    setValues(next);
    setOriginal(next);
  }, []);

  const setMetaLine = React.useCallback((updatedAt: string | null, updatedBy: string | null) => {
    if (!updatedAt) {
      setMeta("");
      return;
    }
    const d = new Date(updatedAt);
    setMeta(`Last updated ${d.toLocaleString("en-ZA")}${updatedBy ? ` · ${updatedBy}` : ""}`);
  }, []);

  React.useEffect(() => {
    if (!admin) {
      setLoading(false);
      return;
    }
    let alive = true;
    (async () => {
      try {
        const r = await fetch("/api/admin/app-settings?key=fees").then((x) => x.json());
        if (!alive) return;
        if (r?.notice) setNotice(`${r.notice} Showing nothing until the app_settings table exists.`);
        populate(r?.value ?? {});
        setMetaLine(r?.updated_at ?? null, r?.updated_by ?? null);
      } catch {
        if (alive) setNotice("Could not load settings.");
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [admin, populate, setMetaLine]);

  const dirty = FIELDS.some((f) => values[f.key] !== original[f.key]);
  const valid = FIELDS.every((f) => {
    const v = values[f.key] ?? "";
    return v !== "" && !Number.isNaN(Number(v)) && Number(v) >= 0;
  });
  const canSave = admin && dirty && valid && !saving;

  const save = async () => {
    setSaving(true);
    const value: Record<string, number> = {};
    for (const f of FIELDS) value[f.key] = fromInput(f.kind, values[f.key] ?? "");
    try {
      const r = await fetch("/api/admin/app-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "fees", value }),
      }).then((x) => x.json());
      if (r?.ok) {
        toast.success("Fees saved");
        populate(r.value);
        setMetaLine(new Date().toISOString(), ctx.email);
      } else {
        toast.error(r?.error || "Save failed");
      }
    } catch {
      toast.error("Save failed");
    } finally {
      setSaving(false);
    }
  };

  if (!admin) {
    return <div className="py-16 text-center text-sm text-muted-foreground">Admins only.</div>;
  }

  return (
    <div className="mx-auto max-w-3xl">
      <p className="mb-5 text-sm text-muted-foreground">
        Platform-wide configuration. Changes apply to new transactions within ~1 minute — no deploy needed.
      </p>

      {notice && (
        <div className="mb-5 flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 px-4 py-3 text-sm text-foreground/90">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
          <span>{notice}</span>
        </div>
      )}

      <div className="rounded-2xl border border-border bg-card p-6">
        <div className="flex items-center gap-2">
          <h2 className="text-[15px] font-bold text-foreground">Fees</h2>
          <DataSourceBadge source="supabase" db="retail" />
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          The single source of truth for platform fees. The app and CRM read these values.
        </p>

        {GROUPS.map((g) => {
          const fields = FIELDS.filter((f) => f.group === g.id);
          if (fields.length === 0) return null;
          return (
            <div key={g.id}>
              <div className="mt-5 mb-1 text-[11px] font-bold uppercase tracking-wider text-muted-foreground">{g.label}</div>
              {fields.map((f) => (
                <div key={f.key} className="flex items-center justify-between gap-4 border-b border-border/60 py-3 last:border-b-0">
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-foreground">{f.label}</div>
                    <div className="mt-0.5 text-[11.5px] text-muted-foreground">{f.hint}</div>
                  </div>
                  <div className="relative shrink-0">
                    {f.kind === "money" && (
                      <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">R</span>
                    )}
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      disabled={loading}
                      value={values[f.key] ?? ""}
                      onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                      className={cn(
                        "h-10 w-[140px] rounded-lg border border-input bg-background text-right text-sm text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/20",
                        f.kind === "money" ? "pl-7 pr-3" : "pl-3 pr-7",
                      )}
                    />
                    {f.kind === "percent" && (
                      <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">%</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          );
        })}

        <div className="mt-6 flex items-center gap-4">
          <Button onClick={save} disabled={!canSave}>
            {saving ? "Saving…" : "Save changes"}
          </Button>
          {meta && <span className="text-xs text-muted-foreground">{meta}</span>}
        </div>
      </div>
    </div>
  );
}
