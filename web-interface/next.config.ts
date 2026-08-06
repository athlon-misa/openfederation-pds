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
const nextConfig: NextConfig = {};

export default nextConfig;
