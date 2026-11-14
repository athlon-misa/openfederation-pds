'use client';

import { useEffect, useRef } from 'react';
import { usePathname } from 'next/navigation';
import { useAuthStore } from '@/store/auth-store';
import { isSignedOutArea, isTabSealed, sealThisTab } from '@/lib/signed-out-area';

export function StoreHydration({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const hydrate = useAuthStore((s) => s.hydrate);
  const isHydrated = useAuthStore((s) => s.isHydrated);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const refresh = useAuthStore((s) => s.refresh);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // The signed-out pen-name pages never load or refresh the person's session,
  // and neither does a tab after it showed one. The path alone decides the
  // first render, the same on the server and in the browser; the tab's seal
  // is kept in the browser only (a server module is shared by every visitor).
  const signedOut = isSignedOutArea(pathname);
  if (signedOut && typeof window !== 'undefined') sealThisTab();
  const sealed = signedOut || (typeof window !== 'undefined' && isTabSealed());

  useEffect(() => {
    if (!sealed) void hydrate();
  }, [hydrate, sealed]);

  // Set up auto-refresh every 10 minutes when authenticated
  useEffect(() => {
    if (isAuthenticated && !sealed) {
      intervalRef.current = setInterval(() => {
        refresh();
      }, 10 * 60 * 1000);
    }
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
  }, [isAuthenticated, refresh, sealed]);

  if (!isHydrated && !sealed) {
    return null;
  }

  return <>{children}</>;
}
