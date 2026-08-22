"use client";

/**
 * /oems/account — Clerk-style account settings page.
 *
 * Three tabs:
 *   - Account     — display name (first/last), read-only email, sign-out
 *                   everywhere button.
 *   - Security    — change password (Supabase updateUser via /api/auth/
 *                   update-password) + active session info.
 *   - Notifications — email/in-app notification preferences (localStorage
 *                   backed for now; can be moved to profiles columns later).
 *
 * The page is read-only on the email field (Supabase Auth controls email
 * changes via a confirmation flow). All other fields write to /api/auth/me
 * (server-side) which updates the `profiles` row in the retail DB.
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  Lock,
  LogOut,
  Mail,
  Settings2,
  ShieldCheck,
  UserCircle2,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import * as React from "react";
import { toast } from "sonner";

import { EmptyDataState } from "@/components/oems/primitives/empty-data-state";
import { GlassSection, PageCanvas } from "@/components/oems/primitives/glass";
import { PanelSkeleton } from "@/components/oems/primitives/panel-skeleton";
import { notifyAuthChange } from "@/lib/auth/store";
import { useCurrentUser } from "@/lib/auth/use-current-user";
import { cn } from "@/lib/cn";
import { formatTime } from "@/lib/format";

type Tab = "account" | "security" | "notifications";

const TAB_LABEL: Record<Tab, string> = {
  account: "Account",
  security: "Security",
  notifications: "Notifications",
};

const PREFS_KEY = "mint.notification-prefs.v1";

interface NotifPrefs {
  emailSystem: boolean;
  emailData: boolean;
  emailAction: boolean;
  inAppSystem: boolean;
  inAppData: boolean;
  inAppAction: boolean;
}

const DEFAULT_PREFS: NotifPrefs = {
  emailSystem: true,
  emailData: true,
  emailAction: true,
  inAppSystem: true,
  inAppData: true,
  inAppAction: true,
};

function loadPrefs(): NotifPrefs {
  if (typeof window === "undefined") return DEFAULT_PREFS;
  try {
    const raw = window.localStorage.getItem(PREFS_KEY);
    if (!raw) return DEFAULT_PREFS;
    const parsed = JSON.parse(raw) as Partial<NotifPrefs>;
    return { ...DEFAULT_PREFS, ...parsed };
  } catch {
    return DEFAULT_PREFS;
  }
}

export default function AccountPage() {
  const router = useRouter();
  const qc = useQueryClient();
  const { user, ready } = useCurrentUser();
  const [tab, setTab] = React.useState<Tab>("account");
  const [signingOut, setSigningOut] = React.useState(false);

  const handleSignOut = React.useCallback(async () => {
    if (signingOut) return;
    setSigningOut(true);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } catch {
      /* best-effort */
    }
    notifyAuthChange();
    setSigningOut(false);
    router.replace("/login");
  }, [router, signingOut]);

  if (!ready) {
    return (
      <PageCanvas>
        <PanelSkeleton rows={6} height="h-[420px]" />
      </PageCanvas>
    );
  }

  if (!user) {
    return (
      <PageCanvas>
        <GlassSection title="Account" subtitle="Sign in to manage your account settings.">
          <div className="px-5 py-8 text-center">
            <EmptyDataState
              message="You're not signed in."
              hint="Sign in via the avatar in the top bar to manage your account, password, and notification preferences."
            />
            <div className="mt-4">
              <Link
                href="/login"
                className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-xs hover:bg-accent"
              >
                <LogOut className="h-3.5 w-3.5" />
                Sign in
              </Link>
            </div>
          </div>
        </GlassSection>
      </PageCanvas>
    );
  }

  return (
    <PageCanvas>
      <header className="glass-panel relative overflow-hidden p-6 md:p-7">
        <div className="pointer-events-none absolute -right-20 -top-20 h-56 w-56 rounded-full bg-primary/15 blur-3xl" />
        <div className="relative space-y-2">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-primary/10 px-2.5 py-1 font-mono text-[10px] font-bold uppercase tracking-wider text-primary">
            <UserCircle2 className="h-3 w-3" />
            Account
          </span>
          <h1 className="text-display text-2xl tracking-tight">{user.fullName}</h1>
          <p className="text-sm text-muted-foreground">{user.email}</p>
        </div>
      </header>

      {/* Tabs */}
      <div className="glass-inset flex gap-0.5 p-1">
        {(["account", "security", "notifications"] as Tab[]).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={cn(
              "flex-1 rounded-lg px-3 py-1.5 text-[12px] font-medium transition-all",
              tab === t
                ? "bg-primary text-primary-foreground shadow-[0_2px_12px_-2px_hsl(var(--primary)/0.35)]"
                : "text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
          >
            {TAB_LABEL[t]}
          </button>
        ))}
      </div>

      {tab === "account" ? (
        <AccountTab user={user} signingOut={signingOut} onSignOut={handleSignOut} qc={qc} />
      ) : null}
      {tab === "security" ? <SecurityTab /> : null}
      {tab === "notifications" ? <NotificationsTab /> : null}
    </PageCanvas>
  );
}

