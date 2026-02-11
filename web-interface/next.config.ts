import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Skip ESLint during production builds — linting is a dev-time concern
  eslint: {
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;
