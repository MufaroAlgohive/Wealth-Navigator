"use client";

import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleDollarSign,
  Clock3,
  Database,
  ExternalLink,
  Gift,
  History,
  PackageCheck,
  RefreshCw,
  Search,
  ShieldCheck,
  TimerReset,
  UserRound,
  XCircle,
} from "lucide-react";
import * as React from "react";

import { cn } from "@/lib/cn";

type Party = { id: string | null; name: string | null; email: string | null; kind?: string; mintNumber?: string | null };
type Asset = {
  type: string;
  key: string | null;
  symbol: string | null;
  name: string;
  logoUrl: string | null;
  constituents: Array<Record<string, unknown>>;
};
type GiftEvent = {
  id: string | null;
  fromStatus: string | null;
  toStatus: string | null;
  actor: string | null;
  reason: string | null;
  payload: Record<string, unknown> | null;
  createdAt: string | null;
};
type GiftRecord = {
  id: string;
  recordId: string;
  source: "authorization" | "claim";
  status: string;
  claimState: string;
  gifter: Party;
  recipient: Party;
  asset: Asset;
  registry: null | {
    id: string | null;
    title: string | null;
    occasion: string | null;
    beneficiaryType: string | null;
    status: string | null;
    eventDate: string | null;
    expiresAt: string | null;
  };
  quantity: number | null;
  amountRands: number | null;
  reservedRands: number | null;
  paidRands: number | null;
  livePriceRands: number | null;
  fillPriceRands: number | null;
  priceSource: string | null;
  driftBps: number | null;
  paymentMethod: string | null;
  message?: string | null;
  expiresAt: string | null;
  timestamps: Record<string, string | null>;
  references: Record<string, string | null>;
  environment: "live" | "uat";
  execution: { reachedOrderBook: boolean; state: string; reason: string };
  events: GiftEvent[];
};
type WishlistRecord = {
  id: string;
  title: string;
  occasion: string | null;
  status: string;
  beneficiaryType: string;
  creator: Party;
  beneficiary: Party;
  eventDate: string | null;
  expiresAt: string | null;
  createdAt: string | null;
  environment: "live" | "uat";
  itemCount: number;
  contributionCount: number;
  contributedRands: number;
  targetQuantity: number;
  filledQuantity: number;
  items: Array<{
    id: string;
    type: string;
    symbol: string | null;
    name: string;
    logoUrl: string | null;
    targetQuantity: number;
    filledQuantity: number;
    reservedQuantity: number;
    status: string;
    contributionCount: number;
    contributedRands: number;
  }>;
};
type Payload = {
  ok: boolean;
  source?: string;
  generatedAt?: string;
  gifts?: GiftRecord[];
  wishlists?: WishlistRecord[];
  notices?: string[];
  lineage?: Array<{ table: string; purpose: string }>;
  error?: string;
};

const ACTIVE = new Set([
  "authorized",
  "parked",
  "working",
  "pending_claim",
  "pending_registration",
  "pending_gifter_approval",
]);
const SUCCESS = new Set(["claimed", "filled", "settled", "delivered"]);
const FAILED = new Set([
  "expired",
  "cancelled",
  "auto_cancelled",
  "rejected",
  "failed",
  "refunded",
  "reservation_expired",
]);
const FILTERS = [
  ["all", "All"],
  ["active", "Active"],
  ["completed", "Claimed / filled"],
  ["closed", "Expired / failed"],
] as const;
const SKELETON_ROWS = [
  "gift-loading-1",
  "gift-loading-2",
  "gift-loading-3",
  "gift-loading-4",
  "gift-loading-5",
  "gift-loading-6",
  "gift-loading-7",
];

function formatMoney(value: number | null) {
  if (value == null || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("en-ZA", {
    style: "currency",
    currency: "ZAR",
    minimumFractionDigits: 2,
  }).format(value);
}

function formatDate(value: string | null, withTime = true) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-ZA", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    ...(withTime ? { hour: "2-digit", minute: "2-digit", second: "2-digit" } : {}),
  }).format(date);
}

