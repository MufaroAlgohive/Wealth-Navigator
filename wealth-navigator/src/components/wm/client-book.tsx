"use client";

import { ChevronRight, Download, RotateCcw, Search, Sheet, Users } from "lucide-react";
import * as React from "react";

import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DataSourceBadge } from "@/components/oems/primitives/data-source-badge";
import { CASH_ASSET_NAME, CASH_ASSET_SYMBOL, CashAssetIcon } from "@/components/strategies/cash-asset-icon";
import { cn } from "@/lib/cn";
import { formatPct, formatZAR, formatZARExact } from "@/lib/format";

type Kyc = "not_initiated" | "pending" | "verified" | "rejected" | "resubmission_required";
interface ClientRow {
  id: string;
  name: string;
  email: string | null;
  phone_number: string | null;
  mint_number: string | null;
  avatar_url: string | null;
  is_test: boolean | null;
  kyc: Kyc;
  bankLinked: boolean;
  aumCents: number;
  ytdPct: number | null;
}
interface ClientList {
  ok: boolean;
  asOf: string | null;
  clients: ClientRow[];
  error?: string;
}
interface ClientDetail {
  ok: boolean;
  profile: Record<string, unknown>;
  onboarding: Record<string, unknown> | null;
  required: Record<string, unknown> | null;
  onboardingPack: unknown;
  kyc: Kyc;
  mandate: { available: boolean; data: Record<string, unknown> };
  household: Record<string, unknown>[];
  children: Record<string, unknown>[];
  holdings: Record<string, unknown>[];
  strategyReturns: Record<string, unknown>[];
  residuals: Record<string, unknown>[];
  aumFeeState: Record<string, unknown>[];
  transactions: Record<string, unknown>[];
  familyTransactions: Record<string, unknown>[];
  error?: string;
}

const FILTERS: Array<{ value: "all" | Kyc; label: string }> = [
  { value: "all", label: "All" },
  { value: "pending", label: "Pending" },
  { value: "verified", label: "Verified" },
  { value: "rejected", label: "Rejected" },
  { value: "resubmission_required", label: "Resubmit" },
  { value: "not_initiated", label: "Not started" },
];

function kycTone(status: Kyc) {
  if (status === "verified") return "border-success/30 bg-success/10 text-success";
  if (status === "rejected" || status === "resubmission_required")
    return "border-destructive/30 bg-destructive/10 text-destructive";
  if (status === "pending") return "border-warning/30 bg-warning/10 text-warning";
  return "border-border bg-muted text-muted-foreground";
}
function label(value: Kyc) {
  return value.replaceAll("_", " ");
}
function value(v: unknown) {
  return v == null || v === "" ? "—" : String(v);
}
function cents(v: unknown) {
  return Number(v) || 0;
}
function initials(name: string) {
  return (
    name
      .split(/\s+/)
      .map((part) => part[0])
      .join("")
      .slice(0, 2)
      .toUpperCase() || "?"
  );
}

