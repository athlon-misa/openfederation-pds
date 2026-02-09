'use client';

import { useEffect, useState } from 'react';
import { listAllCommunities } from '@/lib/api/communities';
import type { CommunityListAllItem } from '@/lib/api/types';
import { ExploreCommunityCard } from '@/components/explore-community-card';

export default function ExplorePage() {
  const [communities, setCommunities] = useState<CommunityListAllItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    async function fetchCommunities() {
      const result = await listAllCommunities(50, 0, 'public');
      if (cancelled) return;
      if (result.ok) {
        setCommunities(result.data.communities);
      }
      setLoading(false);
    }
    fetchCommunities();
    return () => { cancelled = true; };
  }, [refreshKey]);

  const reload = () => setRefreshKey((k) => k + 1);

  return (
    <div>
      <h1 className="text-2xl font-bold mb-6">Explore Communities</h1>
      {loading ? (
        <p className="text-muted-foreground">Loading...</p>
      ) : communities.length === 0 ? (
        <p className="text-muted-foreground">No public communities yet.</p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {communities.map((c) => (
            <ExploreCommunityCard key={c.did} community={c} onJoined={reload} />
          ))}
        </div>
      )}
    </div>
  );
}
