import type { Metadata, Viewport } from "next";
import { JetBrains_Mono, Inter } from "next/font/google";
import { ThemeProvider } from "next-themes";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { IressProvider } from "@/lib/iress/provider";
import { TickStreamProvider } from "@/lib/store/tick-stream-provider";
import { QueryProvider } from "@/lib/store/query-provider";
import { cn } from "@/lib/cn";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: {
    default: "Mint Wealth Navigator",
    template: "%s · Mint Wealth Navigator",
  },
  description:
    "Institutional OEMS and wealth platform for the South African market.",
  applicationName: "Mint Wealth Navigator",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#0c0a14" },
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
  ],
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en-ZA"
      suppressHydrationWarning
      className={cn(inter.variable, jetbrainsMono.variable)}
    >
      <body className="min-h-screen bg-canvas text-foreground font-sans">
        <ThemeProvider
          attribute="class"
          defaultTheme="dark"
          enableSystem
          disableTransitionOnChange
        >
          <QueryProvider>
            <IressProvider>
              <TickStreamProvider>
                <TooltipProvider delayDuration={120}>
                  {children}
                  <Toaster richColors position="bottom-right" />
                </TooltipProvider>
              </TickStreamProvider>
            </IressProvider>
          </QueryProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
