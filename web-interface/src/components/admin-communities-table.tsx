'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { listAllCommunities } from '@/lib/api/communities';
import type { CommunityListAllItem } from '@/lib/api/types';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

export function AdminCommunitiesTable() {
  const [communities, setCommunities] = useState<CommunityListAllItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      const result = await listAllCommunities(50, 0, 'all');
      if (result.ok) {
        setCommunities(result.data.communities);
      }
      setLoading(false);
    }
    load();
  }, []);

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
          <TableHead>Visibility</TableHead>
          <TableHead>Join Policy</TableHead>
          <TableHead>Members</TableHead>
          <TableHead>Created</TableHead>
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
              <Badge variant={c.visibility === 'public' ? 'secondary' : 'outline'}>
                {c.visibility}
              </Badge>
            </TableCell>
            <TableCell>
              <Badge variant={c.joinPolicy === 'open' ? 'secondary' : 'outline'}>
                {c.joinPolicy}
              </Badge>
            </TableCell>
            <TableCell>{c.memberCount}</TableCell>
            <TableCell>{new Date(c.createdAt).toLocaleDateString()}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
