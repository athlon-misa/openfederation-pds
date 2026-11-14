'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  BookOpen,
  LayoutDashboard,
  Globe,
  Compass,
  Users,
  Building2,
  KeyRound,
  Ticket,
  ScrollText,
  SlidersHorizontal,
  UserRound,
  LogOut,
  ChevronUp,
} from 'lucide-react';
import { useAuthStore } from '@/store/auth-store';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from '@/components/ui/sidebar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

const mainNav = [
  { title: 'Home', href: '/', icon: LayoutDashboard },
  { title: 'Your communities', href: '/communities', icon: Globe },
  { title: 'Explore communities', href: '/explore', icon: Compass },
  // Identity, recovery, devices, moving, pen names: sub-navigation inside (#404).
  { title: 'Your account & identity', href: '/account', icon: UserRound },
  { title: 'Glossary', href: '/glossary', icon: BookOpen },
];

// Each admin nav item specifies which PDS roles can see it
const adminNav = [
  { title: 'Users', href: '/admin/users', icon: Users, roles: ['admin', 'moderator', 'auditor'] },
  { title: 'Communities', href: '/admin/communities', icon: Building2, roles: ['admin'] },
  { title: 'Partner Keys', href: '/admin/partner-keys', icon: KeyRound, roles: ['admin', 'partner-manager', 'auditor'] },
  { title: 'Invites', href: '/admin/invites', icon: Ticket, roles: ['admin', 'moderator', 'auditor'] },
  { title: 'Audit Log', href: '/admin/audit', icon: ScrollText, roles: ['admin', 'auditor'] },
  { title: 'Server settings', href: '/admin/settings', icon: SlidersHorizontal, roles: ['admin'] },
];

export function AppSidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const handle = useAuthStore((s) => s.handle);
  const email = useAuthStore((s) => s.email);
  const roles = useAuthStore((s) => s.roles);
  const hasAdminAccess = useAuthStore((s) => s.hasAdminAccess);
  const logout = useAuthStore((s) => s.logout);

  const handleLogout = async () => {
    await logout();
    router.push('/login');
  };

  const isActive = (href: string) => {
    if (href === '/') return pathname === '/';
    return pathname?.startsWith(href) ?? false;
  };

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild>
              <Link href="/">
                <div data-brand-mark className="flex aspect-square size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
                  <Globe className="brand-basic size-4" />
                  <span className="brand-newsrooms brand-newsrooms-mark" aria-hidden="true">“</span>
                  <svg className="brand-federation size-6" viewBox="0 0 44 44" aria-hidden="true">
                    <rect x="6" y="6" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5" />
                    <rect x="24" y="24" width="14" height="14" fill="currentColor" />
                    <path d="m20 20 4 4" stroke="currentColor" strokeWidth="2.5" />
                  </svg>
                </div>
                <div className="grid flex-1 text-left text-sm leading-tight">
                  <span className="truncate font-semibold">
                    <span className="brand-basic">OpenFederation</span>
                    <span className="brand-federation font-mono text-xs tracking-tight">open<span className="text-primary">::</span>federation</span>
                    <span className="brand-newsrooms brand-newsrooms-name">Open<br />{' '}<em>Newsrooms</em></span>
                  </span>
                  <span className="brand-subtitle truncate text-xs text-muted-foreground">PDS</span>
                </div>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Main</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {mainNav.map((item) => (
                <SidebarMenuItem key={item.href}>
                  <SidebarMenuButton
                    asChild
                    isActive={isActive(item.href)}
                    tooltip={item.title}
                  >
                    <Link href={item.href} aria-current={isActive(item.href) ? 'page' : undefined}>
                      <item.icon />
                      <span>{item.title}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        {hasAdminAccess && (
          <SidebarGroup>
            <SidebarGroupLabel>Admin</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {adminNav
                  .filter((item) => item.roles.some((r) => roles.includes(r)))
                  .map((item) => (
                  <SidebarMenuItem key={item.href}>
                    <SidebarMenuButton
                      asChild
                      isActive={isActive(item.href)}
                      tooltip={item.title}
                    >
                      <Link href={item.href} aria-current={isActive(item.href) ? 'page' : undefined}>
                        <item.icon />
                        <span>{item.title}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <SidebarMenuButton
                  size="lg"
                  className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
                >
                  <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-muted">
                    <UserRound className="size-4" aria-hidden />
                  </div>
                  <div className="grid flex-1 text-left text-sm leading-tight">
                    <span className="truncate font-semibold">{handle}</span>
                    <span className="truncate text-xs text-muted-foreground">{email}</span>
                  </div>
                  <ChevronUp className="ml-auto size-4" />
                </SidebarMenuButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                className="w-(--radix-dropdown-menu-trigger-width) min-w-56 rounded-lg"
                side="top"
                align="end"
                sideOffset={4}
              >
                <DropdownMenuItem asChild>
                  <Link href="/account">
                    <UserRound className="mr-2 size-4" />
                    Your account
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={handleLogout}>
                  <LogOut className="mr-2 size-4" />
                  Log out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>

      <SidebarRail />
    </Sidebar>
  );
}
