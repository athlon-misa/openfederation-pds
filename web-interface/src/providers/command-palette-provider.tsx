'use client';

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

function RenderResults() {
  const { results } = useMatches();

  return (
    <KBarResults
      items={results}
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
            <div className="flex flex-col">
              <span>{item.name}</span>
              {item.subtitle && (
                <span className="text-xs text-muted-foreground">{item.subtitle}</span>
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
      name: 'Dashboard',
      shortcut: ['g', 'd'],
      section: 'Navigation',
      perform: () => router.push('/'),
    },
    {
      id: 'my-communities',
      name: 'My Communities',
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
        ]
      : []),
  ];

  return (
    <KBarProvider actions={actions}>
      <KBarPortal>
        <KBarPositioner className="fixed inset-0 z-50 bg-black/50">
          <KBarAnimator className="w-full max-w-lg overflow-hidden rounded-lg border bg-background shadow-lg">
            <KBarSearch className="w-full border-b bg-transparent px-4 py-3 text-sm outline-none placeholder:text-muted-foreground" />
            <div className="max-h-80 overflow-y-auto">
              <RenderResults />
            </div>
          </KBarAnimator>
        </KBarPositioner>
      </KBarPortal>
      {children}
    </KBarProvider>
  );
}