// ─── AccountTab ────────────────────────────────────────────────────────────────────

function AccountTab({
  user,
  signingOut,
  onSignOut,
  qc,
}: {
  user: {
    id: string;
    email: string;
    fullName: string;
    firstName: string | null;
    lastName: string | null;
    createdAt: string | null;
    lastSignInAt: string | null;
  };
  signingOut: boolean;
  onSignOut: () => void;
  qc: ReturnType<typeof useQueryClient>;
}) {
  const [firstName, setFirstName] = React.useState(user.firstName ?? "");
  const [lastName, setLastName] = React.useState(user.lastName ?? "");
  const [saving, setSaving] = React.useState(false);
  const [dirty, setDirty] = React.useState(false);

  React.useEffect(() => {
    setDirty(
      (firstName.trim() || "") !== (user.firstName ?? "") ||
        (lastName.trim() || "") !== (user.lastName ?? ""),
    );
  }, [firstName, lastName, user.firstName, user.lastName]);

  const save = async () => {
    setSaving(true);
    try {
      const r = await fetch("/api/auth/me", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ firstName: firstName.trim(), lastName: lastName.trim() }),
      });
      const body = (await r.json().catch(() => null)) as {
        ok?: boolean;
        error?: string;
        message?: string;
      } | null;
      if (!r.ok || !body?.ok) {
        toast.error("Couldn't save", { description: body?.message ?? body?.error ?? "Unknown error" });
      } else {
        toast.success("Profile updated", { description: "Your name has been saved." });
        setDirty(false);
        notifyAuthChange();
        await qc.invalidateQueries({ queryKey: ["current-user"] });
      }
    } catch (e) {
      toast.error("Network error", { description: (e as Error).message });
    } finally {
      setSaving(false);
    }
  };

  return (
    <GlassSection title="Account" subtitle="Your profile, displayed name, and sign-out">
      <div className="space-y-5 p-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <FieldRow
            label="First name"
            value={firstName}
            onChange={(v) => setFirstName(v)}
            placeholder="First name"
            disabled={saving}
          />
          <FieldRow
            label="Last name"
            value={lastName}
            onChange={(v) => setLastName(v)}
            placeholder="Last name"
            disabled={saving}
          />
        </div>
        <ReadOnlyRow label="Email" value={user.email} sub="Verified by Supabase Auth." />
        <ReadOnlyRow
          label="Account ID"
          value={`${user.id.slice(0, 8)}…${user.id.slice(-4)}`}
          sub="Internal identifier — not displayed publicly."
        />
        <ReadOnlyRow
          label="Member since"
          value={
            user.createdAt
              ? new Date(user.createdAt).toLocaleDateString("en-ZA", {
                  day: "2-digit",
                  month: "long",
                  year: "numeric",
                })
              : "—"
          }
        />
        <ReadOnlyRow
          label="Last sign-in"
          value={
            user.lastSignInAt
              ? `${new Date(user.lastSignInAt).toLocaleString("en-ZA", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false })} SAST`
              : "—"
          }
        />
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-4">
          <button
            type="button"
            disabled={!dirty || saving}
            onClick={save}
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground transition-opacity disabled:opacity-50"
          >
            {saving ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <CheckCircle2 className="h-3.5 w-3.5" />
            )}
            Save changes
          </button>
          <button
            type="button"
            onClick={onSignOut}
            disabled={signingOut}
            className="inline-flex items-center gap-1.5 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-2 text-xs font-semibold text-destructive transition-colors hover:bg-destructive/15 disabled:opacity-50"
          >
            {signingOut ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <LogOut className="h-3.5 w-3.5" />
            )}
            Sign out
          </button>
        </div>
      </div>
    </GlassSection>
  );
}

function FieldRow({
  label,
  value,
  onChange,
  placeholder,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  disabled?: boolean;
}) {
  return (
    <label className="block">
      <span className="text-caption">{label}</span>
      <input
        type="text"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className="mt-1 block w-full rounded-md border border-border bg-card px-3 py-2 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:opacity-60"
      />
    </label>
  );
}

function ReadOnlyRow({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-card/40 px-3 py-2">
      <div>
        <p className="text-caption">{label}</p>
        {sub ? <p className="text-[10.5px] text-muted-foreground">{sub}</p> : null}
      </div>
      <p className="font-mono text-xs text-foreground">{value}</p>
    </div>
  );
}

