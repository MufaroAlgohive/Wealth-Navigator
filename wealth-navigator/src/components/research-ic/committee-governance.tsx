"use client";

import { Plus, Save, Trash2 } from "lucide-react";
import * as React from "react";

type Scope = "live" | "uat";
type Member = {
  voter_email: string;
  display_name: string;
  initials: string | null;
  role: "chair" | "voting" | "observer";
  vote_scope: Array<"rebalance" | "research">;
  is_active: boolean;
};
type Policy = {
  environment_scope: Scope;
  approval_mode: "count" | "percentage";
  required_yes_count: number;
  required_yes_percent: number;
};
type Settings = { members: Member[]; policy: Policy };

export function CommitteeGovernance() {
  const [scope, setScope] = React.useState<Scope>("live");
  const [data, setData] = React.useState<Partial<Record<Scope, Settings>>>({});
  const [message, setMessage] = React.useState("");
  React.useEffect(() => {
    fetch("/api/research/committee/governance", { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => {
        if (j.ok) setData(j.scopes);
        else setMessage(j.error ?? "Unable to load governance.");
      })
      .catch(() => setMessage("Unable to load governance."));
  }, []);
  const current = data[scope];
  const change = (fn: (s: Settings) => Settings) =>
    current && setData((d) => ({ ...d, [scope]: fn(current) }));
  const toggle = (index: number, key: "rebalance" | "research") =>
    change((s) => ({
      ...s,
      members: s.members.map((m, i) =>
        i !== index
          ? m
          : {
              ...m,
              vote_scope: m.vote_scope.includes(key)
                ? m.vote_scope.filter((x) => x !== key)
                : [...m.vote_scope, key],
            },
      ),
    }));
  const save = async () => {
    if (!current) return;
    setMessage("Saving…");
    const r = await fetch("/api/research/committee/governance", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope, ...current }),
    });
    const j = await r.json().catch(() => ({}));
    setMessage(
      r.ok
        ? "Saved. This policy applies only to new votes in this environment."
        : (j.error ?? "Save failed."),
    );
  };
  if (!current)
    return (
      <div className="rounded-xl border border-[hsl(var(--glass-border))] p-4 text-sm text-muted-foreground">
        {message || "Loading IC governance…"}
      </div>
    );
  return (
    <div className="space-y-4 rounded-xl border border-[hsl(var(--glass-border))] p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="font-medium">Voting governance</p>
          <p className="text-xs text-muted-foreground">
            LIVE and UAT rosters are stored and enforced separately.
          </p>
        </div>
        <div className="flex rounded-lg border border-[hsl(var(--glass-border))] p-1">
          {(["live", "uat"] as Scope[]).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setScope(s)}
              className={`rounded-md px-3 py-1 text-xs font-medium ${scope === s ? "bg-primary/15 text-primary" : "text-muted-foreground"}`}
            >
              {s.toUpperCase()}
            </button>
          ))}
        </div>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <label className="text-xs text-muted-foreground">
          Approval rule
          <select
            value={current.policy.approval_mode}
            onChange={(e) =>
              change((s) => ({
                ...s,
                policy: { ...s.policy, approval_mode: e.target.value as Policy["approval_mode"] },
              }))
            }
            className="mt-1 block w-full rounded border bg-transparent px-2 py-1 text-sm"
          >
            <option value="count">Required yes votes</option>
            <option value="percentage">Percentage of eligible voters</option>
          </select>
        </label>
        <label className="text-xs text-muted-foreground">
          {current.policy.approval_mode === "count" ? "Yes votes required" : "Yes percentage required"}
          <input
            type="number"
            min="1"
            max={current.policy.approval_mode === "count" ? 99 : 100}
            value={
              current.policy.approval_mode === "count"
                ? current.policy.required_yes_count
                : current.policy.required_yes_percent
            }
            onChange={(e) =>
              change((s) => ({
                ...s,
                policy: {
                  ...s.policy,
                  [s.policy.approval_mode === "count" ? "required_yes_count" : "required_yes_percent"]:
                    Number(e.target.value),
                },
              }))
            }
            className="mt-1 block w-full rounded border bg-transparent px-2 py-1 text-sm"
          />
        </label>
      </div>
      <div className="space-y-2">
        {current.members.map((m, i) => (
          <div
            key={`${m.voter_email}-${i}`}
            className="grid gap-2 rounded-lg border border-[hsl(var(--glass-border))] p-3 md:grid-cols-[1fr_1fr_auto_auto_auto]"
          >
            <input
              value={m.display_name}
              onChange={(e) =>
                change((s) => ({
                  ...s,
                  members: s.members.map((x, n) => (n === i ? { ...x, display_name: e.target.value } : x)),
                }))
              }
              placeholder="Name"
              className="rounded border bg-transparent px-2 py-1 text-sm"
            />
            <input
              value={m.voter_email}
              onChange={(e) =>
                change((s) => ({
                  ...s,
                  members: s.members.map((x, n) => (n === i ? { ...x, voter_email: e.target.value } : x)),
                }))
              }
              placeholder="email@company.com"
              className="rounded border bg-transparent px-2 py-1 text-sm"
            />
            <label className="flex items-center gap-1 text-xs">
              <input
                type="checkbox"
                checked={m.vote_scope.includes("rebalance")}
                onChange={() => toggle(i, "rebalance")}
              />{" "}
              Rebalances
            </label>
            <label className="flex items-center gap-1 text-xs">
              <input
                type="checkbox"
                checked={m.vote_scope.includes("research")}
                onChange={() => toggle(i, "research")}
              />{" "}
              Research
            </label>
            <button
              type="button"
              onClick={() => change((s) => ({ ...s, members: s.members.filter((_, n) => n !== i) }))}
              className="text-muted-foreground hover:text-destructive"
              title="Remove voter"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() =>
            change((s) => ({
              ...s,
              members: [
                ...s.members,
                {
                  voter_email: "",
                  display_name: "",
                  initials: null,
                  role: "voting",
                  vote_scope: ["rebalance"],
                  is_active: true,
                },
              ],
            }))
          }
          className="inline-flex items-center gap-1 rounded-lg border px-3 py-1.5 text-xs"
        >
          <Plus className="h-3.5 w-3.5" /> Add voter
        </button>
        <button
          type="button"
          onClick={save}
          className="inline-flex items-center gap-1 rounded-lg bg-primary px-3 py-1.5 text-xs text-primary-foreground"
        >
          <Save className="h-3.5 w-3.5" /> Save {scope.toUpperCase()} policy
        </button>
        {message && <span className="self-center text-xs text-muted-foreground">{message}</span>}
      </div>
    </div>
  );
}
