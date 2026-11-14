'use client';

import { useAuthStore } from '@/store/auth-store';
import { CommandPaletteProvider } from '@/providers/command-palette-provider';
import { AppShell } from './app-shell';

/** Definitions are public, but signed-in readers keep the dashboard navigation. */
export function GlossaryShell({ children }: { children: React.ReactNode }) {
  const signedIn = useAuthStore((s) => s.isAuthenticated);
  if (signedIn) {
    return <CommandPaletteProvider><AppShell>{children}</AppShell></CommandPaletteProvider>;
  }
  return <main id="main-content" className="min-h-screen bg-background px-4 py-8">{children}</main>;
}
