'use client';

import { useState } from 'react';
import { Compass, Globe, ExternalLink } from 'lucide-react';
import { useExploreCommunitiesQuery, usePeerCommunitiesQuery } from '@/hooks/use-communities';
import { PageHeader } from '@/components/page-header';
import { ExploreCommunityCard } from '@/components/explore-community-card';
import { EmptyState } from '@/components/empty-state';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { PeerCommunity } from '@/lib/api/types';

const PAGE_SIZE = 20;

function LocalTab() {
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState('');
  const { data, isLoading } = useExploreCommunitiesQuery(PAGE_SIZE, page * PAGE_SIZE);

  const filtered = data?.communities.filter((c) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      c.displayName.toLowerCase().includes(q) ||
      c.handle.toLowerCase().includes(q) ||
      c.description?.toLowerCase().includes(q)
    );
  });

  return (
    <>
      <div className="mb-6">
        <Input
          placeholder="Search communities..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="max-w-sm"
        />
      </div>

      {isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2">
          {[...Array(4)].map((_, i) => (
            <Skeleton key={i} className="h-36 rounded-lg" />
          ))}
        </div>
      ) : !filtered?.length ? (
        <EmptyState
          icon={Compass}
          title={search ? 'No matching communities' : 'No public communities yet'}
          description={search ? 'Try a different search term.' : 'Be the first to create one!'}
        />
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            {filtered.map((c) => (
              <ExploreCommunityCard key={c.did} community={c} />
            ))}
          </div>
          {!search && (
            <div className="flex items-center justify-center gap-2 mt-6">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage((p) => p - 1)}
                disabled={page === 0}
              >
                <ChevronLeft className="size-4" />
              </Button>
              <span className="text-sm text-muted-foreground">Page {page + 1}</span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage((p) => p + 1)}
                disabled={(data?.communities.length ?? 0) < PAGE_SIZE}
              >
                <ChevronRight className="size-4" />
              </Button>
            </div>
          )}
        </>
      )}
    </>
  );
}

function PeerCommunityCard({ community }: { community: PeerCommunity }) {
  const communityUrl = community.webUrl
    ? `${community.webUrl}/communities/${encodeURIComponent(community.did)}`
    : null;

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          {communityUrl ? (
            <a
              href={communityUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="hover:underline flex items-center gap-1.5"
            >
              <CardTitle className="text-lg">{community.displayName}</CardTitle>
              <ExternalLink className="size-3.5 text-muted-foreground" />
            </a>
          ) : (
            <CardTitle className="text-lg">{community.displayName}</CardTitle>
          )}
          <div className="flex gap-1 flex-wrap">
            <Badge variant="secondary">{community.pdsHostname}</Badge>
            {community.joinPolicy === 'approval' && (
              <Badge variant="outline">Approval</Badge>
            )}
          </div>
        </div>
        <p className="text-sm text-muted-foreground">@{community.handle}</p>
      </CardHeader>
      <CardContent>
        {community.description && (
          <p className="text-sm text-muted-foreground mb-3">{community.description}</p>
        )}
        <div className="flex items-center justify-between">
          <p className="text-xs text-muted-foreground">
            {community.memberCount} {community.memberCount === 1 ? 'member' : 'members'}
            {' · '}
            {community.visibility} · {community.joinPolicy === 'open' ? 'Open' : 'Approval required'}
          </p>
          {communityUrl ? (
            <a
              href={communityUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-primary hover:underline flex items-center gap-1"
            >
              View & Join <ExternalLink className="size-3" />
            </a>
          ) : (
            <p className="text-xs text-muted-foreground">
              Hosted on {community.pdsHostname}
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function FederatedTab() {
  const [search, setSearch] = useState('');
  const { data, isLoading } = usePeerCommunitiesQuery();

  const communities = data?.communities ?? [];
  const peers = data?.peers ?? [];
  const cachedAt = data?.cachedAt;

  const filtered = communities.filter((c) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      c.displayName.toLowerCase().includes(q) ||
      c.handle.toLowerCase().includes(q) ||
      c.description?.toLowerCase().includes(q) ||
      c.pdsHostname.toLowerCase().includes(q)
    );
  });

  const hasPeers = peers.length > 0;

  return (
    <>
      {cachedAt && (
        <p className="text-xs text-muted-foreground mb-4">
          Last synced: {new Date(cachedAt).toLocaleString()}
          {' -- '}
          {peers.filter((p) => p.healthy).length} of {peers.length} peer{peers.length !== 1 ? 's' : ''} reachable
        </p>
      )}

      {!hasPeers && !isLoading ? (
        <EmptyState
          icon={Globe}
          title="No peer PDS servers configured"
          description="Set the PEER_PDS_URLS environment variable to discover communities from other PDS instances."
        />
      ) : (
        <>
          <div className="mb-6">
            <Input
              placeholder="Search federated communities..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="max-w-sm"
            />
          </div>

          {isLoading ? (
            <div className="grid gap-4 sm:grid-cols-2">
              {[...Array(4)].map((_, i) => (
                <Skeleton key={i} className="h-36 rounded-lg" />
              ))}
            </div>
          ) : !filtered.length ? (
            <EmptyState
              icon={Globe}
              title={search ? 'No matching federated communities' : 'No communities found on peer servers'}
              description={search ? 'Try a different search term.' : 'Peer servers may not have any public communities yet.'}
            />
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
              {filtered.map((c) => (
                <PeerCommunityCard key={`${c.pdsUrl}-${c.did}`} community={c} />
              ))}
            </div>
          )}
        </>
      )}
    </>
  );
}

export default function ExplorePage() {
  return (
    <div>
      <PageHeader title="Explore Communities" description="Discover and join public communities." />

      <Tabs defaultValue="local">
        <TabsList className="mb-6">
          <TabsTrigger value="local">
            <Compass className="size-4 mr-1.5" />
            Local
          </TabsTrigger>
          <TabsTrigger value="federated">
            <Globe className="size-4 mr-1.5" />
            Federated
          </TabsTrigger>
        </TabsList>

        <TabsContent value="local">
          <LocalTab />
        </TabsContent>

        <TabsContent value="federated">
          <FederatedTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
