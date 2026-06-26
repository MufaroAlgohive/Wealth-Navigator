"use client";

import * as React from "react";
import { usePathname } from "next/navigation";
import { Bug, X, Trash2 } from "lucide-react";

import { cn } from "@/lib/cn";
import { usePersona } from "@/lib/store/session-provider";
import { useDevTools, useApiLog, installApiInterceptor, type ApiCall } from "@/lib/dev/dev-tools";

/**
 * Developer debug HUD. A floating panel showing the current route and a live
 * log of every API call the page makes (method, path, status, timing). Rendered
 * ONLY for the allowlisted debug users (see dev-tools.ts), so live users never
 * see it. Gives the IRESS integration devs a full picture of what each page and
 * module calls without opening browser dev tools.
 */
export function DevToolsHud() {
  const dev = useDevTools();
  React.useEffect(() => {
    if (dev.enabled) installApiInterceptor();
  }, [dev.enabled]);
  if (!dev.enabled) return null;
  return <Hud email={dev.email} />;
}

function methodColor(method: string): string {
  switch (method) {
    case "GET":
      return "hsl(var(--info))";
    case "POST":
      return "hsl(var(--up))";
    case "PUT":
    case "PATCH":
      return "hsl(var(--warning))";
    case "DELETE":
      return "hsl(var(--down))";
    default:
      return "hsl(var(--muted-foreground))";
  }
}

function statusColor(status: number | "ERR"): string {
  if (status === "ERR") return "hsl(var(--down))";
  if (status >= 500) return "hsl(var(--down))";
  if (status >= 400) return "hsl(var(--warning))";
  if (status >= 300) return "hsl(var(--info))";
  return "hsl(var(--up))";
}

function Hud({ email }: { email: string | null }) {
  const [open, setOpen] = React.useState(false);
  const [cleared, setCleared] = React.useState(0);
  const pathname = usePathname() ?? "";
  const persona = usePersona();
  const log = useApiLog();

  // "Clear" is view-only (the log is a shared module store): hide everything
  // older than the moment Clear was pressed.
  const visible = React.useMemo(() => log.filter((c) => c.ts >= cleared), [log, cleared]);

  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex flex-col items-end gap-2 font-mono">
      {open && (
        <div className="glass-panel pointer-events-auto flex max-h-[60vh] w-[360px] flex-col overflow-hidden rounded-xl text-[11px]">
          <div className="flex items-center justify-between gap-2 border-b border-[hsl(var(--glass-border))] px-3 py-2">
            <span className="flex items-center gap-1.5 font-semibold text-foreground">
              <Bug className="h-3.5 w-3.5 text-primary" /> Dev tools
            </span>
            <span className="truncate text-[10px] text-muted-foreground" title={email ?? ""}>
              {email}
            </span>
          </div>

          <div className="space-y-1 border-b border-[hsl(var(--glass-border))] px-3 py-2 text-muted-foreground">
            <div className="flex justify-between gap-2">
              <span className="text-muted-foreground/70">route</span>
              <span className="truncate text-foreground" title={pathname}>{pathname}</span>
            </div>
            <div className="flex justify-between gap-2">
              <span className="text-muted-foreground/70">persona</span>
              <span className="text-foreground">{persona}</span>
            </div>
          </div>

          <div className="flex items-center justify-between border-b border-[hsl(var(--glass-border))] px-3 py-1.5">
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground/70">
              API calls · {visible.length}
            </span>
            <button
              type="button"
              onClick={() => setCleared(Date.now())}
              className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground"
            >
              <Trash2 className="h-3 w-3" /> clear
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
            {visible.length === 0 ? (
              <p className="px-3 py-4 text-center text-[10px] text-muted-foreground">
                No API calls yet. Navigate or refresh a panel.
              </p>
            ) : (
              <ul className="divide-y divide-[hsl(var(--glass-border))]/50">
                {visible.map((c) => (
                  <ApiRow key={c.id} call={c} />
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      <button
        type="button"
        aria-label="Toggle developer tools"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "glass-panel pointer-events-auto flex h-9 items-center gap-1.5 rounded-full px-3 text-[11px] font-semibold transition-colors",
          open ? "text-primary" : "text-muted-foreground hover:text-foreground",
        )}
      >
        {open ? <X className="h-4 w-4" /> : <Bug className="h-4 w-4" />}
        DEV
      </button>
    </div>
  );
}

function ApiRow({ call }: { call: ApiCall }) {
  return (
    <li className="flex items-center gap-2 px-3 py-1.5">
      <span className="w-12 shrink-0 font-semibold tabular-nums" style={{ color: methodColor(call.method) }}>
        {call.method}
      </span>
      <span className="min-w-0 flex-1 truncate text-foreground/90" title={call.path}>
        {call.path}
      </span>
      <span className="shrink-0 tabular-nums" style={{ color: statusColor(call.status) }}>
        {call.status}
      </span>
      <span className="w-10 shrink-0 text-right tabular-nums text-muted-foreground">{call.ms}ms</span>
    </li>
  );
}
