'use client';

import { AuthGuard } from '@/components/auth-guard';
import { AppShell } from '@/components/shell/app-shell';
import { CommandPaletteProvider } from '@/providers/command-palette-provider';
import { PassCollector } from '@/components/pen-names/pass-collector';

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <AuthGuard>
      <CommandPaletteProvider>
        <AppShell>{children}</AppShell>
        <PassCollector />
      </CommandPaletteProvider>
    </AuthGuard>
  );
}
