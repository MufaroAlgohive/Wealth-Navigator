import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Next.js 16: typedRoutes moved out of `experimental`.
  typedRoutes: true,
  // Bun runtime is fine; keep server actions on (default in 15+)
  serverExternalPackages: ["lightweight-charts"],
};

export default nextConfig;
