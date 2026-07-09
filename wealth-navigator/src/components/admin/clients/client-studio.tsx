"use client";

/**
 * ClientStudio — merged pop-up the Clients page mounts on the right rail.
 * Combines profile + KYC + holdings + cash + allocations + transactions +
 * documents + an "Open as promoter" affordance.
 *
 * Drives:
 *   /api/admin/clients?action=detail   (profile / KYC / holdings / txns)
 *   /api/admin/clients?action=holdings (holdings + sector allocations)
 *   /api/admin/clients?action=cash     (cash position + recent transactions)
 *   /api/admin/clients/cash-accrual    (AUM-fee accrual over time)
 *   /api/admin/studio?action=impersonate (Open as promoter)
 *
 * Rendered only when a row is selected; the parent owns the close button.
 */

import { ExternalLink, FileText, Image as ImageIcon, Loader2 } from "lucide-react";
import * as React from "react";
import { Cell, Line, LineChart, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/cn";

interface Holding {
  symbol: string;
  name: string;
  sector: string | null;
  qty: number;
  valueCents: number;
  investedCents: number;
  pnlCents: number;
  strategy: string | null;
  family_member_id: string | null;
}
interface Detail {
  profile: Record<string, unknown> | null;
  onboarding: Record<string, unknown> | null;
  required: Record<string, unknown> | null;
  kyc: "verified" | "pending" | "rejected";
  holdings: Holding[];
  transactions: {
    id: string;
    name: string | null;
    description: string | null;
    amount: number;
    direction: string;
    status: string | null;
    transaction_date: string | null;
  }[];
}
interface CashPayload {
  cashCents: number;
  recent: {
    id: string;
    name: string | null;
    description: string | null;
    amount: number;
    direction: string;
    status: string | null;
    transaction_date: string | null;
    broker_fee_cents: number | null;
    isin_fee_cents: number | null;
    transaction_fee_cents: number | null;
  }[];
}
interface AccrualMonth {
  month: string;
  monthly_fee_cents: number;
  cumulative_cents: number;
}
interface AccrualResponse {
  combined: { total_accrued_cents: number; latest_basket_value_cents: number; months: AccrualMonth[] };
  strategies: Array<{ strategy_id: string; total_accrued_cents: number; latest_basket_value_cents: number }>;
  formula: { monthly_fee_cents: number | null; annual_fee_default: number; note: string };
}
interface HoldPayload {
  holdings: Holding[];
  allocations: { sector: string; valueCents: number }[];
}

const R = (cents: number) =>
  `R ${(Number(cents) || 0).toLocaleString("en-ZA", { maximumFractionDigits: 0 })}`;
const pnlCls = (n: number) => (n >= 0 ? "text-success" : "text-destructive");
const pnlStr = (n: number) => `${n >= 0 ? "+" : ""}${R(Math.round(n))}`;
const initials = (name: string) =>
  name
    .split(" ")
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase() || "?";
const str = (v: unknown) => (v == null || v === "" ? "—" : String(v));
const PIE = [
  "#7c5cff",
  "#22c55e",
  "#f59e0b",
  "#38bdf8",
  "#ec4899",
  "#ef4444",
  "#a3a3a3",
  "#14b8a6",
  "#eab308",
];

interface ClientStudioProps {
  userId: string;
  onClose?: () => void;
}

export function ClientStudio({ userId, onClose: _onClose }: ClientStudioProps) {
  const [detail, setDetail] = React.useState<Detail | null>(null);
  const [holdings, setHoldings] = React.useState<HoldPayload | null>(null);
  const [cash, setCash] = React.useState<CashPayload | null>(null);
  const [accrual, setAccrual] = React.useState<AccrualResponse | null>(null);
  const [tab, setTab] = React.useState("holdings");
  const [launching, setLaunching] = React.useState(false);

  React.useEffect(() => {
    setDetail(null);
    setHoldings(null);
    setCash(null);
    setAccrual(null);
    void fetch(`/api/admin/clients?action=detail&user_id=${userId}`)
      .then((r) => r.json().catch(() => ({})))
      .then((d) => {
        if (d.ok) setDetail(d as Detail);
      });
    void fetch(`/api/admin/clients?action=holdings&user_id=${userId}`)
      .then((r) => r.json().catch(() => ({})))
      .then((d) => {
        if (d.ok) setHoldings(d as HoldPayload);
      });
    void fetch(`/api/admin/clients?action=cash&user_id=${userId}`)
      .then((r) => r.json().catch(() => ({})))
      .then((d) => {
        if (d.ok) setCash(d as CashPayload);
      });
    void fetch(`/api/admin/clients/cash-accrual?user_id=${userId}`)
      .then((r) => r.json().catch(() => ({})))
      .then((d) => {
        if (d.ok) setAccrual(d as AccrualResponse);
      });
  }, [userId]);

  // Aggregates (pulled to the studio header so the KPI strip is consistent
  // across tabs).
  const totalValueCents = (holdings?.holdings ?? []).reduce((acc, h) => acc + h.valueCents, 0);
  const totalInvestedCents = (holdings?.holdings ?? []).reduce((acc, h) => acc + h.investedCents, 0);
  const totalPnlCents = totalValueCents - totalInvestedCents;
  const cashCents = cash?.cashCents ?? 0;
  const name =
    str(
      (detail?.profile as { first_name?: string; last_name?: string; email?: string } | null)?.first_name &&
        `${(detail?.profile as { first_name?: string }).first_name} ${(detail?.profile as { last_name?: string }).last_name ?? ""}`.trim(),
    ) ||
    str(detail?.profile?.email) ||
    "Client";

  const launchAsPromoter = async () => {
    setLaunching(true);
    try {
      // Re-uses the studio impersonation endpoint so we don't duplicate
      // the action-link generation logic.
      const r = await fetch("/api/admin/studio?action=impersonate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: userId, target: "live" }),
      });
      const body = (await r.json().catch(() => ({}))) as {
        ok?: boolean;
        actionLink?: string;
        error?: string;
      };
      if (body.ok && body.actionLink) {
        window.open(body.actionLink, "_blank", "noopener,noreferrer");
      } else {
        toast.error(body.error || "Action link generation deferred");
      }
    } finally {
      setLaunching(false);
    }
  };

  return (
    <div className="space-y-3 p-3">
      {/* Header */}
      <header className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-gradient-to-br from-primary/15 to-transparent p-3">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-gradient-to-br from-primary to-chart-5 text-sm font-bold text-primary-foreground">
            {initials(name)}
          </div>
          <div className="min-w-0">
            <div className="truncate text-base font-bold text-foreground">{name}</div>
            <div className="truncate text-[11px] text-muted-foreground">
              {str(detail?.profile?.email)}{" "}
              {str(detail?.profile?.mint_number) && str(detail?.profile?.mint_number) !== "—"
                ? `· ${str(detail?.profile?.mint_number)}`
                : ""}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant={detail?.kyc === "verified" ? "default" : "secondary"} className="capitalize">
            KYC {detail?.kyc ?? "—"}
          </Badge>
          <Button size="sm" onClick={launchAsPromoter} disabled={launching}>
            {launching ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <ExternalLink className="h-3.5 w-3.5" />
            )}
            Open as promoter
          </Button>
        </div>
      </header>

      {/* KPI strip */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Mini label="Holdings" value={R(totalValueCents)} />
        <Mini label="Cash" value={R(cashCents)} accent={cashCents < 0 ? "negative" : "default"} />
        <Mini label="Invested" value={R(totalInvestedCents)} />
        <Mini
          label="P&L"
          value={pnlStr(totalPnlCents)}
          accent={totalPnlCents >= 0 ? "positive" : "negative"}
        />
      </div>

      {/* Accrual hint + cash burn-down line */}
      {accrual && (
        <div className="rounded-lg border border-border bg-card/60 p-3 text-[11px] text-muted-foreground">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span>
              AUM fee accrued:{" "}
              <strong className="text-foreground">{R(accrual.combined.total_accrued_cents)}</strong>
              {accrual.formula.monthly_fee_cents !== null && (
                <>
                  {" "}
                  · monthly ≈{" "}
                  <strong className="text-foreground">{R(accrual.formula.monthly_fee_cents)}</strong>
                </>
              )}
            </span>
            <span>{(accrual.combined.months ?? []).length} months on books</span>
          </div>
        </div>
      )}

      {/* Tabs */}
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="flex-wrap">
          <TabsTrigger value="holdings">Holdings</TabsTrigger>
          <TabsTrigger value="cash">Cash</TabsTrigger>
          <TabsTrigger value="allocations">Allocations</TabsTrigger>
          <TabsTrigger value="transactions">Transactions</TabsTrigger>
          <TabsTrigger value="documents">Documents</TabsTrigger>
          <TabsTrigger value="profile">Profile</TabsTrigger>
        </TabsList>

        <TabsContent value="holdings" className="space-y-2">
          {holdings === null ? (
            <p className="py-4 text-center text-xs text-muted-foreground">Loading…</p>
          ) : holdings.holdings.length === 0 ? (
            <p className="py-4 text-center text-xs text-muted-foreground">No holdings.</p>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full border-collapse">
                <thead>
                  <tr className="border-b border-border">
                    {["Symbol", "Qty", "Invested", "Mkt value", "P&L", "Strategy"].map((h) => (
                      <th
                        key={h}
                        className="px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-wider text-muted-foreground"
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {holdings.holdings.map((h, i) => (
                    <tr key={`${h.symbol}-${i}`} className="border-b border-border/30 last:border-b-0">
                      <td className="px-3 py-2 text-[12px]">
                        <span className="font-semibold text-foreground">{h.symbol}</span>{" "}
                        <span className="ml-1 text-[10px] text-muted-foreground">{h.name}</span>
                      </td>
                      <td className="px-3 py-2 text-[12px]">{h.qty}</td>
                      <td className="px-3 py-2 text-[12px]">{R(h.investedCents)}</td>
                      <td className="px-3 py-2 text-[12px]">{R(h.valueCents)}</td>
                      <td className={cn("px-3 py-2 text-[12px]", pnlCls(h.pnlCents))}>
                        {pnlStr(h.pnlCents)}
                      </td>
                      <td className="px-3 py-2 text-[12px] text-muted-foreground">{h.strategy || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </TabsContent>

        <TabsContent value="cash" className="space-y-2">
          {/* Cash reacting/deducting as AUM accrues (per the user's spec).
              Visual indicator = burn-down line over the AUM-fee accrual months. */}
          {accrual ? (
            <div className="h-44 w-full rounded-lg border border-border bg-card/60 p-2">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart
                  data={accrual.combined.months.map((m) => ({
                    month: m.month,
                    cumulative: m.cumulative_cents / 100,
                  }))}
                >
                  <XAxis dataKey="month" tick={{ fontSize: 10 }} />
                  <YAxis tick={{ fontSize: 10 }} />
                  <Tooltip
                    formatter={(v: number) => `R ${v.toLocaleString("en-ZA", { maximumFractionDigits: 0 })}`}
                  />
                  <Line
                    type="monotone"
                    dataKey="cumulative"
                    stroke="hsl(var(--primary))"
                    strokeWidth={2}
                    dot={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <p className="py-4 text-center text-xs text-muted-foreground">Loading cash-accrual…</p>
          )}
          <div className="grid grid-cols-3 gap-2">
            <Mini label="Cash on book" value={R(cashCents)} accent={cashCents < 0 ? "negative" : "default"} />
            <Mini
              label="Accrued this far"
              value={accrual ? R(accrual.combined.total_accrued_cents) : "—"}
              accent="positive"
            />
            <Mini label="Strategies" value={accrual ? String(accrual.strategies.length) : "—"} />
          </div>
        </TabsContent>

        <TabsContent value="allocations">
          {holdings && holdings.allocations.length > 0 ? (
            <div className="flex flex-col items-center gap-3 sm:flex-row">
              <div className="h-44 w-44">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={holdings.allocations}
                      dataKey={(d: { valueCents: number }) => d.valueCents / 100}
                      nameKey="sector"
                      innerRadius={40}
                      outerRadius={70}
                      paddingAngle={2}
                    >
                      {holdings.allocations.map((a, i) => (
                        <Cell key={a.sector} fill={PIE[i % PIE.length]} />
                      ))}
                    </Pie>
                    <Tooltip
                      formatter={(v: number) =>
                        `R ${v.toLocaleString("en-ZA", { maximumFractionDigits: 0 })}`
                      }
                    />
                  </PieChart>
                </ResponsiveContainer>
              </div>
              <ul className="flex-1 space-y-1 text-[12px]">
                {holdings.allocations.map((a, i) => (
                  <li key={a.sector} className="flex items-center gap-2">
                    <span className="h-2.5 w-2.5 rounded-sm" style={{ background: PIE[i % PIE.length] }} />
                    <span className="flex-1 text-foreground">{a.sector}</span>
                    <span className="text-muted-foreground">{R(a.valueCents)}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="py-4 text-center text-xs text-muted-foreground">No holdings to allocate.</p>
          )}
        </TabsContent>

        <TabsContent value="transactions">
          {detail?.transactions && detail.transactions.length > 0 ? (
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full border-collapse">
                <thead>
                  <tr className="border-b border-border">
                    <th className="px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                      Date
                    </th>
                    <th className="px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                      Description
                    </th>
                    <th className="px-3 py-2 text-right text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                      Amount
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {detail.transactions.map((t) => (
                    <tr key={t.id} className="border-b border-border/30 last:border-b-0">
                      <td className="px-3 py-2 text-[12px]">
                        {t.transaction_date ? new Date(t.transaction_date).toLocaleDateString("en-ZA") : "—"}
                      </td>
                      <td className="px-3 py-2 text-[12px]">{str(t.name) || str(t.description) || "—"}</td>
                      <td
                        className={cn(
                          "px-3 py-2 text-right text-[12px] font-medium",
                          t.direction === "credit" ? "text-success" : "text-foreground",
                        )}
                      >
                        {t.direction === "credit" ? "+" : "-"}
                        {R(Math.abs(Number(t.amount) || 0))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="py-4 text-center text-xs text-muted-foreground">No transactions.</p>
          )}
        </TabsContent>

        <TabsContent value="documents">
          {/* Phase A4 — documents are deferred to the storage/backend bucket;
              this tab is a stub so the Studio panel still has the affordance. */}
          <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border bg-card/40 p-6 text-center">
            <FileText className="h-6 w-6 text-muted-foreground" />
            <p className="text-sm font-semibold text-foreground">Documents</p>
            <p className="text-[11px] text-muted-foreground">
              Per-client document storage lands with the storage/backend bucket migration.
            </p>
            <Button variant="secondary" size="sm" disabled>
              <ImageIcon className="h-3.5 w-3.5" /> Upload (deferred)
            </Button>
          </div>
        </TabsContent>

        <TabsContent value="profile">
          <dl className="grid grid-cols-1 gap-1 overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-2">
            <Row label="Email" value={str(detail?.profile?.email)} />
            <Row label="Phone" value={str(detail?.profile?.phone_number)} />
            <Row label="Date of birth" value={str(detail?.profile?.date_of_birth)} />
            <Row label="Gender" value={str(detail?.profile?.gender)} />
            <Row label="ID number" value={str(detail?.profile?.id_number)} />
            <Row label="Currency" value={str(detail?.profile?.preferred_currency)} />
            <Row label="MINT number" value={str(detail?.profile?.mint_number)} />
            <Row label="Computershare" value={str(detail?.profile?.computershare_number)} />
            <Row label="Address" value={str(detail?.profile?.address)} />
            <Row
              label="Joined"
              value={
                detail?.profile?.created_at
                  ? new Date(String(detail?.profile?.created_at)).toLocaleDateString("en-ZA")
                  : "—"
              }
            />
            <Row label="Bank" value={str(detail?.onboarding?.bank_name)} />
            <Row label="Account #" value={str(detail?.onboarding?.bank_account_number)} />
            <Row label="Employer" value={str(detail?.onboarding?.employer_name)} />
            <Row label="Employment" value={str(detail?.onboarding?.employment_status)} />
            <Row label="Annual income" value={str(detail?.onboarding?.annual_income_amount)} />
            <Row
              label="Agreement"
              value={str(detail?.onboarding?.signed_agreement_url) !== "—" ? "Signed" : "—"}
            />
          </dl>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 bg-card px-3 py-2">
      <dt className="text-[11px] text-muted-foreground">{label}</dt>
      <dd className="truncate text-[12px] font-medium text-foreground">{value}</dd>
    </div>
  );
}

function Mini({
  label,
  value,
  accent,
}: { label: string; value: string; accent?: "default" | "positive" | "negative" }) {
  return (
    <div className="rounded-lg border border-border bg-card/60 px-3 py-2">
      <div className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</div>
      <div
        className={cn(
          "mt-0.5 truncate text-sm font-bold",
          accent === "positive" && "text-success",
          accent === "negative" && "text-destructive",
          (!accent || accent === "default") && "text-foreground",
        )}
      >
        {value}
      </div>
    </div>
  );
}
