import { ReactNode } from "react";
import { NavLink } from "react-router-dom";
import { cn } from "@/lib/utils";
import {
  LayoutDashboard, ClipboardList, Layers, LineChart, Banknote,
  TrendingUp, Globe2, Newspaper, Search, Activity,
} from "lucide-react";
import TickerBar from "./TickerBar";
import ConnectionPill from "./ConnectionPill";

const SECTIONS: { title: string; items: { to: string; label: string; icon: any }[] }[] = [
  {
    title: "Cockpit",
    items: [
      { to: "/oems",                label: "Overview",        icon: LayoutDashboard },
      { to: "/oems/blotter",         label: "Blotter & Orders", icon: ClipboardList },
      { to: "/oems/strategies",      label: "Strategies",      icon: Layers },
    ],
  },
  {
    title: "Markets",
    items: [
      { to: "/oems/equities",        label: "Equities",        icon: TrendingUp },
      { to: "/oems/fixed-income",    label: "Fixed Income",    icon: LineChart },
      { to: "/oems/money-market",    label: "Money Market",    icon: Banknote },
      { to: "/oems/curves",          label: "Curves & Rates",  icon: LineChart },
    ],
  },
  {
    title: "Intelligence",
    items: [
      { to: "/oems/macro",           label: "Macro",           icon: Globe2 },
      { to: "/oems/news",            label: "News & SENS",     icon: Newspaper },
      { to: "/oems/security",        label: "Security Lookup", icon: Search },
    ],
  },
  {
    title: "System",
    items: [
      { to: "/oems/integration",     label: "Integration Health", icon: Activity },
    ],
  },
];

export default function OEMSShell({ children }: { children: ReactNode }) {
  return (
    <div className="-m-6 h-[calc(100vh-3.5rem)] flex flex-col bg-background">
      {/* Top chrome */}
      <div className="flex items-center gap-3 px-4 py-2 border-b border-border bg-card shrink-0">
        <div className="flex items-center gap-2">
          <div className="h-6 w-6 rounded bg-primary flex items-center justify-center text-primary-foreground text-[10px] font-bold">M</div>
          <div>
            <p className="text-xs font-semibold leading-none">MINT OEMS</p>
            <p className="text-[9px] text-muted-foreground uppercase tracking-wider">v4.2 · institutional desk</p>
          </div>
        </div>
        <div className="flex-1 min-w-0">
          <TickerBar />
        </div>
        <ConnectionPill />
      </div>

      {/* Sub-nav + content */}
      <div className="flex flex-1 min-h-0">
        <nav className="w-44 shrink-0 border-r border-border bg-card overflow-y-auto py-3">
          {SECTIONS.map(sec => (
            <div key={sec.title} className="mb-4">
              <p className="px-3 mb-1 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">{sec.title}</p>
              <div className="space-y-0.5 px-1.5">
                {sec.items.map(it => (
                  <NavLink key={it.to} to={it.to} end={it.to === "/oems"}
                    className={({ isActive }) => cn(
                      "flex items-center gap-2 px-2.5 py-1.5 rounded text-xs transition-colors",
                      isActive ? "bg-primary text-primary-foreground" : "text-foreground hover:bg-muted",
                    )}>
                    <it.icon className="h-3.5 w-3.5 shrink-0" />
                    <span className="truncate">{it.label}</span>
                  </NavLink>
                ))}
              </div>
            </div>
          ))}
        </nav>

        <main className="flex-1 overflow-auto p-4 min-w-0">{children}</main>
      </div>
    </div>
  );
}
