'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { toast } from 'sonner';
import { getCommunity, joinCommunity, leaveCommunity } from '@/lib/api/communities';
import type { CommunityDetail } from '@/lib/api/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { MembersList } from '@/components/members-list';
import { JoinRequestsList } from '@/components/join-requests-list';
import { CommunitySettingsForm } from '@/components/community-settings-form';

export default function CommunityDetailPage() {
  const params = useParams();
  const did = decodeURIComponent(params.did as string);

  const [community, setCommunity] = useState<CommunityDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    async function fetchCommunity() {
      const result = await getCommunity(did);
      if (cancelled) return;
      if (result.ok) {
        setCommunity(result.data);
      } else {
        toast.error(result.message);
      }
      setLoading(false);
    }
    fetchCommunity();
    return () => { cancelled = true; };
  }, [did, refreshKey]);

  const reload = () => setRefreshKey((k) => k + 1);

  const handleJoin = async () => {
    setActionLoading(true);
    const result = await joinCommunity(did);
    setActionLoading(false);
    if (result.ok) {
      if (result.data.status === 'joined') {
        toast.success('Joined community!');
      } else {
        toast.success('Join request sent');
      }
      reload();
    } else {
      toast.error(result.message);
    }
  };

  const handleLeave = async () => {
    setActionLoading(true);
    const result = await leaveCommunity(did);
    setActionLoading(false);
    if (result.ok) {
      toast.success('Left community');
      reload();
    } else {
      toast.error(result.message);
    }
  };

  if (loading) {
    return <p className="text-muted-foreground">Loading...</p>;
  }

  if (!community) {
    return <p className="text-muted-foreground">Community not found.</p>;
  }

  return (
    <div>
      {/* Header */}
      <div className="flex flex-col gap-4 mb-6 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <h1 className="text-2xl font-bold">{community.displayName}</h1>
            <Badge variant="secondary">{community.didMethod}</Badge>
            <Badge variant="outline">{community.visibility}</Badge>
            <Badge variant="outline">{community.joinPolicy}</Badge>
          </div>
          <p className="text-sm text-muted-foreground">@{community.handle}</p>
          {community.description && (
            <p className="text-sm text-muted-foreground mt-2">{community.description}</p>
          )}
          <p className="text-xs text-muted-foreground mt-1">
            {community.memberCount} {community.memberCount === 1 ? 'member' : 'members'}
          </p>
        </div>
        <div className="flex gap-2">
          {community.isMember && !community.isOwner && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleLeave}
              disabled={actionLoading}
            >
              {actionLoading ? 'Leaving...' : 'Leave'}
            </Button>
          )}
          {!community.isMember && community.joinRequestStatus === 'pending' && (
            <Badge variant="outline">Request Pending</Badge>
          )}
          {!community.isMember && !community.joinRequestStatus && (
            <Button size="sm" onClick={handleJoin} disabled={actionLoading}>
              {actionLoading
                ? 'Joining...'
                : community.joinPolicy === 'approval'
                  ? 'Request to Join'
                  : 'Join'}
            </Button>
          )}
        </div>
      </div>

      {/* Tabs */}
      <Tabs defaultValue="members">
        <TabsList>
          <TabsTrigger value="members">Members</TabsTrigger>
          {community.isOwner && community.joinPolicy === 'approval' && (
            <TabsTrigger value="requests">Join Requests</TabsTrigger>
          )}
          {community.isOwner && (
            <TabsTrigger value="settings">Settings</TabsTrigger>
          )}
        </TabsList>
        <TabsContent value="members" className="mt-4">
          <MembersList communityDid={did} />
        </TabsContent>
        {community.isOwner && community.joinPolicy === 'approval' && (
          <TabsContent value="requests" className="mt-4">
            <JoinRequestsList communityDid={did} />
          </TabsContent>
        )}
        {community.isOwner && (
          <TabsContent value="settings" className="mt-4">
            <CommunitySettingsForm community={community} onUpdated={reload} />
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}
