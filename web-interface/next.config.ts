import type { NextConfig } from "next";

// Linting runs via the ESLint CLI (`npm run lint`), not as part of `next build`.
// Next.js 16 removed `next lint` and with it the `eslint` config key.
//
// Deliberately no `output: 'standalone'`. Railway builds with nixpacks, which
// installs the full node_modules and starts the app with `next start` — so the
// standalone bundle was never served, while still costing ~41MB of duplicated
// output per build. Next 16 also warns that `next start` and standalone are
// incompatible. Adopting standalone properly would mean starting
// `.next/standalone/web-interface/server.js` and copying `.next/static` and
// `public/` alongside it, since the standalone tree does not include them;
// worth doing if the dashboard is ever containerised, not before.
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
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
