'use client';

import { useEffect, useRef } from 'react';
import { useAuthStore } from '@/store/auth-store';

export function StoreHydration({ children }: { children: React.ReactNode }) {
  const hydrate = useAuthStore((s) => s.hydrate);
  const isHydrated = useAuthStore((s) => s.isHydrated);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const refresh = useAuthStore((s) => s.refresh);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  // Set up auto-refresh every 10 minutes when authenticated
  useEffect(() => {
    if (isAuthenticated) {
      intervalRef.current = setInterval(() => {
        refresh();
      }, 10 * 60 * 1000);
    }
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
  }, [isAuthenticated, refresh]);

  if (!isHydrated) {
    return null;
  }

  return <>{children}</>;
}