function statusLabel(status: string) {
  return status.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function StatusPill({ status }: { status: string }) {
  const good = SUCCESS.has(status);
  const bad = FAILED.has(status);
  const active = ACTIVE.has(status);
  const Icon = good ? CheckCircle2 : bad ? XCircle : active ? Clock3 : ShieldCheck;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-1 text-[9px] font-bold uppercase tracking-[0.12em]",
        good && "border-success/25 bg-success/10 text-success",
        bad && "border-destructive/25 bg-destructive/10 text-destructive",
        active && "border-warning/25 bg-warning/10 text-warning",
        !good && !bad && !active && "border-border bg-muted/40 text-muted-foreground",
      )}
    >
      <Icon className="h-3 w-3" />
      {statusLabel(status)}
    </span>
  );
}

function OrderBookBadge({ execution }: { execution: GiftRecord["execution"] }) {
  const tone = execution.reachedOrderBook
    ? "border-success/25 bg-success/10 text-success"
    : execution.state === "legacy_direct_allocation" || execution.state === "skipped"
      ? "border-muted-foreground/25 bg-muted text-muted-foreground"
      : "border-destructive/25 bg-destructive/10 text-destructive";
  const label = execution.reachedOrderBook
    ? "Order-book ✓"
    : execution.state === "legacy_direct_allocation"
      ? "Pre-fix, no order"
      : execution.state === "skipped"
        ? "Forwarding off"
        : "Not routed";
  return (
    <span
      title={execution.reason}
      className={cn("inline-flex rounded-full border px-2 py-0.5 text-[8px] font-semibold", tone)}
    >
      {label}
    </span>
  );
}

function EnvironmentPill({ environment }: { environment: "live" | "uat" }) {
  return (
    <span
      className={cn(
        "inline-flex rounded-full border px-2 py-1 text-[8px] font-bold uppercase tracking-[0.14em]",
        environment === "live"
          ? "border-success/25 bg-success/10 text-success"
          : "border-warning/25 bg-warning/10 text-warning",
      )}
    >
      {environment}
    </span>
  );
}

function Countdown({ expiresAt, status, now }: { expiresAt: string | null; status: string; now: number }) {
  if (!expiresAt || !ACTIVE.has(status)) return <span className="text-muted-foreground">—</span>;
  const remaining = new Date(expiresAt).getTime() - now;
  if (remaining <= 0) return <span className="font-semibold text-destructive">Expired</span>;
  const totalMinutes = Math.floor(remaining / 60_000);
  const days = Math.floor(totalMinutes / 1_440);
  const hours = Math.floor((totalMinutes % 1_440) / 60);
  const minutes = totalMinutes % 60;
  return (
    <span
      className={cn(
        "font-mono text-[10px] font-semibold",
        days === 0 && hours < 2 ? "text-warning" : "text-foreground",
      )}
    >
      {days > 0 ? `${days}d ` : ""}
      {hours}h {minutes}m
    </span>
  );
}

function Metric({
  label,
  value,
  icon: Icon,
  tone = "primary",
}: {
  label: string;
  value: string | number;
  icon: typeof Gift;
  tone?: "primary" | "success" | "warning" | "danger";
}) {
  return (
    <div className="glass-panel rounded-xl p-3">
      <div className="flex items-center gap-2">
        <span
          className={cn(
            "rounded-lg p-1.5",
            tone === "primary" && "bg-primary/10 text-primary",
            tone === "success" && "bg-success/10 text-success",
            tone === "warning" && "bg-warning/10 text-warning",
            tone === "danger" && "bg-destructive/10 text-destructive",
          )}
        >
          <Icon className="h-3.5 w-3.5" />
        </span>
        <span className="text-[9px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          {label}
        </span>
      </div>
      <p className="mt-2 text-xl font-semibold tracking-tight">{value}</p>
    </div>
  );
}

function PartyCell({ party }: { party: Party }) {
  return (
    <div className="min-w-0">
      <p className="truncate text-[11px] font-semibold">{party.name || "Unknown"}</p>
      <p className="truncate text-[9px] text-muted-foreground">
        {party.mintNumber || party.email || party.id || "No identifier"}
      </p>
    </div>
  );
}

