import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Keep Turbopack inside this Next.js app. The repository and developer
  // machines can contain parent lockfiles; allowing root inference to climb
  // above the app makes builds non-deterministic and may hit protected paths.
  turbopack: { root: process.cwd() },
  // Next.js 16: typedRoutes moved out of `experimental`.
  typedRoutes: true,
  // Bun runtime is fine; keep server actions on (default in 15+)
  serverExternalPackages: ["lightweight-charts"],
};

export default nextConfig;
