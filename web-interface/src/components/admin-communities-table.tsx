'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { listAllCommunities, suspendCommunity, unsuspendCommunity } from '@/lib/api/communities';
import type { CommunityListAllItem } from '@/lib/api/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { toast } from 'sonner';

function statusBadgeVariant(status?: string): 'default' | 'secondary' | 'outline' | 'destructive' {
  switch (status) {
    case 'suspended': return 'outline';
    case 'takendown': return 'destructive';
    default: return 'secondary';
  }
}

export function AdminCommunitiesTable() {
  const [communities, setCommunities] = useState<CommunityListAllItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    async function load() {
      setLoading(true);
      const result = await listAllCommunities(50, 0, 'all');
      if (result.ok) {
        setCommunities(result.data.communities);
      }
      setLoading(false);
    }
    load();
  }, [refreshKey]);

  async function handleSuspend(did: string) {
    const reason = prompt('Reason for suspension (optional):');
    const result = await suspendCommunity(did, reason || undefined);
    if (result.ok) {
      toast.success('Community suspended');
      setRefreshKey((k) => k + 1);
    } else {
      toast.error(result.message);
    }
  }

  async function handleUnsuspend(did: string) {
    const result = await unsuspendCommunity(did);
    if (result.ok) {
      toast.success('Community unsuspended');
      setRefreshKey((k) => k + 1);
    } else {
      toast.error(result.message);
    }
  }

  if (loading) {
    return <p className="text-muted-foreground py-4">Loading...</p>;
  }

  if (communities.length === 0) {
    return <p className="text-muted-foreground py-4">No communities yet.</p>;
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead>Handle</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Visibility</TableHead>
          <TableHead>Members</TableHead>
          <TableHead>Created</TableHead>
          <TableHead>Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {communities.map((c) => (
          <TableRow key={c.did}>
            <TableCell className="font-medium">
              <Link
                href={`/communities/${encodeURIComponent(c.did)}`}
                className="hover:underline"
              >
                {c.displayName}
              </Link>
            </TableCell>
            <TableCell className="text-muted-foreground">@{c.handle}</TableCell>
            <TableCell>
              <Badge variant={statusBadgeVariant(c.status)}>
                {c.status || 'active'}
              </Badge>
            </TableCell>
            <TableCell>
              <Badge variant={c.visibility === 'public' ? 'secondary' : 'outline'}>
                {c.visibility}
              </Badge>
            </TableCell>
            <TableCell>{c.memberCount}</TableCell>
            <TableCell>{new Date(c.createdAt).toLocaleDateString()}</TableCell>
            <TableCell>
              {(!c.status || c.status === 'active') && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handleSuspend(c.did)}
                >
                  Suspend
                </Button>
              )}
              {c.status === 'suspended' && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handleUnsuspend(c.did)}
                >
                  Unsuspend
                </Button>
              )}
              {c.status === 'takendown' && (
                <span className="text-muted-foreground text-sm">Taken down</span>
              )}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
