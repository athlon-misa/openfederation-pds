'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuthStore } from '@/store/auth-store';

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const hasAdminAccess = useAuthStore((s) => s.hasAdminAccess);
  const router = useRouter();

  useEffect(() => {
    if (!hasAdminAccess) {
      router.replace('/');
    }
  }, [hasAdminAccess, router]);

  if (!hasAdminAccess) return null;

  return <>{children}</>;
}
