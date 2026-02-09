'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { listMyCommunities } from '@/lib/api/communities';
import type { CommunityListItem } from '@/lib/api/types';
import { CommunityCard } from '@/components/community-card';
import { Button } from '@/components/ui/button';

export default function CommunitiesPage() {
  const [communities, setCommunities] = useState<CommunityListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    async function load() {
      const result = await listMyCommunities();
      if (result.ok) {
        setCommunities(result.data.communities);
      } else {
        setError(result.message);
      }
      setLoading(false);
    }
    load();
  }, []);

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">My Communities</h1>
        <Link href="/communities/new">
          <Button>Create Community</Button>
        </Link>
      </div>

      {loading && <p className="text-muted-foreground">Loading...</p>}

      {error && (
        <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {!loading && !error && communities.length === 0 && (
        <div className="rounded-md border border-dashed p-8 text-center">
          <p className="text-muted-foreground">No communities yet.</p>
          <Link href="/communities/new">
            <Button variant="outline" className="mt-4">
              Create your first community
            </Button>
          </Link>
        </div>
      )}

      {communities.length > 0 && (
        <div className="grid gap-4 sm:grid-cols-2">
          {communities.map((community) => (
            <CommunityCard key={community.did} community={community} />
          ))}
        </div>
      )}
    </div>
  );
}
