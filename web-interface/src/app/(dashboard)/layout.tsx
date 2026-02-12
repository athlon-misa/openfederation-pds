'use client';

import { AuthGuard } from '@/components/auth-guard';
import { AppShell } from '@/components/shell/app-shell';

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <AuthGuard>
      <AppShell>{children}</AppShell>
    </AuthGuard>
  );
}
