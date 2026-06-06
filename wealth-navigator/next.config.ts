import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  experimental: {
    // enable typed routes for safer Link usage
    typedRoutes: true,
  },
  // Bun runtime is fine; keep server actions on (default in 15+)
  serverExternalPackages: ["lightweight-charts"],
};

export default nextConfig;
