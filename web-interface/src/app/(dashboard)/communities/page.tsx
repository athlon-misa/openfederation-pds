'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Globe } from 'lucide-react';
import { useMyCommunitiesQuery } from '@/hooks/use-communities';
import { PageHeader } from '@/components/page-header';
import { CommunityCard } from '@/components/community-card';
import { EmptyState } from '@/components/empty-state';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ChevronLeft, ChevronRight } from 'lucide-react';

const PAGE_SIZE = 20;

export default function CommunitiesPage() {
  const [page, setPage] = useState(0);
  const { data, isLoading, error } = useMyCommunitiesQuery(PAGE_SIZE, page * PAGE_SIZE);

  return (
    <div>
      <PageHeader title="My Communities" description="Communities you own or belong to.">
        <Link href="/communities/new">
          <Button>Create Community</Button>
        </Link>
      </PageHeader>

      {error && (
        <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive mb-4">
          {error.message}
        </div>
      )}

      {isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2">
          {[...Array(4)].map((_, i) => (
            <Skeleton key={i} className="h-32 rounded-lg" />
          ))}
        </div>
      ) : !data?.communities.length ? (
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
              <Button size="sm" variant="outline">Explore</Button>
            </Link>
          </div>
        </EmptyState>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            {data.communities.map((community) => (
              <CommunityCard key={community.did} community={community} />
            ))}
          </div>
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
              disabled={data.communities.length < PAGE_SIZE}
            >
              <ChevronRight className="size-4" />
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
