'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Compass, Globe, ExternalLink } from 'lucide-react';
import { useExploreCommunitiesQuery, useDiscoverCommunitiesQuery } from '@/hooks/use-communities';
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
import type { DiscoveredCommunity, DiscoveryPeerStatus } from '@/lib/api/types';
import { hostLabel, httpUrl, peerErrorLabel } from '@/lib/discovery';

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

function DiscoveredCommunityCard({ community }: { community: DiscoveredCommunity }) {
  const isLocal = community.source === 'local';
  // Where the community lives. A peer's URL is only linked when it is plain
  // http(s); the server checks this too, but the page never builds a link
  // from anything else.
  const home = httpUrl(community.pdsUrl);
  const hostname = hostLabel(community.pdsUrl);
  const localHref = `/communities/${encodeURIComponent(community.did)}`;

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          {isLocal ? (
            <Link href={localHref} className="hover:underline">
              <CardTitle className="text-lg">{community.displayName}</CardTitle>
            </Link>
          ) : (
            <CardTitle className="text-lg">{community.displayName}</CardTitle>
          )}
          <div className="flex gap-1 flex-wrap">
            {isLocal ? (
              <Badge variant="secondary">This server</Badge>
            ) : (
              <Badge variant="secondary">{hostname}</Badge>
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
          </p>
          {isLocal ? (
            <Link href={localHref} className="text-xs text-primary hover:underline">
              View & Join
            </Link>
          ) : home ? (
            <a
              href={home.href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-primary hover:underline flex items-center gap-1"
            >
              Hosted on {hostname} <ExternalLink className="size-3" />
            </a>
          ) : (
            <p className="text-xs text-muted-foreground">Hosted on {hostname}</p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function PeerStatusSummary({ peers }: { peers: DiscoveryPeerStatus[] }) {
  if (peers.length === 0) {
    return (
      <p className="text-xs text-muted-foreground mb-4">
        No peer servers configured (FEDERATION_PEERS): showing this server&apos;s communities only.
      </p>
    );
  }
  const failed = peers.filter((p) => p.status !== 'ok');
  const answered = peers.length - failed.length;
  return (
    <div className="text-xs text-muted-foreground mb-4 space-y-1">
      <p>
        {answered} of {peers.length} peer server{peers.length !== 1 ? 's' : ''} answered
      </p>
      {failed.length > 0 && (
        <p className="flex flex-wrap items-center gap-1">
          <span>Didn&apos;t answer:</span>
          {failed.map((p) => (
            <Badge key={p.url} variant="outline" title={p.url}>
              {hostLabel(p.url)} ({peerErrorLabel(p.error)})
            </Badge>
          ))}
        </p>
      )}
    </div>
  );
}

function FederatedTab() {
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  // Cursors of the pages visited so far; cursors[page] fetches that page.
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const [page, setPage] = useState(0);

  // The server filters; wait for typing to pause before asking it.
  useEffect(() => {
    const next = search.trim();
    if (next === q) return;
    const timer = setTimeout(() => {
      setQ(next);
      setCursors([undefined]);
      setPage(0);
    }, 300);
    return () => clearTimeout(timer);
  }, [search, q]);

  const { data, isLoading, isError } = useDiscoverCommunitiesQuery(PAGE_SIZE, cursors[page], q || undefined);

  const communities = data?.communities ?? [];
  const peers = data?.peers ?? [];
  const nextCursor = data?.cursor;

  const goNext = () => {
    if (!nextCursor) return;
    setCursors((prev) => [...prev.slice(0, page + 1), nextCursor]);
    setPage((p) => p + 1);
  };

  return (
    <>
      {data && <PeerStatusSummary peers={peers} />}

      <div className="mb-6">
        <Input
          placeholder="Search communities on this server and its peers..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="max-w-sm"
          maxLength={100}
        />
      </div>

      {isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2">
          {[...Array(4)].map((_, i) => (
            <Skeleton key={i} className="h-36 rounded-lg" />
          ))}
        </div>
      ) : isError ? (
        <EmptyState
          icon={Globe}
          title="Could not load communities"
          description="The server did not answer. Try again in a moment."
        />
      ) : !communities.length ? (
        <EmptyState
          icon={Globe}
          title={q ? 'No matching communities' : 'No public communities found'}
          description={q ? 'Try a different search term.' : 'Neither this server nor its peers list any public communities yet.'}
        />
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            {communities.map((c) => (
              <DiscoveredCommunityCard key={c.did} community={c} />
            ))}
          </div>
          {(page > 0 || nextCursor) && (
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
              <Button variant="outline" size="sm" onClick={goNext} disabled={!nextCursor}>
                <ChevronRight className="size-4" />
              </Button>
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