function AssetLogo({ logoUrl, label, size = 28 }: { logoUrl: string | null; label: string; size?: number }) {
  const [failed, setFailed] = React.useState(false);
  const initial = (label || "?").trim().charAt(0).toUpperCase() || "?";
  if (!logoUrl || failed) {
    return (
      <div
        className="flex flex-shrink-0 items-center justify-center rounded-full bg-primary/10 font-bold text-primary"
        style={{ width: size, height: size, fontSize: size * 0.4 }}
      >
        {initial}
      </div>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={logoUrl}
      alt={label}
      onError={() => setFailed(true)}
      className="flex-shrink-0 rounded-full border border-border/60 bg-white object-contain"
      style={{ width: size, height: size }}
    />
  );
}

function KeyValue({ label, value, mono = false }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="border-b border-border/60 py-2 last:border-0">
      <p className="text-[8px] font-bold uppercase tracking-[0.14em] text-muted-foreground">{label}</p>
      <div className={cn("mt-0.5 break-words text-[10px] font-medium", mono && "font-mono text-[9px]")}>
        {value || "—"}
      </div>
    </div>
  );
}

function GiftDetail({ gift, now, onClose }: { gift: GiftRecord; now: number; onClose: () => void }) {
  const timestamps = Object.entries(gift.timestamps).filter(([, value]) => value);
  const references = Object.entries(gift.references).filter(([, value]) => value);
  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-black/55 backdrop-blur-[2px]"
      onMouseDown={onClose}
    >
      <aside
        className="h-full w-full max-w-2xl overflow-y-auto border-l border-border bg-background shadow-2xl"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="sticky top-0 z-10 flex items-start justify-between border-b border-border bg-background/95 p-5 backdrop-blur">
          <div>
            <div className="mb-2 flex items-center gap-2">
              <StatusPill status={gift.status} />
              <EnvironmentPill environment={gift.environment} />
              <span className="text-[9px] uppercase tracking-wider text-muted-foreground">{gift.source}</span>
            </div>
            <h2 className="text-xl font-semibold">{gift.asset.name}</h2>
            <p className="mt-1 font-mono text-[9px] text-muted-foreground">{gift.recordId}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-border p-2 text-muted-foreground hover:bg-muted"
          >
            <XCircle className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-4 p-5">
          <section className="grid gap-3 sm:grid-cols-3">
            <div className="rounded-xl border border-border bg-card p-3">
              <p className="text-[8px] uppercase tracking-wider text-muted-foreground">Gift value</p>
              <p className="mt-1 text-base font-semibold">{formatMoney(gift.amountRands)}</p>
            </div>
            <div className="rounded-xl border border-border bg-card p-3">
              <p className="text-[8px] uppercase tracking-wider text-muted-foreground">Claim / delivery</p>
              <p className="mt-1 text-xs font-semibold">{statusLabel(gift.claimState)}</p>
            </div>
            <div className="rounded-xl border border-border bg-card p-3">
              <p className="text-[8px] uppercase tracking-wider text-muted-foreground">Time remaining</p>
              <p className="mt-1">
                <Countdown expiresAt={gift.expiresAt} status={gift.status} now={now} />
              </p>
            </div>
          </section>

          <section className="glass-panel rounded-xl p-4">
            <h3 className="flex items-center gap-2 text-xs font-bold">
              <UserRound className="h-4 w-4 text-primary" />
              Who gifted whom
            </h3>
            <div className="mt-3 grid items-center gap-3 sm:grid-cols-[1fr_auto_1fr]">
              <div className="rounded-lg bg-muted/40 p-3">
                <p className="text-[8px] uppercase text-muted-foreground">Gifter</p>
                <PartyCell party={gift.gifter} />
              </div>
              <ArrowRight className="mx-auto h-4 w-4 text-primary" />
              <div className="rounded-lg bg-muted/40 p-3">
                <p className="text-[8px] uppercase text-muted-foreground">Recipient</p>
                <PartyCell party={gift.recipient} />
              </div>
            </div>
            {gift.message && (
              <div className="mt-3 rounded-lg border border-primary/15 bg-primary/5 p-3 text-[10px] italic">
                “{gift.message}”
              </div>
            )}
          </section>

          <section className="grid gap-4 lg:grid-cols-2">
            <div className="glass-panel rounded-xl p-4">
              <h3 className="flex items-center gap-2 text-xs font-bold">
                <Gift className="h-4 w-4 text-primary" />
                Asset and money
              </h3>
              <div className="mt-2">
                <KeyValue
                  label="Asset"
                  value={`${gift.asset.symbol ? `${gift.asset.symbol} · ` : ""}${gift.asset.name}`}
                />
                <KeyValue
                  label="Type / quantity"
                  value={`${statusLabel(gift.asset.type)} · ${gift.quantity ?? "—"}`}
                />
                <KeyValue
                  label="Reserved / paid"
                  value={`${formatMoney(gift.reservedRands)} / ${formatMoney(gift.paidRands)}`}
                />
                <KeyValue
                  label="Live / fill price"
                  value={`${formatMoney(gift.livePriceRands)} / ${formatMoney(gift.fillPriceRands)}`}
                />
                <KeyValue
                  label="Price source / tolerance"
                  value={`${gift.priceSource || "—"} / ${gift.driftBps == null ? "—" : `${gift.driftBps} bps`}`}
                />
                <KeyValue
                  label="Payment method"
                  value={gift.paymentMethod ? statusLabel(gift.paymentMethod) : "—"}
                />
              </div>
            </div>
            <div className="glass-panel rounded-xl p-4">
              <h3 className="flex items-center gap-2 text-xs font-bold">
                <Database className="h-4 w-4 text-primary" />
                Registry and references
              </h3>
              <div className="mt-2">
                <KeyValue label="Registry" value={gift.registry?.title || "Direct gift"} />
                <KeyValue
                  label="Order-book routing"
                  value={`${statusLabel(gift.execution.state)} · ${gift.execution.reason}`}
                />
                <KeyValue
                  label="Occasion / beneficiary"
                  value={
                    gift.registry
                      ? `${gift.registry.occasion || "—"} / ${gift.registry.beneficiaryType || "—"}`
                      : "—"
                  }
                />
                <KeyValue label="Event date" value={formatDate(gift.registry?.eventDate || null, false)} />
                {references.map(([key, value]) => (
                  <KeyValue key={key} label={statusLabel(key)} value={value} mono />
                ))}
              </div>
            </div>
          </section>

          {gift.asset.constituents.length > 0 && (
            <section className="glass-panel rounded-xl p-4">
              <h3 className="flex items-center gap-2 text-xs font-bold">
                <PackageCheck className="h-4 w-4 text-primary" />
                Basket constituents ({gift.asset.constituents.length})
              </h3>
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                {gift.asset.constituents.map((holding, index) => (
                  <div
                    key={`${String(holding.symbol || holding.ticker)}-${index}`}
                    className="flex items-center justify-between rounded-lg border border-border px-3 py-2 text-[10px]"
                  >
                    <span className="font-semibold">
                      {String(holding.symbol || holding.ticker || "Asset")}
                    </span>
                    <span className="text-muted-foreground">
                      {holding.weight != null
                        ? `${Number(holding.weight).toFixed(2)}%`
                        : holding.quantity != null
                          ? `Qty ${String(holding.quantity)}`
                          : "—"}
                    </span>
                  </div>
                ))}
              </div>
            </section>
          )}

          <section className="glass-panel rounded-xl p-4">
            <h3 className="flex items-center gap-2 text-xs font-bold">
              <History className="h-4 w-4 text-primary" />
              Complete timeline
            </h3>
            <div className="mt-3 border-l border-primary/25 pl-4">
              {gift.events.length > 0
                ? gift.events.map((event) => (
                    <div
                      key={event.id || `${event.toStatus}-${event.createdAt}`}
                      className="relative pb-4 last:pb-0"
                    >
                      <span className="absolute -left-[20.5px] top-1 h-2 w-2 rounded-full bg-primary ring-4 ring-background" />
                      <div className="flex flex-wrap items-center gap-2">
                        <StatusPill status={(event.toStatus || "unknown").toLowerCase()} />
                        <span className="text-[9px] text-muted-foreground">
                          {formatDate(event.createdAt)}
                        </span>
                      </div>
                      <p className="mt-1 text-[10px]">{event.reason || "State transition"}</p>
                      <p className="text-[9px] text-muted-foreground">
                        Actor: {event.actor || "system"}
                        {event.fromStatus ? ` · from ${event.fromStatus}` : ""}
                      </p>
                    </div>
                  ))
                : timestamps.map(([key, value]) => (
                    <div key={key} className="relative pb-4 last:pb-0">
                      <span className="absolute -left-[20.5px] top-1 h-2 w-2 rounded-full bg-primary ring-4 ring-background" />
                      <p className="text-[10px] font-semibold">{statusLabel(key)}</p>
                      <p className="text-[9px] text-muted-foreground">{formatDate(value)}</p>
                    </div>
                  ))}
            </div>
          </section>
        </div>
      </aside>
    </div>
  );
}

