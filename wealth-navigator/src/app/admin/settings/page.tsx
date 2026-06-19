"use client";

import type { ElementType } from "react";
import Link from "next/link";
import type { Route } from "next";
import { ChevronRight, MonitorSmartphone, ShieldCheck, SlidersHorizontal } from "lucide-react";

import { useAdmin } from "@/lib/admin/context";
import { isAdminRole } from "@/lib/admin/pages";

function NavRow({ href, title, subtitle, icon: Icon }: {
  href: Route;
  title: string;
  subtitle: string;
  icon: ElementType;
}) {
  return (
    <Link
      href={href}
      className="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3 transition-colors hover:bg-accent/50"
    >
      <div className="flex h-8 w-8 items-center justify-center rounded-md bg-muted text-muted-foreground">
        <Icon className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-foreground">{title}</div>
        <div className="text-xs text-muted-foreground">{subtitle}</div>
      </div>
      <ChevronRight className="h-4 w-4 text-muted-foreground" />
    </Link>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between rounded-lg border border-border bg-card px-4 py-3">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="text-sm font-medium text-foreground">{value}</span>
    </div>
  );
}

export default function AdminSettingsPage() {
  const { ctx } = useAdmin();
  const admin = isAdminRole(ctx);

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <section className="space-y-2">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Account</h2>
        <InfoRow label="Admin account" value={ctx.email} />
        <InfoRow label="Role" value={ctx.role} />
        {ctx.approverTier && <InfoRow label="Approver tier" value={ctx.approverTier} />}
      </section>

      <section className="space-y-2">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Appearance</h2>
        <InfoRow label="Display mode" value="Theme toggle (top bar)" />
        <InfoRow label="Language & region" value="English (ZA)" />
      </section>

      {admin && (
        <section className="space-y-2">
          <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Admin</h2>
          <NavRow href={"/admin/studio" as Route} icon={MonitorSmartphone} title="Client View Studio" subtitle="Preview the app as any client" />
          <NavRow href={"/admin/app-settings" as Route} icon={SlidersHorizontal} title="App Settings" subtitle="Platform fees & configuration" />
          <NavRow href={"/admin/team" as Route} icon={ShieldCheck} title="Team" subtitle="Members, roles & page access" />
        </section>
      )}

      <p className="text-xs text-muted-foreground">Sign out from the user menu in the sidebar.</p>
    </div>
  );
}
