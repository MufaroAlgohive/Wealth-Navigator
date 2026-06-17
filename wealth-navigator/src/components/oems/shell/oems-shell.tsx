import { TopBar } from "./top-bar";
import { SideNav } from "./side-nav";
import { TickerBar } from "@/components/oems/primitives/ticker-bar";

export function OEMSShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-screen flex-col overflow-hidden bg-canvas text-foreground">
      <TopBar />
      <TickerBar />
      <div className="flex flex-1 min-h-0">
        <SideNav />
        <main
          id="main-content"
          tabIndex={-1}
          className="mint-ambient relative flex-1 min-w-0 overflow-y-auto p-4 scrollbar-thin focus:outline-none md:p-5"
        >
          <div className="relative mx-auto max-w-[1800px] animate-fade-in">{children}</div>
        </main>
      </div>
    </div>
  );
}
