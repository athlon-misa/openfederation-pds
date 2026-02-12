'use client';

import Link from 'next/link';
import { Globe, Users, Ticket, Building2, Compass, Plus } from 'lucide-react';
import { useAuthStore } from '@/store/auth-store';
import { useMyCommunitiesQuery } from '@/hooks/use-communities';
import { useServerConfigQuery } from '@/hooks/use-server-config';
import { PageHeader } from '@/components/page-header';
import { StatCard } from '@/components/stat-card';
import { CommunityCard } from '@/components/community-card';
import { EmptyState } from '@/components/empty-state';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';

export default function DashboardPage() {
  const handle = useAuthStore((s) => s.handle);
  const isAdmin = useAuthStore((s) => s.isAdmin);
  const { data: myCommunities, isLoading: commLoading } = useMyCommunitiesQuery(6, 0);
  const { data: serverConfig, isLoading: configLoading } = useServerConfigQuery();

  return (
    <div>
      <PageHeader
        title={`Welcome back, ${handle}`}
        description="Manage your communities and explore new ones."
      >
        <Link href="/communities/new">
          <Button>
            <Plus className="size-4 mr-2" />
            Create Community
          </Button>
        </Link>
      </PageHeader>

      {/* Admin stats */}
      {isAdmin && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 mb-8">
          {configLoading ? (
            <>
              {[...Array(4)].map((_, i) => (
                <Skeleton key={i} className="h-24 rounded-lg" />
              ))}
            </>
          ) : serverConfig ? (
            <>
              <StatCard label="Total Users" value={serverConfig.stats.totalUsers} icon={Users} />
              <StatCard label="Pending Approvals" value={serverConfig.stats.pendingUsers} icon={Users} />
              <StatCard label="Active Communities" value={serverConfig.stats.activeCommunities} icon={Building2} />
              <StatCard label="Active Invites" value={serverConfig.stats.activeInvites} icon={Ticket} />
            </>
          ) : null}
        </div>
      )}

      {/* My communities */}
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold">My Communities</h2>
        <Link href="/communities" className="text-sm text-muted-foreground hover:text-foreground">
          View all
        </Link>
      </div>

      {commLoading ? (
        <div className="grid gap-4 sm:grid-cols-2">
          {[...Array(4)].map((_, i) => (
            <Skeleton key={i} className="h-32 rounded-lg" />
          ))}
        </div>
      ) : !myCommunities?.communities.length ? (
        <EmptyState
          icon={Globe}
          title="No communities yet"
          description="Create your first community or explore existing ones."
        >
          <div className="flex gap-2">
            <Link href="/communities/new">
              <Button size="sm">Create Community</Button>
            </Link>
            <Link href="/explore">
              <Button size="sm" variant="outline">
                <Compass className="size-4 mr-2" />
                Explore
              </Button>
            </Link>
          </div>
        </EmptyState>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {myCommunities.communities.slice(0, 6).map((community) => (
            <CommunityCard key={community.did} community={community} />
          ))}
        </div>
      )}
    </div>
  );
}
