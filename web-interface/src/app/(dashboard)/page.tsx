'use client';

import Link from 'next/link';
import { ArrowRight, Globe, Users, Ticket, Building2, Compass, Plus, SlidersHorizontal, ScrollText } from 'lucide-react';
import { useAuthStore } from '@/store/auth-store';
import { useMyCommunitiesQuery } from '@/hooks/use-communities';
import { useServerConfigQuery } from '@/hooks/use-server-config';
import { PageHeader } from '@/components/page-header';
import { StatCard } from '@/components/stat-card';
import { CommunityCard } from '@/components/community-card';
import { EmptyState } from '@/components/empty-state';
import { QueryFeedback } from '@/components/query-feedback';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';

export default function DashboardPage() {
  const handle = useAuthStore((s) => s.handle);
  const isAdmin = useAuthStore((s) => s.isAdmin);
  const communities = useMyCommunitiesQuery(6, 0);
  const server = useServerConfigQuery({ enabled: isAdmin });
  const stats = server.data?.stats;

  return (
    <div>
      <PageHeader title={isAdmin ? 'Server overview' : 'Your home'} description={`Welcome back${handle ? `, ${handle}` : ''}. ${isAdmin ? 'A clear view of your people and communities.' : 'Your communities, identity, and connections in one place.'}`}>
        <Button asChild><Link href="/communities/new"><Plus className="size-4" aria-hidden />Create community</Link></Button>
      </PageHeader>

      {isAdmin && <section aria-label="Server activity" className="mb-8 space-y-4">
        <QueryFeedback error={server.error} hasData={!!server.data} onRetry={() => { void server.refetch(); }} isFetching={server.isFetching} subject="server overview" />
        {server.isLoading ? <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4" role="status" aria-label="Loading server overview">
          {Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-32 rounded-lg" />)}
        </div> : stats && <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard label="Total users" value={stats.totalUsers} icon={Users} href="/admin/users" description="View and manage accounts" />
            <StatCard label="Pending approvals" value={stats.pendingUsers} icon={Users} href="/admin/users?status=pending" description="Review new registrations" />
            <StatCard label="Active communities" value={stats.activeCommunities} icon={Building2} href="/admin/communities" description="Manage community spaces" />
            <StatCard label="Active invites" value={stats.activeInvites} icon={Ticket} href="/admin/invites" description="Invite people to your server" />
          </div>
          {stats.pendingUsers > 0 && <div className="flex flex-wrap items-center gap-4 rounded-lg border border-primary/25 bg-accent p-5">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary"><Users className="size-5" aria-hidden /></div>
            <div className="min-w-48 flex-1"><h2 className="font-semibold">{stats.pendingUsers === 1 ? 'Someone is waiting to join' : `${stats.pendingUsers} people are waiting to join`}</h2>
              <p className="mt-1 text-sm text-muted-foreground">Review their registrations and decide who can access your server.</p></div>
            <Button asChild><Link href="/admin/users?status=pending">Review registrations<ArrowRight className="size-4" aria-hidden /></Link></Button>
          </div>}
        </>}
        <nav aria-label="Administration shortcuts" className="flex flex-wrap gap-2">
          <Button asChild variant="outline" size="sm"><Link href="/admin/invites"><Ticket aria-hidden />Manage invites</Link></Button>
          <Button asChild variant="outline" size="sm"><Link href="/admin/audit"><ScrollText aria-hidden />View audit log</Link></Button>
          <Button asChild variant="outline" size="sm"><Link href="/admin/settings"><SlidersHorizontal aria-hidden />Server settings</Link></Button>
        </nav>
      </section>}

      <section aria-labelledby="my-communities-title">
        <div className="mb-4 flex flex-wrap items-end justify-between gap-2">
          <div><h2 id="my-communities-title" className="text-lg font-semibold">Your communities</h2><p className="mt-1 text-sm text-muted-foreground">The spaces you belong to and help shape.</p></div>
          <Link href="/communities" className="inline-flex items-center gap-1 rounded text-sm font-medium text-primary underline-offset-4 hover:underline">View all<ArrowRight className="size-4" aria-hidden /></Link>
        </div>
        <QueryFeedback error={communities.error} hasData={!!communities.data} onRetry={() => { void communities.refetch(); }} isFetching={communities.isFetching} subject="your communities" />
        {communities.isLoading ? <div className="grid gap-4 sm:grid-cols-2" role="status" aria-label="Loading your communities">
          {Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-32 rounded-lg" />)}
        </div> : communities.data?.communities.length ? <div className="grid gap-4 sm:grid-cols-2">
          {communities.data.communities.slice(0, 6).map((community) => <CommunityCard key={community.did} community={community} />)}
        </div> : communities.data && <EmptyState icon={Globe} title="Make a space of your own" description="Create a community for your people, or discover one to join. Your identity travels with you.">
          <div className="flex flex-wrap justify-center gap-2">
            <Button asChild size="sm"><Link href="/communities/new"><Plus aria-hidden />Create community</Link></Button>
            <Button asChild size="sm" variant="outline"><Link href="/explore"><Compass aria-hidden />Explore communities</Link></Button>
          </div>
        </EmptyState>}
      </section>
    </div>
  );
}
