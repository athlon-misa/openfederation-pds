import type { NextConfig } from "next";

// Linting runs via the ESLint CLI (`npm run lint`), not as part of `next build`.
// Next.js 16 removed `next lint` and with it the `eslint` config key.
const nextConfig: NextConfig = {
  output: 'standalone',
};

export default nextConfig;