// ─── SecurityTab ────────────────────────────────────────────────────────────────────

function SecurityTab() {
  const [current, setCurrent] = React.useState("");
  const [next, setNext] = React.useState("");
  const [confirm, setConfirm] = React.useState("");
  const [showCurrent, setShowCurrent] = React.useState(false);
  const [showNext, setShowNext] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const match = next.length > 0 && next === confirm;
  const longEnough = next.length >= 12;
  const canSubmit = current.length > 0 && longEnough && match && !saving;

  const submit = async () => {
    if (!canSubmit) return;
    setSaving(true);
    setError(null);
    try {
      const r = await fetch("/api/auth/update-password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ currentPassword: current, newPassword: next }),
      });
      const body = (await r.json().catch(() => null)) as {
        ok?: boolean;
        error?: string;
        message?: string;
      } | null;
      if (!r.ok || !body?.ok) {
        setError(body?.message ?? body?.error ?? "Couldn't update password.");
        toast.error("Could not change password", {
          description: body?.message ?? body?.error ?? "Unknown error",
        });
      } else {
        toast.success("Password updated", {
          description: "Sign in again next time with your new password.",
        });
        setCurrent("");
        setNext("");
        setConfirm("");
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <GlassSection title="Security" subtitle="Password and authentication">
      <div className="space-y-5 p-5">
        <div className="rounded-lg border border-border bg-card/40 p-4">
          <div className="flex items-center gap-2">
            <KeyRound className="h-4 w-4 text-primary" />
            <h3 className="text-sm font-semibold">Change password</h3>
          </div>
          <p className="mt-1 text-[11.5px] text-muted-foreground">
            Use at least 12 characters. We recommend a password manager and a unique passphrase you don't
            reuse elsewhere.
          </p>
          <div className="mt-4 space-y-3">
            <PasswordField
              label="Current password"
              value={current}
              onChange={setCurrent}
              show={showCurrent}
              onToggleShow={() => setShowCurrent((v) => !v)}
              disabled={saving}
              autoComplete="current-password"
            />
            <PasswordField
              label="New password"
              value={next}
              onChange={setNext}
              show={showNext}
              onToggleShow={() => setShowNext((v) => !v)}
              disabled={saving}
              autoComplete="new-password"
            />
            <PasswordField
              label="Confirm new password"
              value={confirm}
              onChange={setConfirm}
              show={showNext}
              onToggleShow={() => setShowNext((v) => !v)}
              disabled={saving}
              autoComplete="new-password"
            />
            <div className="flex flex-wrap items-center gap-2 text-[11px]">
              <ReqBadge ok={longEnough}>12+ chars</ReqBadge>
              <ReqBadge ok={match}>Matches</ReqBadge>
              {next && !longEnough ? <span className="text-warning">Pick a longer password.</span> : null}
              {next && longEnough && !match ? (
                <span className="text-warning">Passwords don't match yet.</span>
              ) : null}
            </div>
            {error ? (
              <div className="flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-[11.5px] text-destructive">
                <AlertTriangle className="h-3.5 w-3.5" />
                {error}
              </div>
            ) : null}
            <button
              type="button"
              onClick={submit}
              disabled={!canSubmit}
              className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground transition-opacity disabled:opacity-50"
            >
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Lock className="h-3.5 w-3.5" />}
              Update password
            </button>
          </div>
        </div>

        <div className="rounded-lg border border-border bg-card/40 p-4">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-success" />
            <h3 className="text-sm font-semibold">Two-factor authentication</h3>
          </div>
          <p className="mt-1 text-[11.5px] text-muted-foreground">
            MFA is provisioned by Supabase Auth. Configure authenticator apps from the Supabase dashboard once
            enabled for this deployment.
          </p>
          <div className="mt-3 inline-flex items-center gap-2 rounded-md border border-border bg-card px-3 py-1.5 text-[11px] text-muted-foreground">
            <ShieldCheck className="h-3 w-3" />
            Available — configure in Supabase
          </div>
        </div>
      </div>
    </GlassSection>
  );
}

function PasswordField({
  label,
  value,
  onChange,
  show,
  onToggleShow,
  disabled,
  autoComplete,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  show: boolean;
  onToggleShow: () => void;
  disabled?: boolean;
  autoComplete?: string;
}) {
  return (
    <label className="block">
      <span className="text-caption">{label}</span>
      <div className="relative mt-1">
        <input
          type={show ? "text" : "password"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoComplete={autoComplete}
          disabled={disabled}
          className="block w-full rounded-md border border-border bg-card px-3 py-2 pr-10 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:opacity-60"
        />
        <button
          type="button"
          onClick={onToggleShow}
          aria-label={show ? "Hide password" : "Show password"}
          className="absolute inset-y-0 right-1 flex items-center px-2 text-muted-foreground hover:text-foreground"
        >
          {show ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
        </button>
      </div>
    </label>
  );
}

function ReqBadge({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[9.5px] font-semibold uppercase tracking-wider",
        ok ? "border-success/40 bg-success/10 text-success" : "border-border bg-card text-muted-foreground",
      )}
    >
      {ok ? (
        <CheckCircle2 className="h-2.5 w-2.5" />
      ) : (
        <span className="h-2.5 w-2.5 rounded-full border border-current" />
      )}
      {children}
    </span>
  );
}

