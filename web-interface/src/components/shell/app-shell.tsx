'use client';

import { SidebarProvider, SidebarInset } from '@/components/ui/sidebar';
import { AppSidebar } from './app-sidebar';
import { AppHeader } from './app-header';

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <SidebarProvider>
      <a href="#main-content" className="skip-to-content">Skip to content</a>
      <AppSidebar />
      <SidebarInset className="min-w-0">
        <AppHeader />
        <main id="main-content" tabIndex={-1} className="app-content flex-1 min-w-0 p-4 md:p-6 lg:p-8 outline-none">{children}</main>
      </SidebarInset>
    </SidebarProvider>
  );
}
