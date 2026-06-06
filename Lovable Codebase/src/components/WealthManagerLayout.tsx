import { ReactNode, useEffect, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import {
  LayoutDashboard, Users, TrendingUp, Shield, DollarSign, Settings,
  ChevronLeft, ChevronRight, LogOut, Bell, Search, Store, BarChart3,
  UserCheck, FileCheck, Building2, Landmark, HeartPulse, Activity,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useRole } from "@/contexts/RoleContext";
import type { UserRole } from "@/lib/mockData";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";

const roleHome: Record<UserRole, string> = {
  strategist: "/",
  wealth_manager: "/",
  admin: "/",
  business: "/",
  funeral_cover: "/",
  oems: "/oems",
};

interface NavItem {
  label: string;
  href: string;
  icon: React.ElementType;
  badge?: number;
}

type NavConfig = {
  sections: { title: string; items: NavItem[] }[];
};

const navByRole: Record<UserRole, NavConfig> = {
  strategist: {
    sections: [
      {
        title: "Overview",
        items: [
          { label: "Dashboard", href: "/", icon: LayoutDashboard },
          { label: "My Strategies", href: "/strategies", icon: BarChart3 },
        ],
      },
      {
        title: "Platform",
        items: [
          { label: "Marketplace", href: "/marketplace", icon: Store },
        ],
      },
      {
        title: "System",
        items: [
          { label: "Settings", href: "/settings", icon: Settings },
        ],
      },
    ],
  },
  wealth_manager: {
    sections: [
      {
        title: "Overview",
        items: [
          { label: "Dashboard", href: "/", icon: LayoutDashboard },
          { label: "Clients", href: "/clients", icon: Users, badge: 3 },
        ],
      },
      {
        title: "Investing",
        items: [
          { label: "Marketplace", href: "/marketplace", icon: Store },
        ],
      },
      {
        title: "Operations",
        items: [
          { label: "Commissions", href: "/commissions", icon: DollarSign },
        ],
      },
      {
        title: "System",
        items: [
          { label: "Settings", href: "/settings", icon: Settings },
        ],
      },
    ],
  },
  admin: {
    sections: [
      {
        title: "Overview",
        items: [
          { label: "Dashboard", href: "/", icon: LayoutDashboard },
          { label: "Onboarding", href: "/compliance", icon: UserCheck, badge: 2 },
        ],
      },
      {
        title: "Platform",
        items: [
          { label: "Marketplace", href: "/marketplace", icon: Store },
          { label: "All Clients", href: "/clients", icon: Users },
        ],
      },
      {
        title: "System",
        items: [
          { label: "Settings", href: "/settings", icon: Settings },
        ],
      },
    ],
  },
  business: {
    sections: [
      {
        title: "Overview",
        items: [
          { label: "Dashboard", href: "/", icon: LayoutDashboard },
          { label: "Members", href: "/members", icon: Users, badge: 2 },
        ],
      },
      {
        title: "Products",
        items: [
          { label: "Strategies", href: "/marketplace", icon: Store },
          { label: "Insurance", href: "/insurance", icon: HeartPulse },
        ],
      },
      {
        title: "System",
        items: [
          { label: "Settings", href: "/settings", icon: Settings },
        ],
      },
    ],
  },
  funeral_cover: {
    sections: [
      {
        title: "Overview",
        items: [
          { label: "Dashboard", href: "/", icon: LayoutDashboard },
        ],
      },
      {
        title: "Operations",
        items: [
          { label: "Groups", href: "/fc/groups", icon: Building2 },
          { label: "Onboarding", href: "/fc/onboarding", icon: UserCheck, badge: 3 },
          { label: "Payments", href: "/fc/payments", icon: DollarSign },
          { label: "Claims", href: "/fc/claims", icon: FileCheck },
        ],
      },
      {
        title: "Admin",
        items: [
          { label: "Compliance", href: "/fc/compliance", icon: Shield },
          { label: "Distributors", href: "/fc/distributors", icon: Landmark },
        ],
      },
      {
        title: "System",
        items: [
          { label: "Settings", href: "/settings", icon: Settings },
        ],
      },
    ],
  },
  oems: {
    sections: [
      {
        title: "Trading Desk",
        items: [
          { label: "OEMS Dashboard", href: "/oems", icon: Activity },
        ],
      },
      {
        title: "System",
        items: [
          { label: "Settings", href: "/settings", icon: Settings },
        ],
      },
    ],
  },
};

function NavSection({ title, items, collapsed, currentPath }: { title: string; items: NavItem[]; collapsed: boolean; currentPath: string }) {
  return (
    <div className="mb-6">
      {!collapsed && (
        <p className="px-4 mb-2 text-[11px] font-semibold uppercase tracking-wider text-sidebar-section">{title}</p>
      )}
      <nav className="space-y-0.5 px-2">
        {items.map((item) => {
          const isActive = currentPath === item.href || (item.href !== "/" && currentPath.startsWith(item.href));
          return (
            <Link
              key={item.href}
              to={item.href}
              className={cn(
                "flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all duration-150",
                isActive ? "bg-sidebar-active text-sidebar-active-foreground shadow-sm" : "text-sidebar-foreground hover:bg-sidebar-hover"
              )}
            >
              <item.icon className="h-[18px] w-[18px] shrink-0" />
              {!collapsed && (
                <>
                  <span className="flex-1">{item.label}</span>
                  {item.badge && (
                    <Badge variant="secondary" className="h-5 min-w-5 flex items-center justify-center text-[10px] bg-sidebar-active/20 text-sidebar-active-foreground border-0">
                      {item.badge}
                    </Badge>
                  )}
                </>
              )}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}

export default function WealthManagerLayout({ children }: { children: ReactNode }) {
  const location = useLocation();
  const navigate = useNavigate();
  const { role, setRole, user } = useRole();
  const [collapsed, setCollapsed] = useState(role === "oems");
  const navConfig = navByRole[role];

  useEffect(() => {
    setCollapsed(role === "oems");
  }, [role]);

  return (
    <div className="flex h-screen overflow-hidden">
      <aside className={cn("flex flex-col bg-sidebar border-r border-sidebar-border transition-all duration-200 shrink-0", collapsed ? "w-[68px]" : "w-[240px]")}>
        {/* Logo */}
        <div className="flex items-center gap-3 px-4 h-16 border-b border-sidebar-border">
          <div className="h-8 w-8 rounded-lg bg-sidebar-active flex items-center justify-center text-sidebar-active-foreground font-bold text-sm shrink-0">M</div>
          {!collapsed && (
            <div>
              <p className="text-sm font-semibold text-sidebar-active-foreground">Mint</p>
              <p className="text-[10px] text-sidebar-section uppercase tracking-wider">Investment Platform</p>
            </div>
          )}
        </div>

        {/* Role Switcher */}
        {!collapsed && (
          <div className="px-3 py-3 border-b border-sidebar-border">
            <Select value={role} onValueChange={(v) => {
              const nextRole = v as UserRole;
              setRole(nextRole);
              navigate(roleHome[nextRole]);
            }}>
              <SelectTrigger className="h-8 text-xs bg-sidebar-hover border-sidebar-border text-sidebar-foreground">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="oems">OEMS · Trading Desk</SelectItem>
                <SelectItem value="strategist">Strategist View</SelectItem>
                <SelectItem value="wealth_manager">Wealth Manager View</SelectItem>
                <SelectItem value="business">Business View</SelectItem>
                <SelectItem value="funeral_cover">Funeral Cover</SelectItem>
                <SelectItem value="admin">Admin / Compliance</SelectItem>
              </SelectContent>
            </Select>
          </div>
        )}

        <div className="flex-1 overflow-y-auto py-4">
          {navConfig.sections.map((section) => (
            <NavSection key={section.title} title={section.title} items={section.items} collapsed={collapsed} currentPath={location.pathname} />
          ))}
        </div>

        {/* User */}
        <div className="border-t border-sidebar-border p-3">
          <div className="flex items-center gap-3">
            <div className="h-8 w-8 rounded-full bg-sidebar-active/20 flex items-center justify-center text-sidebar-active-foreground text-xs font-semibold shrink-0">
              {user.initials}
            </div>
            {!collapsed && (
              <div className="flex-1 min-w-0">
                <p className="text-xs font-medium text-sidebar-active-foreground truncate">{user.name}</p>
                <p className="text-[10px] text-sidebar-section">{user.subtitle}</p>
              </div>
            )}
          </div>
          {!collapsed && (
            <button className="flex items-center gap-2 mt-3 text-xs text-sidebar-section hover:text-sidebar-active-foreground transition-colors w-full">
              <LogOut className="h-3.5 w-3.5" />Sign out
            </button>
          )}
        </div>

        <button onClick={() => setCollapsed(!collapsed)} className="flex items-center justify-center h-10 border-t border-sidebar-border text-sidebar-section hover:text-sidebar-active-foreground transition-colors">
          {collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
        </button>
      </aside>

      <div className="flex-1 flex flex-col overflow-hidden">
        <header className="h-14 border-b border-border bg-card flex items-center justify-between px-6 shrink-0">
          <div className="relative w-72">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input placeholder="Search..." className="pl-9 h-9 text-sm bg-secondary border-0" />
          </div>
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="icon" className="relative h-9 w-9">
              <Bell className="h-4 w-4" />
              <span className="absolute top-1.5 right-1.5 h-2 w-2 rounded-full bg-destructive" />
            </Button>
          </div>
        </header>
        <main className="flex-1 overflow-y-auto p-6">{children}</main>
      </div>
    </div>
  );
}