export function WealthManagerClientBook() {
  const [data, setData] = React.useState<ClientList | null>(null);
  const [query, setQuery] = React.useState("");
  const [filter, setFilter] = React.useState<"all" | Kyc>("all");
  const [selected, setSelected] = React.useState<ClientRow | null>(null);
  const [detail, setDetail] = React.useState<ClientDetail | null>(null);

  React.useEffect(() => {
    void fetch("/api/wm/clients")
      .then((r) => r.json())
      .then(setData)
      .catch(() => setData({ ok: false, asOf: null, clients: [], error: "Client book unavailable" }));
  }, []);
  const open = React.useCallback((client: ClientRow) => {
    setSelected(client);
    setDetail(null);
    void fetch(`/api/wm/clients?user_id=${encodeURIComponent(client.id)}`)
      .then((r) => r.json())
      .then(setDetail)
      .catch(() => setDetail({ ok: false, error: "Client detail unavailable" } as ClientDetail));
  }, []);

  const clients = data?.clients ?? [];
  const visible = clients.filter((client) => {
    if (filter !== "all" && client.kyc !== filter) return false;
    const needle = query.trim().toLowerCase();
    return (
      !needle ||
      `${client.name} ${client.email ?? ""} ${client.mint_number ?? ""}`.toLowerCase().includes(needle)
    );
  });
  const totalAum = clients.reduce((sum, client) => sum + client.aumCents, 0) / 100;
  const count = (status: Kyc) => clients.filter((client) => client.kyc === status).length;

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label="Client book" value={formatZARExact(totalAum)} sub={`${clients.length} clients`} />
        <Kpi label="Verified" value={String(count("verified"))} sub="KYC complete" tone="positive" />
        <Kpi
          label="Pending review"
          value={String(count("pending"))}
          sub="requires attention"
          tone="warning"
        />
        <Kpi
          label="Resubmission"
          value={String(count("rejected") + count("resubmission_required"))}
          sub={data?.asOf ? `as of ${data.asOf}` : "live book"}
          tone="negative"
        />
      </div>

      <section className="overflow-hidden rounded-xl border border-[hsl(var(--glass-border))] bg-[hsl(var(--glass-bg))] shadow-[var(--glass-shadow)] backdrop-blur-xl">
        <div className="flex flex-col gap-2 border-b border-[hsl(var(--glass-border))] p-3 lg:flex-row lg:items-center">
          <div className="flex items-center gap-2">
            <Users className="h-4 w-4 text-primary" />
            <h2 className="text-sm font-semibold">My Client Book</h2>
            <DataSourceBadge source="supabase" db="retail" />
          </div>
          <div className="relative ml-auto w-full lg:w-64">
            <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search name, email or MINT #"
              className="h-8 pl-8 text-xs"
            />
          </div>
        </div>
        <div className="flex gap-1 overflow-x-auto border-b border-[hsl(var(--glass-border))] px-3 py-2">
          {FILTERS.map((item) => (
            <button
              key={item.value}
              type="button"
              onClick={() => setFilter(item.value)}
              className={cn(
                "whitespace-nowrap rounded-full border px-2.5 py-1 text-[10px] font-medium",
                filter === item.value
                  ? "border-primary/40 bg-primary/10 text-primary"
                  : "border-border text-muted-foreground hover:text-foreground",
              )}
            >
              {item.label}
              {item.value !== "all" ? ` · ${count(item.value)}` : ` · ${clients.length}`}
            </button>
          ))}
        </div>
        {!data ? (
          <Empty text="Loading the client book…" />
        ) : !data.ok ? (
          <Empty text={data.error ?? "Client book unavailable"} />
        ) : visible.length === 0 ? (
          <Empty text="No clients match this filter." />
        ) : (
          <div className="divide-y divide-[hsl(var(--glass-border))]">
            {visible.map((client) => (
              <button
                key={client.id}
                type="button"
                onClick={() => open(client)}
                className="grid w-full grid-cols-[auto_1fr_auto] items-center gap-3 px-3 py-2.5 text-left hover:bg-foreground/[0.03] lg:grid-cols-[auto_1.4fr_1fr_110px_100px_24px]"
              >
                <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/15 text-[10px] font-bold text-primary">
                  {initials(client.name)}
                </div>
                <div className="min-w-0">
                  <div className="truncate text-xs font-semibold">
                    {client.name}
                    {client.is_test ? (
                      <span className="ml-1.5 text-[8px] text-muted-foreground">TEST</span>
                    ) : null}
                  </div>
                  <div className="truncate text-[10px] text-muted-foreground">
                    {client.mint_number ?? client.email ?? "No account reference"}
                  </div>
                </div>
                <div className="hidden truncate text-[10.5px] text-muted-foreground lg:block">
                  {client.email ?? client.phone_number ?? "—"}
                </div>
                <div className="hidden text-right font-mono text-[11px] lg:block">
                  {formatZARExact(client.aumCents / 100)}
                </div>
                <div className="hidden text-right font-mono text-[11px] lg:block">
                  {client.ytdPct == null ? "—" : formatPct(client.ytdPct, 2)}
                </div>
                <Badge
                  variant="outline"
                  className={cn("justify-self-end text-[8px] uppercase", kycTone(client.kyc))}
                >
                  {label(client.kyc)}
                </Badge>
                <ChevronRight className="hidden h-3.5 w-3.5 text-muted-foreground lg:block" />
              </button>
            ))}
          </div>
        )}
      </section>

      <Dialog
        open={!!selected}
        onOpenChange={(openState) => {
          if (!openState) {
            setSelected(null);
            setDetail(null);
          }
        }}
      >
        <DialogContent className="max-h-[90vh] max-w-5xl overflow-y-auto p-0">
          {selected ? <ClientDetailView client={selected} detail={detail} /> : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ClientDetailView({ client, detail }: { client: ClientRow; detail: ClientDetail | null }) {
  return (
    <div>
      <DialogHeader className="border-b border-border p-5">
        <div className="flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-full bg-primary/15 text-sm font-bold text-primary">
            {initials(client.name)}
          </div>
          <div className="min-w-0 flex-1">
            <DialogTitle>{client.name}</DialogTitle>
            <p className="truncate text-xs text-muted-foreground">
              {client.email ?? "—"} · {client.mint_number ?? "No MINT number"}
            </p>
          </div>
          <Badge variant="outline" className={cn("uppercase", kycTone(detail?.kyc ?? client.kyc))}>
            {label(detail?.kyc ?? client.kyc)}
          </Badge>
        </div>
      </DialogHeader>
      {!detail ? (
        <Empty text="Loading the complete client record…" />
      ) : !detail.ok ? (
        <Empty text={detail.error ?? "Client detail unavailable"} />
      ) : (
        <Tabs defaultValue="overview" className="p-5">
          <TabsList className="h-auto flex-wrap justify-start">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="kyc">KYC</TabsTrigger>
            <TabsTrigger value="mandate">Mandate</TabsTrigger>
            <TabsTrigger value="family">Family · {detail.children.length}</TabsTrigger>
            <TabsTrigger value="portfolio">Portfolio · {detail.holdings.length}</TabsTrigger>
            <TabsTrigger value="activity">Activity</TabsTrigger>
            <TabsTrigger value="documents">Documents</TabsTrigger>
          </TabsList>
          <TabsContent value="overview">
            <FieldGrid
              source={detail.profile}
              fields={[
                "first_name",
                "last_name",
                "email",
                "phone_number",
                "date_of_birth",
                "gender",
                "id_number",
                "mint_number",
                "computershare_number",
                "address",
                "preferred_currency",
                "created_at",
              ]}
            />
          </TabsContent>
          <TabsContent value="kyc" className="space-y-3">
            <FieldGrid
              source={{ ...detail.onboarding, ...detail.required }}
              fields={[
                "kyc_status",
                "sumsub_review_answer",
                "sumsub_review_status",
                "kyc_verified",
                "kyc_pending",
                "kyc_needs_resubmission",
                "kyc_verified_at",
                "bank_linked",
                "bank_name",
                "bank_account_number",
                "bank_branch_code",
                "employment_status",
                "employer_name",
                "annual_income_amount",
              ]}
            />
            <p className="text-[10px] text-muted-foreground">
              Read-only parity phase. Verified/pending/rejected transitions will be enabled after audit
              logging is in place.
            </p>
          </TabsContent>
          <TabsContent value="mandate">
            {detail.mandate.available ? (
              <FieldGrid source={detail.mandate.data} fields={Object.keys(detail.mandate.data)} />
            ) : (
              <Empty text="No signed mandate data is stored for this client." />
            )}
          </TabsContent>
          <TabsContent value="family">
            <Family rows={detail.children} />
          </TabsContent>
          <TabsContent value="portfolio">
            <PortfolioWorkspace detail={detail} />
          </TabsContent>
          <TabsContent value="activity">
            <Activity rows={[...detail.transactions, ...detail.familyTransactions]} />
          </TabsContent>
          <TabsContent value="documents">
            <Documents detail={detail} />
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}

function FieldGrid({ source, fields }: { source: Record<string, unknown> | null; fields: string[] }) {
  return (
    <dl className="grid grid-cols-1 gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-2">
      {fields.map((field) => (
        <div key={field} className="min-w-0 bg-card px-3 py-2">
          <dt className="text-[9px] uppercase tracking-wide text-muted-foreground">
            {field.replaceAll("_", " ")}
          </dt>
          <dd className="mt-0.5 break-words text-xs">
            {typeof source?.[field] === "object" ? JSON.stringify(source?.[field]) : value(source?.[field])}
          </dd>
        </div>
      ))}
    </dl>
  );
}
function Family({ rows }: { rows: Record<string, unknown>[] }) {
  return rows.length ? (
    <div className="space-y-2">
      {rows.map((child) => (
        <div key={String(child.id)} className="rounded-lg border border-border p-3">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs font-semibold">
                {value(child.first_name)} {value(child.last_name)}
              </p>
              <p className="text-[10px] text-muted-foreground">
                {value(child.relationship)} · {value(child.mint_number)}
              </p>
            </div>
            <Badge variant="outline" className="text-[8px] uppercase">
              {value(child.certificate_verification_status)}
            </Badge>
          </div>
          <div className="mt-2 grid grid-cols-2 gap-2 text-[10px] text-muted-foreground lg:grid-cols-4">
            <span>DOB: {value(child.date_of_birth)}</span>
            <span>ID: {value(child.id_number)}</span>
            <span>Balance: {formatZAR(cents(child.available_balance) / 100)}</span>
            <span>Computershare: {value(child.computershare_number)}</span>
          </div>
        </div>
      ))}
    </div>
  ) : (
    <Empty text="No children are linked to this client." />
  );
}
type PortfolioMode = "strategies" | "single";
type PortfolioView = "holdings" | "spreadsheet";

function holdingScope(row: Record<string, unknown>) {
  return `${String(row.user_id ?? "")}|${String(row.family_member_id ?? "")}|${String(row.strategy_id ?? "")}`;
}

function PortfolioWorkspace({ detail }: { detail: ClientDetail }) {
  const strategyRows = detail.holdings.filter((row) => row.strategy_id);
  const singleRows = detail.holdings.filter((row) => !row.strategy_id);
  const [mode, setMode] = React.useState<PortfolioMode>(strategyRows.length ? "strategies" : "single");
  const [view, setView] = React.useState<PortfolioView>("holdings");
  const scopes = React.useMemo(() => {
    const found = new Map<string, { key: string; name: string; rows: Record<string, unknown>[] }>();
    for (const row of strategyRows) {
      const key = holdingScope(row);
      const item = found.get(key) ?? { key, name: String(row.strategyName ?? "Strategy"), rows: [] };
      item.rows.push(row);
      found.set(key, item);
    }
    return [...found.values()];
  }, [detail.holdings]);
  const [scopeKey, setScopeKey] = React.useState(scopes[0]?.key ?? "");
  React.useEffect(() => {
    if (!scopes.some((scope) => scope.key === scopeKey)) setScopeKey(scopes[0]?.key ?? "");
  }, [scopeKey, scopes]);
  const activeScope = scopes.find((scope) => scope.key === scopeKey) ?? scopes[0];
  const rows = mode === "strategies" ? activeScope?.rows ?? [] : singleRows;
  const latestReturn = mode === "strategies"
    ? [...detail.strategyReturns]
        .filter((row) => String(row.strategy_id ?? "") === String(rows[0]?.strategy_id ?? ""))
        .sort((a, b) => String(b.as_of_date ?? "").localeCompare(String(a.as_of_date ?? "")))[0]
    : null;
  const residualCents = mode === "strategies"
    ? detail.residuals
        .filter((row) => holdingScope(row) === scopeKey)
        .reduce((sum, row) => sum + cents(row.balance_cents), 0)
    : 0;
  const transactionIds = new Set(rows.map((row) => String(row.transaction_id ?? "")).filter(Boolean));
  const reserveCents = detail.transactions
    .filter((row) => transactionIds.has(String(row.id ?? "")))
    .reduce((sum, row) => sum + Math.max(0, cents(row.buffer_cents) - cents(row.buffer_consumed_cents)), 0);
  const assetRows =
    mode === "strategies" && residualCents > 0
      ? [
          ...rows,
          {
            id: `cash-asset-${scopeKey}`,
            symbol: CASH_ASSET_SYMBOL,
            securityName: CASH_ASSET_NAME,
            strategyName: activeScope?.name,
            quantity: 1,
            investedCents: residualCents,
            marketValueCents: residualCents,
            averageCostCents: residualCents,
            priceCents: residualCents,
            isCashAsset: true,
          },
        ]
      : rows;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="inline-flex rounded-lg border border-border bg-muted/30 p-0.5">
          <Toggle active={mode === "strategies"} onClick={() => setMode("strategies")} disabled={!strategyRows.length}>
            Strategies · {scopes.length}
          </Toggle>
          <Toggle active={mode === "single"} onClick={() => setMode("single")} disabled={!singleRows.length}>
            Single securities · {singleRows.length}
          </Toggle>
        </div>
        <div className="inline-flex rounded-lg border border-border bg-muted/30 p-0.5">
          <Toggle active={view === "holdings"} onClick={() => setView("holdings")}>Holdings</Toggle>
          <Toggle active={view === "spreadsheet"} onClick={() => setView("spreadsheet")}>
            <Sheet className="mr-1 h-3 w-3" /> Spreadsheet
          </Toggle>
        </div>
      </div>

      {mode === "strategies" && scopes.length > 1 ? (
        <div className="flex flex-wrap gap-1.5">
          {scopes.map((scope) => (
            <button key={scope.key} type="button" onClick={() => setScopeKey(scope.key)}
              className={cn("rounded-full border px-3 py-1 text-[10px] font-medium",
                scope.key === scopeKey ? "border-primary/40 bg-primary/10 text-primary" : "border-border text-muted-foreground hover:text-foreground")}
            >{scope.name}</button>
          ))}
        </div>
      ) : null}

      {mode === "strategies" && rows.length ? (
        <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
          <MiniMetric label="Basket" value={activeScope?.name ?? "—"} />
          <MiniMetric label="Latest value" value={formatZAR(cents(latestReturn?.basket_value) / 100)} />
          <MiniMetric label="YTD" value={latestReturn?.ytd_pct == null ? "—" : formatPct(cents(latestReturn.ytd_pct), 2)} />
          <MiniMetric
            label="CA cash asset"
            value={formatZAR(residualCents / 100)}
            sub={`Residual in strategy · execution reserve excluded (${formatZAR(reserveCents / 100)})`}
          />
        </div>
      ) : null}

      {view === "spreadsheet" ? <PortfolioSpreadsheet rows={assetRows} title={activeScope?.name ?? "Single Securities"} /> : <Portfolio rows={assetRows} />}
    </div>
  );
}

function Toggle({ active, disabled, onClick, children }: { active: boolean; disabled?: boolean; onClick: () => void; children: React.ReactNode }) {
  return <button type="button" disabled={disabled} onClick={onClick} className={cn("inline-flex items-center rounded-md px-2.5 py-1.5 text-[10px] font-medium transition-colors", active ? "bg-primary text-primary-foreground shadow-sm" : "text-muted-foreground hover:text-foreground", disabled && "cursor-not-allowed opacity-35")}>{children}</button>;
}

function MiniMetric({ label: title, value: display, sub }: { label: string; value: string; sub?: string }) {
  return <div className="rounded-lg border border-border bg-muted/20 px-3 py-2"><p className="text-[8px] uppercase tracking-wider text-muted-foreground">{title}</p><p className="mt-0.5 truncate font-mono text-xs font-semibold">{display}</p>{sub ? <p className="mt-0.5 truncate text-[8px] text-muted-foreground">{sub}</p> : null}</div>;
}

function Portfolio({ rows }: { rows: Record<string, unknown>[] }) {
  return rows.length ? (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full text-[11px]">
        <thead className="bg-muted/40 text-[9px] uppercase text-muted-foreground">
          <tr>
            <th className="p-2 text-left">Security</th>
            <th className="p-2 text-left">Mandate</th>
            <th className="p-2 text-right">Qty</th>
            <th className="p-2 text-right">Invested</th>
            <th className="p-2 text-right">Value</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={`${row.id ?? row.symbol}-${index}`} className="border-t border-border">
              <td className="p-2">
                {row.isCashAsset ? <CashAssetIcon className="mr-2 inline-flex h-7 w-7 align-middle" /> : null}
                <b className={cn(Boolean(row.isCashAsset) && "text-success")}>{value(row.symbol)}</b>
                <span className="ml-1 text-muted-foreground">{value(row.securityName)}</span>
              </td>
              <td className="p-2 text-muted-foreground">{value(row.strategyName)}</td>
              <td className="p-2 text-right font-mono">{value(row.quantity)}</td>
              <td className="p-2 text-right font-mono">{formatZAR(cents(row.investedCents) / 100)}</td>
              <td className="p-2 text-right font-mono">{formatZAR(cents(row.marketValueCents) / 100)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  ) : (
    <Empty text="No active holdings." />
  );
}

interface SheetRow {
  id: string;
  symbol: string;
  name: string;
  quantity: number;
  averageFill: number;
  marketPrice: number;
  isCashAsset: boolean;
}
function sheetRows(rows: Record<string, unknown>[]): SheetRow[] {
  return rows.map((row, index) => ({
    id: String(row.id ?? `${row.symbol ?? "security"}-${index}`),
    symbol: String(row.symbol ?? "—"),
    name: String(row.securityName ?? "—"),
    quantity: cents(row.quantity),
    averageFill: cents(row.averageCostCents ?? row.averageFillCents ?? row.avg_fill) / 100,
    marketPrice: cents(row.priceCents) / 100,
    isCashAsset: Boolean(row.isCashAsset),
  }));
}
function PortfolioSpreadsheet({ rows, title }: { rows: Record<string, unknown>[]; title: string }) {
  const seed = React.useMemo(() => sheetRows(rows), [rows]);
  const [grid, setGrid] = React.useState(seed);
  React.useEffect(() => setGrid(seed), [seed]);
  const edit = (id: string, field: "quantity" | "averageFill" | "marketPrice", raw: string) => {
    const number = Number(raw);
    setGrid((current) => current.map((row) => row.id === id ? { ...row, [field]: Number.isFinite(number) ? number : 0 } : row));
  };
  const download = () => {
    const csv = [
      ["Symbol", "Security", "Quantity", "Average Fill (ZAR)", "Market Price (ZAR)", "Invested (ZAR)", "Market Value (ZAR)", "P&L (ZAR)", "Return (%)"],
      ...grid.map((row) => {
        const invested = row.quantity * row.averageFill, market = row.quantity * row.marketPrice;
        return [row.symbol, row.name, row.quantity, row.averageFill, row.marketPrice, invested, market, market - invested, invested ? ((market / invested) - 1) * 100 : 0];
      }),
    ].map((line) => line.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(",")).join("\r\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const anchor = document.createElement("a");anchor.href = url;anchor.download = `${title.replace(/[^a-z0-9]+/gi, "-")}-portfolio.csv`;anchor.click();URL.revokeObjectURL(url);
  };
  if (!grid.length) return <Empty text="No holdings are available for this spreadsheet." />;
  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <div className="flex items-center justify-between gap-2 border-b border-border bg-muted/20 px-3 py-2">
        <div><p className="text-[10px] font-semibold">{title} spreadsheet</p><p className="text-[8px] text-muted-foreground">Only this selected basket’s securities are included. Editable values recalculate immediately.</p></div>
        <div className="flex gap-1">
          <button type="button" onClick={() => setGrid(seed)} className="inline-flex h-7 items-center gap-1 rounded-md border border-border px-2 text-[9px] text-muted-foreground hover:text-foreground"><RotateCcw className="h-3 w-3" />Reset</button>
          <button type="button" onClick={download} className="inline-flex h-7 items-center gap-1 rounded-md bg-primary px-2 text-[9px] text-primary-foreground"><Download className="h-3 w-3" />Download</button>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[850px] text-[10px]">
          <thead className="bg-muted/40 text-[8px] uppercase text-muted-foreground"><tr><th className="p-2 text-left">Security</th><th className="p-2 text-right">Quantity</th><th className="p-2 text-right">Average fill</th><th className="p-2 text-right">Market price</th><th className="p-2 text-right">Invested</th><th className="p-2 text-right">Market value</th><th className="p-2 text-right">P&amp;L</th><th className="p-2 text-right">Return</th></tr></thead>
          <tbody>{grid.map((row) => { const invested=row.quantity*row.averageFill, market=row.quantity*row.marketPrice, pnl=market-invested, ret=invested?pnl/invested*100:0;return <tr key={row.id} className="border-t border-border"><td className="p-2">{row.isCashAsset ? <CashAssetIcon className="mr-2 inline-flex h-7 w-7 align-middle" /> : null}<b className={cn(row.isCashAsset && "text-success")}>{row.symbol}</b><span className="ml-1 text-muted-foreground">{row.name}</span></td>{(["quantity","averageFill","marketPrice"] as const).map((field)=><td key={field} className="p-1.5 text-right"><input type="number" step="any" value={row[field]} onChange={(event)=>edit(row.id,field,event.target.value)} className="h-7 w-24 rounded border border-border bg-background px-1.5 text-right font-mono outline-none focus:border-primary" /></td>)}<td className="p-2 text-right font-mono">{formatZAR(invested)}</td><td className="p-2 text-right font-mono">{formatZAR(market)}</td><td className={cn("p-2 text-right font-mono",pnl>=0?"text-success":"text-destructive")}>{formatZAR(pnl)}</td><td className={cn("p-2 text-right font-mono",ret>=0?"text-success":"text-destructive")}>{formatPct(ret,2)}</td></tr>})}</tbody>
        </table>
      </div>
    </div>
  );
}
function Activity({ rows }: { rows: Record<string, unknown>[] }) {
  return rows.length ? (
    <div className="divide-y divide-border rounded-lg border border-border">
      {rows.map((row, index) => (
        <div key={`${row.id ?? "activity"}-${index}`} className="flex items-center justify-between gap-3 p-3">
          <div>
            <p className="text-xs">{value(row.name ?? row.description ?? row.type)}</p>
            <p className="text-[10px] text-muted-foreground">
              {value(row.transaction_date ?? row.created_at)} · {value(row.status)}
            </p>
          </div>
          <span className="font-mono text-xs">{formatZAR(cents(row.amount))}</span>
        </div>
      ))}
    </div>
  ) : (
    <Empty text="No recorded activity." />
  );
}
function Documents({ detail }: { detail: ClientDetail }) {
  const docs = [
    { label: "Signed agreement", url: detail.onboarding?.signed_agreement_url },
    ...detail.children.map((child) => ({
      label: `Certificate · ${value(child.first_name)} ${value(child.last_name)}`,
      url: child.certificate_url,
    })),
  ].filter((doc) => doc.url);
  return docs.length ? (
    <div className="space-y-2">
      {docs.map((doc) => (
        <a
          key={String(doc.url)}
          href={String(doc.url)}
          target="_blank"
          rel="noreferrer"
          className="flex items-center justify-between rounded-lg border border-border p-3 text-xs hover:bg-muted/40"
        >
          <span>{doc.label}</span>
          <ChevronRight className="h-3.5 w-3.5" />
        </a>
      ))}
    </div>
  ) : (
    <Empty text="No document links are available for this client." />
  );
}
function Kpi({
  label: title,
  value: display,
  sub,
  tone,
}: { label: string; value: string; sub: string; tone?: "positive" | "warning" | "negative" }) {
  return (
    <div className="rounded-xl border border-[hsl(var(--glass-border))] bg-[hsl(var(--glass-bg))] p-3 shadow-[var(--glass-shadow)] backdrop-blur-xl">
      <p className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">{title}</p>
      <p
        className={cn(
          "mt-1 font-mono text-xl font-bold",
          tone === "positive" && "text-success",
          tone === "warning" && "text-warning",
          tone === "negative" && "text-destructive",
        )}
      >
        {display}
      </p>
      <p className="text-[10px] text-muted-foreground">{sub}</p>
    </div>
  );
}
function Empty({ text }: { text: string }) {
  return <div className="p-10 text-center text-xs text-muted-foreground">{text}</div>;
}