// ─── NotificationsTab ──────────────────────────────────────────────────────────────

function NotificationsTab() {
  const [prefs, setPrefs] = React.useState<NotifPrefs>(DEFAULT_PREFS);
  const [saving, setSaving] = React.useState(false);
  const [dirty, setDirty] = React.useState(false);

  React.useEffect(() => {
    const p = loadPrefs();
    setPrefs(p);
    setDirty(false);
  }, []);
  React.useEffect(() => {
    const same = JSON.stringify(prefs) === JSON.stringify(loadPrefs());
    setDirty(!same);
  }, [prefs]);

  const update = <K extends keyof NotifPrefs>(k: K, v: NotifPrefs[K]) => {
    setPrefs((p) => ({ ...p, [k]: v }));
  };

  const save = () => {
    setSaving(true);
    try {
      window.localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
      toast.success("Notification preferences saved");
      setDirty(false);
    } catch {
      toast.error("Couldn't save preferences");
    } finally {
      setSaving(false);
    }
  };

  return (
    <GlassSection title="Notifications" subtitle="How you receive alerts from the platform">
      <div className="space-y-5 p-5">
        <div className="rounded-lg border border-border bg-card/40">
          <div className="grid grid-cols-[1fr_auto_auto] gap-3 border-b border-border px-4 py-3 text-[10.5px] font-mono uppercase tracking-wider text-muted-foreground">
            <span>Category</span>
            <span>In-app</span>
            <span>Email</span>
          </div>
          <PreferenceRow
            label="System alerts"
            sub="Worker health, IRESS service-call failures, heartbeat staleness"
            inApp={prefs.inAppSystem}
            email={prefs.emailSystem}
            onInAppChange={(v) => update("inAppSystem", v)}
            onEmailChange={(v) => update("emailSystem", v)}
          />
          <PreferenceRow
            label="Data feed alerts"
            sub="Yahoo fallback activations, IRESS overlay changes"
            inApp={prefs.inAppData}
            email={prefs.emailData}
            onInAppChange={(v) => update("inAppData", v)}
            onEmailChange={(v) => update("emailData", v)}
          />
          <PreferenceRow
            label="Action required"
            sub="Admin approvals, EFT pending, manual funds"
            inApp={prefs.inAppAction}
            email={prefs.emailAction}
            onInAppChange={(v) => update("inAppAction", v)}
            onEmailChange={(v) => update("emailAction", v)}
          />
        </div>
        <div className="flex items-center justify-between gap-2 border-t border-border pt-4">
          <span className="text-[11px] text-muted-foreground">
            Email delivery requires Supabase SMTP / Resend to be configured. Until that ships, in-app
            notifications are the source of truth.
          </span>
          <button
            type="button"
            onClick={save}
            disabled={!dirty || saving}
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground transition-opacity disabled:opacity-50"
          >
            {saving ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <CheckCircle2 className="h-3.5 w-3.5" />
            )}
            Save preferences
          </button>
        </div>
      </div>
    </GlassSection>
  );
}

function PreferenceRow({
  label,
  sub,
  inApp,
  email,
  onInAppChange,
  onEmailChange,
}: {
  label: string;
  sub: string;
  inApp: boolean;
  email: boolean;
  onInAppChange: (v: boolean) => void;
  onEmailChange: (v: boolean) => void;
}) {
  return (
    <div className="grid grid-cols-[1fr_auto_auto] items-center gap-3 border-b border-border/60 px-4 py-3 last:border-0">
      <div>
        <p className="text-[12.5px] font-medium">{label}</p>
        <p className="text-[10.5px] text-muted-foreground">{sub}</p>
      </div>
      <Toggle checked={inApp} onChange={onInAppChange} label={`${label} in-app`} />
      <Toggle checked={email} onChange={onEmailChange} label={`${label} email`} />
    </div>
  );
}

function Toggle({
  checked,
  onChange,
  label,
}: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors",
        checked ? "bg-primary" : "bg-muted/50",
      )}
    >
      <span
        className={cn(
          "inline-block h-4 w-4 transform rounded-full bg-card shadow-sm transition-transform",
          checked ? "translate-x-[18px]" : "translate-x-[2px]",
        )}
      />
    </button>
  );
}
