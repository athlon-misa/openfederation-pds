import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Standalone output for containerized deployments (Railway, Docker)
  // Produces a self-contained build in .next/standalone
  output: "standalone",
};

export default nextConfig;
