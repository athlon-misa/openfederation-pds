'use client';

import { useState } from 'react';
import { Compass } from 'lucide-react';
import { useExploreCommunitiesQuery } from '@/hooks/use-communities';
import { PageHeader } from '@/components/page-header';
import { ExploreCommunityCard } from '@/components/explore-community-card';
import { EmptyState } from '@/components/empty-state';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ChevronLeft, ChevronRight } from 'lucide-react';

const PAGE_SIZE = 20;

export default function ExplorePage() {
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
    <div>
      <PageHeader title="Explore Communities" description="Discover and join public communities." />

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
    </div>
  );
}