function WishlistCard({ wishlist }: { wishlist: WishlistRecord }) {
  const [expanded, setExpanded] = React.useState(false);
  const progress = wishlist.targetQuantity
    ? Math.min(100, (wishlist.filledQuantity / wishlist.targetQuantity) * 100)
    : 0;
  const owner = wishlist.beneficiary.name ? wishlist.beneficiary : wishlist.creator;
  return (
    <article className="rounded-xl border border-border bg-card/60">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-3 p-4 text-left"
      >
        <AssetLogo logoUrl={null} label={owner.name || "?"} size={34} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <EnvironmentPill environment={wishlist.environment} />
            <StatusPill status={wishlist.status} />
          </div>
          <p className="mt-1 truncate text-[11px] font-semibold">
            {owner.name || "Unknown"}
            {owner.mintNumber ? <span className="ml-1.5 font-mono text-[9px] text-muted-foreground">{owner.mintNumber}</span> : null}
          </p>
          <p className="truncate text-[10px] text-muted-foreground">{wishlist.title}</p>
          <div className="mt-2 flex items-center gap-2">
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
              <div className="h-full rounded-full bg-primary" style={{ width: `${progress}%` }} />
            </div>
            <span className="whitespace-nowrap text-[8px] text-muted-foreground">
              {wishlist.filledQuantity}/{wishlist.targetQuantity} · {progress.toFixed(0)}%
            </span>
          </div>
        </div>
        <div className="flex flex-shrink-0 items-center gap-2 text-right">
          <div>
            <p className="font-mono text-sm font-semibold">{formatMoney(wishlist.contributedRands)}</p>
            <p className="text-[8px] text-muted-foreground">{wishlist.contributionCount} contributions</p>
          </div>
          {expanded ? (
            <ChevronDown className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
          )}
        </div>
      </button>
      {expanded && (
        <div className="border-t border-border/60 p-4 pt-3">
          <div className="grid grid-cols-2 gap-2 text-[9px]">
            <div className="rounded-lg bg-muted/35 p-2">
              <p className="uppercase text-muted-foreground">Owner</p>
              <PartyCell party={wishlist.creator} />
            </div>
            <div className="rounded-lg bg-muted/35 p-2">
              <p className="uppercase text-muted-foreground">Beneficiary</p>
              <PartyCell party={wishlist.beneficiary} />
            </div>
          </div>
          <p className="mt-3 text-[9px] font-bold uppercase tracking-wider text-muted-foreground">
            Assets requested
          </p>
          <div className="mt-1.5 space-y-1.5">
            {wishlist.items.map((item) => (
              <div
                key={item.id}
                className="flex items-center gap-2.5 rounded-lg border border-border/70 px-3 py-2 text-[9px]"
              >
                <AssetLogo logoUrl={item.logoUrl} label={item.symbol || item.name} size={24} />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-semibold">{item.symbol || item.name} · {item.name}</p>
                  <p className="text-muted-foreground">{item.filledQuantity}/{item.targetQuantity} units · {item.contributionCount} gifts</p>
                </div>
                <span className="ml-2 flex-shrink-0 whitespace-nowrap font-mono">{formatMoney(item.contributedRands)}</span>
              </div>
            ))}
          </div>
          <div className="mt-3 flex justify-between text-[8px] text-muted-foreground">
            <span>Event {formatDate(wishlist.eventDate, false)}</span>
            <span>Expires {formatDate(wishlist.expiresAt, false)}</span>
          </div>
        </div>
      )}
    </article>
  );
}

