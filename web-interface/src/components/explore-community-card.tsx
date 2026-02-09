'use client';

import { useState } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import type { CommunityListAllItem } from '@/lib/api/types';
import { joinCommunity } from '@/lib/api/communities';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

interface Props {
  community: CommunityListAllItem;
  onJoined?: () => void;
}

export function ExploreCommunityCard({ community, onJoined }: Props) {
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<'none' | 'member' | 'pending'>(
    community.isMember
      ? 'member'
      : community.joinRequestStatus === 'pending'
        ? 'pending'
        : 'none'
  );

  const handleJoin = async () => {
    setLoading(true);
    const result = await joinCommunity(community.did);
    setLoading(false);

    if (!result.ok) {
      toast.error(result.message);
      return;
    }

    if (result.data.status === 'joined') {
      setStatus('member');
      toast.success('Joined community!');
    } else {
      setStatus('pending');
      toast.success('Join request sent');
    }
    onJoined?.();
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <Link
            href={`/communities/${encodeURIComponent(community.did)}`}
            className="hover:underline"
          >
            <CardTitle className="text-lg">{community.displayName}</CardTitle>
          </Link>
          <div className="flex gap-1">
            <Badge variant="secondary">{community.didMethod}</Badge>
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
          </p>
          {status === 'member' ? (
            <Badge>Member</Badge>
          ) : status === 'pending' ? (
            <Badge variant="outline">Pending</Badge>
          ) : (
            <Button size="sm" onClick={handleJoin} disabled={loading}>
              {loading
                ? 'Joining...'
                : community.joinPolicy === 'approval'
                  ? 'Request to Join'
                  : 'Join'}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
