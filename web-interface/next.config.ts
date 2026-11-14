import type { NextConfig } from "next";

// Linting runs via the ESLint CLI (`npm run lint`), not as part of `next build`.
// Next.js 16 removed `next lint` and with it the `eslint` config key.
//
// `output: 'standalone'` only for the container image (web-interface/Dockerfile
// sets NEXT_OUTPUT=standalone). Railway builds with nixpacks, which installs
// the full node_modules and starts the app with `next start`; Next 16 warns
// that `next start` and standalone are incompatible, and the standalone tree
// would be ~41MB of unused output there. The Dockerfile copies `.next/static`
// and `public/` next to the standalone server, which does not include them.
// Security headers for every dashboard page. Only rules that cannot break the
// app: a full script CSP would need nonces for Next's inline scripts. The
// dashboard must never be framed (clickjacking on admin actions).
const securityHeaders = [
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  ...(process.env.NEXT_OUTPUT === "standalone" ? { output: "standalone" as const } : {}),
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
