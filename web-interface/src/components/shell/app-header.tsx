'use client';

import { usePathname } from 'next/navigation';
import { useKBar } from 'kbar';
import { Search } from 'lucide-react';
import { SidebarTrigger } from '@/components/ui/sidebar';
import { Separator } from '@/components/ui/separator';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { Button } from '@/components/ui/button';

function getBreadcrumbs(pathname: string): { label: string; href?: string }[] {
  const segments = pathname.split('/').filter(Boolean);
  const crumbs: { label: string; href?: string }[] = [];

  const labelMap: Record<string, string> = {
    communities: 'Communities',
    explore: 'Explore',
    admin: 'Admin',
    users: 'Users',
    invites: 'Invites',
    audit: 'Audit Log',
    settings: 'Settings',
    new: 'New',
  };

  let path = '';
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    path += `/${segment}`;
    const isLast = i === segments.length - 1;

    // If it looks like a DID, show shortened version
    const label = segment.startsWith('did%3A') || segment.startsWith('did:')
      ? decodeURIComponent(segment).slice(0, 24) + '...'
      : labelMap[segment] || segment;

    crumbs.push({
      label,
      href: isLast ? undefined : path,
    });
  }

  return crumbs;
}

export function AppHeader() {
  const pathname = usePathname();
  const { query } = useKBar();
  const crumbs = getBreadcrumbs(pathname ?? '/');

  return (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
      <SidebarTrigger className="-ml-1" />
      <Separator orientation="vertical" className="mr-2 !h-4" />
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink href="/">Home</BreadcrumbLink>
          </BreadcrumbItem>
          {crumbs.map((crumb, i) => (
            <span key={i} className="contents">
              <BreadcrumbSeparator />
              <BreadcrumbItem>
                {crumb.href ? (
                  <BreadcrumbLink href={crumb.href}>{crumb.label}</BreadcrumbLink>
                ) : (
                  <BreadcrumbPage>{crumb.label}</BreadcrumbPage>
                )}
              </BreadcrumbItem>
            </span>
          ))}
        </BreadcrumbList>
      </Breadcrumb>
      <div className="ml-auto">
        <Button
          variant="outline"
          size="sm"
          className="gap-2 text-muted-foreground"
          onClick={query.toggle}
        >
          <Search className="size-4" />
          <span className="hidden sm:inline">Search</span>
          <kbd className="pointer-events-none hidden h-5 select-none items-center gap-1 rounded border bg-muted px-1.5 font-mono text-[10px] font-medium opacity-100 sm:flex">
            <span className="text-xs">&#x2318;</span>K
          </kbd>
        </Button>
      </div>
    </header>
  );
}
