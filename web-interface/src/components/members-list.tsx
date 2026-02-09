'use client';

import { useEffect, useState } from 'react';
import { listMembers } from '@/lib/api/communities';
import type { CommunityMember } from '@/lib/api/types';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';

export function MembersList({ communityDid }: { communityDid: string }) {
  const [members, setMembers] = useState<CommunityMember[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      const result = await listMembers(communityDid);
      if (result.ok) {
        setMembers(result.data.members);
      }
      setLoading(false);
    }
    load();
  }, [communityDid]);

  if (loading) {
    return <p className="text-muted-foreground py-4">Loading...</p>;
  }

  if (members.length === 0) {
    return <p className="text-muted-foreground py-4">No members yet.</p>;
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Handle</TableHead>
          <TableHead>DID</TableHead>
          <TableHead>Role</TableHead>
          <TableHead>Joined</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {members.map((m) => (
          <TableRow key={m.did}>
            <TableCell className="font-medium">{m.handle}</TableCell>
            <TableCell className="text-xs text-muted-foreground font-mono max-w-[200px] truncate">
              {m.did}
            </TableCell>
            <TableCell>
              <Badge variant={m.role === 'owner' ? 'default' : 'secondary'}>
                {m.role}
              </Badge>
            </TableCell>
            <TableCell>{new Date(m.joinedAt).toLocaleDateString()}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
