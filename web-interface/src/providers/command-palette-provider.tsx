'use client';

import { useSyncExternalStore } from 'react';
import {
  KBarProvider,
  KBarPortal,
  KBarPositioner,
  KBarAnimator,
  KBarSearch,
  KBarResults,
  useMatches,
  type Action,
} from 'kbar';
import { useRouter } from 'next/navigation';
import { useAuthStore } from '@/store/auth-store';
import { ACCOUNT_SECTIONS, GLOSSARY_LINK } from '@/components/account/account-nav';

function subscribeViewport(onChange: () => void) {
  window.addEventListener('resize', onChange);
  return () => window.removeEventListener('resize', onChange);
}
const viewportHeight = () => window.innerHeight;
const serverHeight = () => 800;

function RenderResults() {
  const height = useSyncExternalStore(subscribeViewport, viewportHeight, serverHeight);
  // The virtualized KBarResults owns scrolling; no second scrolling wrapper.
  const maxHeight = Math.max(64, Math.min(400, Math.floor(height * 0.8) - 100));
  const { results } = useMatches();

  return (
    <KBarResults
      items={results}
      maxHeight={maxHeight}
      onRender={({ item, active }) =>
        typeof item === 'string' ? (
          <div className="px-4 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wider">
            {item}
          </div>
        ) : (
          <div
            className={`flex items-center gap-3 px-4 py-3 cursor-pointer text-sm ${
              active ? 'bg-accent text-accent-foreground' : 'text-foreground'
            }`}
          >
            {item.icon && <span className="flex-shrink-0">{item.icon}</span>}
            <div className="min-w-0 flex-1">
              <span className="block break-words">{item.name}</span>
              {item.subtitle && (
                <span className="block break-words text-xs text-muted-foreground">{item.subtitle}</span>
              )}
            </div>
          </div>
        )
      }
    />
  );
}

export function CommandPaletteProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const isAdmin = useAuthStore((s) => s.isAdmin);

  const actions: Action[] = [
    {
      id: 'dashboard',
      name: 'Home',
      shortcut: ['g', 'd'],
      section: 'Navigation',
      perform: () => router.push('/'),
    },
    {
      id: 'my-communities',
      name: 'Your communities',
      shortcut: ['g', 'c'],
      section: 'Navigation',
      perform: () => router.push('/communities'),
    },
    {
      id: 'explore',
      name: 'Explore Communities',
      shortcut: ['g', 'e'],
      section: 'Navigation',
      perform: () => router.push('/explore'),
    },
    ...[...ACCOUNT_SECTIONS, GLOSSARY_LINK].map((s) => ({
      id: `account-${s.href}`,
      name: s.title,
      subtitle: s.hint,
      section: 'Your account',
      perform: () => router.push(s.href),
    })),
    {
      id: 'create-community',
      name: 'Create Community',
      shortcut: ['g', 'n'],
      section: 'Actions',
      perform: () => router.push('/communities/new'),
    },
    ...(isAdmin
      ? [
          {
            id: 'admin-users',
            name: 'Admin: Users',
            section: 'Admin',
            perform: () => router.push('/admin/users'),
          },
          {
            id: 'admin-communities',
            name: 'Admin: Communities',
            section: 'Admin',
            perform: () => router.push('/admin/communities'),
          },
          {
            id: 'admin-invites',
            name: 'Admin: Invites',
            section: 'Admin',
            perform: () => router.push('/admin/invites'),
          },
          {
            id: 'admin-audit',
            name: 'Admin: Audit Log',
            section: 'Admin',
            perform: () => router.push('/admin/audit'),
          },
          {
            id: 'admin-settings',
            name: 'Admin: Server settings',
            section: 'Admin',
            perform: () => router.push('/admin/settings'),
          },
        ]
      : []),
  ];

  return (
    <KBarProvider actions={actions}>
      <KBarPortal>
        <KBarPositioner className="fixed inset-0 z-50 overflow-hidden bg-black/50">
          <KBarAnimator className="w-full max-w-xl overflow-hidden rounded-lg border bg-background shadow-lg">
            <KBarSearch aria-label="Search pages and actions" placeholder="Search pages and actions…" className="w-full border-b bg-transparent px-4 py-3 text-sm outline-none placeholder:text-muted-foreground" />
            <RenderResults />
          </KBarAnimator>
        </KBarPositioner>
      </KBarPortal>
      {children}
    </KBarProvider>
  );
}