function WishlistPanel({ wishlists, loading }: { wishlists: WishlistRecord[]; loading: boolean }) {
  return (
    <section className="glass-panel overflow-hidden rounded-xl">
      <div className="border-b border-border px-4 py-3">
        <h2 className="text-xs font-bold">Wishlist register</h2>
        <p className="mt-1 text-[9px] text-muted-foreground">
          Every wishlist, its requested assets, contribution progress, beneficiary and expiry.
        </p>
      </div>
      <div className="grid gap-3 p-3 lg:grid-cols-2">
        {loading ? (
          SKELETON_ROWS.slice(0, 4).map((key) => (
            <div key={key} className="h-20 animate-pulse rounded-xl bg-muted/50" />
          ))
        ) : wishlists.length === 0 ? (
          <div className="col-span-full py-14 text-center text-[11px] text-muted-foreground">
            No wishlists match this environment or search.
          </div>
        ) : (
          wishlists.map((wishlist) => <WishlistCard key={wishlist.id} wishlist={wishlist} />)
        )}
      </div>
    </section>
  );
}

export default function GiftingPage() {
  const [payload, setPayload] = React.useState<Payload | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [search, setSearch] = React.useState("");
  const [filter, setFilter] = React.useState("all");
  const [environment, setEnvironment] = React.useState<"live" | "uat">("live");
  const [view, setView] = React.useState<"gifts" | "wishlists">("gifts");
  const [selected, setSelected] = React.useState<GiftRecord | null>(null);
  const [showLineage, setShowLineage] = React.useState(false);
  const [now, setNow] = React.useState(Date.now());

  const load = React.useCallback(async () => {
    setLoading(true);
    const result = await fetch("/api/admin/gifts", { cache: "no-store" })
      .then((response) => response.json())
      .catch((error) => ({ ok: false, error: error.message }));
    setPayload(result);
    setLoading(false);
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);
  React.useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const gifts = React.useMemo(
    () => (payload?.gifts ?? []).filter((gift) => gift.environment === environment),
    [environment, payload?.gifts],
  );
  const wishlists = React.useMemo(() => {
    const query = search.trim().toLowerCase();
    return (payload?.wishlists ?? []).filter(
      (wishlist) =>
        wishlist.environment === environment &&
        (!query ||
          [wishlist.title, wishlist.occasion, wishlist.creator.name, wishlist.beneficiary.name, ...wishlist.items.map((item) => item.name)]
            .some((value) => String(value || "").toLowerCase().includes(query))),
    );
  }, [environment, payload?.wishlists, search]);
  const stats = React.useMemo(
    () => ({
      active: gifts.filter((gift) => ACTIVE.has(gift.status)).length,
      successful: gifts.filter((gift) => SUCCESS.has(gift.status) || SUCCESS.has(gift.claimState)).length,
      failed: gifts.filter((gift) => FAILED.has(gift.status) || FAILED.has(gift.claimState)).length,
      value: gifts.reduce((sum, gift) => sum + (gift.paidRands ?? gift.amountRands ?? 0), 0),
    }),
    [gifts],
  );

  const visible = React.useMemo(() => {
    const query = search.trim().toLowerCase();
    return gifts.filter((gift) => {
      const bucket =
        SUCCESS.has(gift.status) || SUCCESS.has(gift.claimState)
          ? "completed"
          : FAILED.has(gift.status) || FAILED.has(gift.claimState)
            ? "closed"
            : ACTIVE.has(gift.status)
              ? "active"
              : "other";
      if (filter !== "all" && bucket !== filter) return false;
      if (!query) return true;
      return [
        gift.recordId,
        gift.gifter.name,
        gift.gifter.email,
        gift.recipient.name,
        gift.recipient.email,
        gift.asset.name,
        gift.asset.symbol,
        gift.registry?.title,
        gift.status,
      ].some((value) =>
        String(value || "")
          .toLowerCase()
          .includes(query),
      );
    });
  }, [filter, gifts, search]);

  return (
    <div className="mx-auto w-full max-w-[1600px] space-y-4 px-4 py-5 lg:px-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-[9px] font-bold uppercase tracking-[0.18em] text-primary">
            <Gift className="h-3.5 w-3.5" />
            Retail operations
          </div>
          <h1 className="mt-1 text-2xl font-semibold">Gifting</h1>
          <p className="mt-1 max-w-3xl text-[11px] text-muted-foreground">
            A read-only audit of direct gifts and wishlist gifts, from authorization through OEMS/IRESS
            execution, claim, delivery, expiry or refund.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="hidden text-[9px] text-muted-foreground sm:block">
            Updated {formatDate(payload?.generatedAt || null)}
          </span>
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            className="inline-flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-[10px] font-semibold hover:bg-muted disabled:opacity-50"
          >
            <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
            Refresh
          </button>
        </div>
      </header>

      <section className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card/60 p-2">
        <div className="flex rounded-lg border border-border bg-background p-0.5">
          {(["gifts", "wishlists"] as const).map((option) => (
            <button
              type="button"
              key={option}
              onClick={() => setView(option)}
              className={cn(
                "rounded-md px-4 py-2 text-[10px] font-semibold",
                view === option ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {option === "gifts" ? "Gift activity" : "Wishlists"}
            </button>
          ))}
        </div>
        <div className="flex rounded-lg border border-border bg-background p-0.5">
          {(["live", "uat"] as const).map((option) => (
            <button
              type="button"
              key={option}
              onClick={() => setEnvironment(option)}
              className={cn(
                "rounded-md px-4 py-2 text-[9px] font-bold uppercase tracking-wider",
                environment === option
                  ? option === "live"
                    ? "bg-success text-white"
                    : "bg-warning text-black"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {option}
            </button>
          ))}
        </div>
      </section>

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <Metric label={`${environment.toUpperCase()} gift records`} value={gifts.length} icon={Gift} />
        <Metric label="In progress" value={stats.active} icon={Clock3} tone="warning" />
        <Metric label="Claimed / filled" value={stats.successful} icon={PackageCheck} tone="success" />
        <Metric label="Expired / failed" value={stats.failed} icon={AlertTriangle} tone="danger" />
        <Metric
          label="Recorded value"
          value={formatMoney(stats.value)}
          icon={CircleDollarSign}
          tone="primary"
        />
      </section>

      {(payload?.notices?.length || !payload?.ok) && (
        <div className="rounded-xl border border-warning/25 bg-warning/10 px-4 py-3 text-[10px] text-foreground">
          <p className="font-semibold">Some lifecycle sources are unavailable</p>
          <p className="mt-1 text-muted-foreground">{payload?.error || payload?.notices?.join(" · ")}</p>
        </div>
      )}

      <section className="glass-panel overflow-hidden rounded-xl">
        <button
          type="button"
          onClick={() => setShowLineage((value) => !value)}
          className="flex w-full items-center gap-3 border-b border-border px-4 py-3 text-left hover:bg-muted/30"
        >
          <span className="rounded-lg bg-primary/10 p-2 text-primary">
            <Database className="h-4 w-4" />
          </span>
          <div>
            <h2 className="text-xs font-bold">What gifting touches, and why</h2>
            <p className="text-[9px] text-muted-foreground">
              Data lineage from client intent to cash, execution, delivery and communication
            </p>
          </div>
          {showLineage ? (
            <ChevronDown className="ml-auto h-4 w-4" />
          ) : (
            <ChevronRight className="ml-auto h-4 w-4" />
          )}
        </button>
        {showLineage && (
          <div className="grid gap-px bg-border sm:grid-cols-2 xl:grid-cols-4">
            {(payload?.lineage ?? []).map((item) => (
              <div key={item.table} className="bg-card p-4">
                <p className="font-mono text-[9px] font-semibold text-primary">{item.table}</p>
                <p className="mt-1 text-[9px] leading-relaxed text-muted-foreground">{item.purpose}</p>
              </div>
            ))}
          </div>
        )}
      </section>

      {view === "gifts" ? (
      <section className="glass-panel overflow-hidden rounded-xl">
        <div className="flex flex-wrap items-center gap-2 border-b border-border p-3">
          <div className="relative min-w-[220px] flex-1">
            <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search person, email, asset, registry or ID…"
              className="h-9 w-full rounded-lg border border-border bg-background pl-9 pr-3 text-[10px] outline-none focus:border-primary"
            />
          </div>
          <div className="flex rounded-lg border border-border bg-background p-0.5">
            {FILTERS.map(([value, label]) => (
              <button
                type="button"
                key={value}
                onClick={() => setFilter(value)}
                className={cn(
                  "rounded-md px-3 py-2 text-[9px] font-semibold",
                  filter === value
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[1120px] border-collapse text-left">
            <thead>
              <tr className="border-b border-border bg-muted/20 text-[8px] uppercase tracking-[0.12em] text-muted-foreground">
                <th className="px-4 py-2.5">Created</th>
                <th className="px-3 py-2.5">Gifter</th>
                <th className="px-3 py-2.5">Recipient</th>
                <th className="px-3 py-2.5">Gift asset</th>
                <th className="px-3 py-2.5 text-right">Value</th>
                <th className="px-3 py-2.5">Order status</th>
                <th className="px-3 py-2.5">Claim / delivery</th>
                <th className="px-3 py-2.5">Expires in</th>
                <th className="px-3 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {loading ? (
                SKELETON_ROWS.map((key) => (
                  <tr key={key} className="border-b border-border/60">
                    <td colSpan={9} className="px-4 py-3">
                      <div className="h-8 animate-pulse rounded-lg bg-muted/50" />
                    </td>
                  </tr>
                ))
              ) : visible.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-4 py-14 text-center text-[11px] text-muted-foreground">
                    No gift records match this view.
                  </td>
                </tr>
              ) : (
                visible.map((gift) => (
                  <tr
                    key={gift.id}
                    className="border-b border-border/60 transition-colors hover:bg-primary/[0.035]"
                  >
                    <td className="whitespace-nowrap px-4 py-3">
                      <p className="text-[10px] font-medium">
                        {formatDate(gift.timestamps.created ?? null, false)}
                      </p>
                      <p className="text-[8px] text-muted-foreground">
                        {formatDate(gift.timestamps.created ?? null)
                          .split(",")
                          .slice(-1)}
                      </p>
                    </td>
                    <td className="max-w-[190px] px-3 py-3">
                      <PartyCell party={gift.gifter} />
                    </td>
                    <td className="max-w-[190px] px-3 py-3">
                      <PartyCell party={gift.recipient} />
                    </td>
                    <td className="px-3 py-3">
                      <div className="flex items-center gap-2">
                        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                          <Gift className="h-3.5 w-3.5" />
                        </span>
                        <div>
                          <p className="max-w-[180px] truncate text-[10px] font-semibold">
                            {gift.asset.name}
                          </p>
                          <p className="text-[8px] uppercase text-muted-foreground">
                            {gift.asset.symbol || gift.asset.type}
                            {gift.quantity ? ` · qty ${gift.quantity}` : ""}
                          </p>
                        </div>
                      </div>
                    </td>
                    <td className="whitespace-nowrap px-3 py-3 text-right font-mono text-[10px] font-semibold">
                      {formatMoney(gift.amountRands)}
                    </td>
                    <td className="px-3 py-3">
                      <div className="flex flex-col items-start gap-1">
                        <StatusPill status={gift.status} />
                        <OrderBookBadge execution={gift.execution} />
                      </div>
                    </td>
                    <td className="px-3 py-3">
                      <StatusPill status={gift.claimState} />
                    </td>
                    <td className="whitespace-nowrap px-3 py-3">
                      <Countdown expiresAt={gift.expiresAt} status={gift.status} now={now} />
                      <p className="mt-0.5 text-[8px] text-muted-foreground">
                        {formatDate(gift.expiresAt, false)}
                      </p>
                    </td>
                    <td className="px-3 py-3">
                      <button
                        type="button"
                        onClick={() => setSelected(gift)}
                        className="rounded-lg border border-border p-2 text-muted-foreground hover:border-primary/30 hover:bg-primary/10 hover:text-primary"
                        aria-label={`Open ${gift.asset.name} gift audit`}
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <footer className="flex items-center justify-between border-t border-border px-4 py-2 text-[9px] text-muted-foreground">
          <span>
            {visible.length} of {gifts.length} records
          </span>
          <span className="inline-flex items-center gap-1">
            <TimerReset className="h-3 w-3" />
            Countdown refreshes every 30 seconds
          </span>
        </footer>
      </section>
      ) : (
        <WishlistPanel wishlists={wishlists} loading={loading} />
      )}

      {selected && <GiftDetail gift={selected} now={now} onClose={() => setSelected(null)} />}
    </div>
  );
}
