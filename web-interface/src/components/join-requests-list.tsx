'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { listJoinRequests, resolveJoinRequest } from '@/lib/api/communities';
import type { JoinRequest } from '@/lib/api/types';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

export function JoinRequestsList({ communityDid }: { communityDid: string }) {
  const [requests, setRequests] = useState<JoinRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      const result = await listJoinRequests(communityDid);
      if (result.ok) {
        setRequests(result.data.requests);
      }
      setLoading(false);
    }
    load();
  }, [communityDid]);

  const handleResolve = async (requestId: string, action: 'approve' | 'reject') => {
    setActionLoading(requestId);
    const result = await resolveJoinRequest(requestId, action);
    if (result.ok) {
      setRequests((prev) => prev.filter((r) => r.id !== requestId));
      toast.success(action === 'approve' ? 'Request approved' : 'Request rejected');
    } else {
      toast.error(result.message);
    }
    setActionLoading(null);
  };

  if (loading) {
    return <p className="text-muted-foreground py-4">Loading...</p>;
  }

  if (requests.length === 0) {
    return <p className="text-muted-foreground py-4">No pending join requests.</p>;
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Handle</TableHead>
          <TableHead>DID</TableHead>
          <TableHead>Requested</TableHead>
          <TableHead className="text-right">Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {requests.map((r) => (
          <TableRow key={r.id}>
            <TableCell className="font-medium">{r.handle}</TableCell>
            <TableCell className="text-xs text-muted-foreground font-mono max-w-[200px] truncate">
              {r.userDid}
            </TableCell>
            <TableCell>{new Date(r.createdAt).toLocaleDateString()}</TableCell>
            <TableCell className="text-right">
              <div className="flex justify-end gap-2">
                <Button
                  size="sm"
                  onClick={() => handleResolve(r.id, 'approve')}
                  disabled={actionLoading === r.id}
                >
                  Approve
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={() => handleResolve(r.id, 'reject')}
                  disabled={actionLoading === r.id}
                >
                  Reject
                </Button>
              </div>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
