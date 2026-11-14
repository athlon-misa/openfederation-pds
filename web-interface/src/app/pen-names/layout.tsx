import type { Metadata } from 'next';

/**
 * The signed-out pen-name pages, outside the dashboard (like /verify): no
 * sign-in, and the person's own session is never loaded here
 * (lib/signed-out-area.ts, components/store-hydration.tsx).
 */
export const metadata: Metadata = {
  title: 'Pen names · OpenFederation',
  description: 'Create and use a pen name without signing in to an account.',
  referrer: 'no-referrer',
  robots: { index: false, follow: false },
};

export default function PenNamesLayout({ children }: { children: React.ReactNode }) {
  return <div className="min-h-screen bg-background">{children}</div>;
}
