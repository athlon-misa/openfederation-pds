'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { toast } from 'sonner';
import { getCommunity, joinCommunity, leaveCommunity, exportCommunity, transferCommunity } from '@/lib/api/communities';
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

  const handleExport = async () => {
    setActionLoading(true);
    const result = await exportCommunity(did);
    setActionLoading(false);
    if (result.ok) {
      // Download as JSON file
      const blob = new Blob([JSON.stringify(result.data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `community-export-${community?.handle || did}.json`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success('Community data exported');
    } else {
      toast.error(result.message);
    }
  };

  const handleTransfer = async () => {
    if (!confirm('Are you sure you want to initiate a transfer? This will generate a transfer package that you can import on another PDS.')) {
      return;
    }
    setActionLoading(true);
    const result = await transferCommunity(did);
    setActionLoading(false);
    if (result.ok) {
      const blob = new Blob([JSON.stringify(result.data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `community-transfer-${community?.handle || did}.json`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success('Transfer package downloaded. Follow the instructions in the file to complete the migration.');
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

  const isSuspended = community.status === 'suspended';
  const isTakenDown = community.status === 'takendown';
  const isInactive = isSuspended || isTakenDown;

  return (
    <div>
      {/* Status banner */}
      {isSuspended && (
        <div className="bg-yellow-50 border border-yellow-200 rounded-md p-3 mb-4 text-sm text-yellow-800">
          This community has been suspended by the PDS administrator.
          {community.statusReason && <> Reason: {community.statusReason}</>}
          {community.isOwner && <> You can still export your community data.</>}
        </div>
      )}
      {isTakenDown && (
        <div className="bg-red-50 border border-red-200 rounded-md p-3 mb-4 text-sm text-red-800">
          This community has been taken down.
          {community.statusReason && <> Reason: {community.statusReason}</>}
        </div>
      )}

      {/* Header */}
      <div className="flex flex-col gap-4 mb-6 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <h1 className="text-2xl font-bold">{community.displayName}</h1>
            <Badge variant="secondary">{community.didMethod}</Badge>
            <Badge variant="outline">{community.visibility}</Badge>
            <Badge variant="outline">{community.joinPolicy}</Badge>
            {isInactive && (
              <Badge variant={isTakenDown ? 'destructive' : 'outline'}>
                {community.status}
              </Badge>
            )}
          </div>
          <p className="text-sm text-muted-foreground">@{community.handle}</p>
          {community.description && (
            <p className="text-sm text-muted-foreground mt-2">{community.description}</p>
          )}
          <p className="text-xs text-muted-foreground mt-1">
            {community.memberCount} {community.memberCount === 1 ? 'member' : 'members'}
          </p>
        </div>
        <div className="flex gap-2 flex-wrap">
          {/* Export button for owners (always available, even when suspended) */}
          {community.isOwner && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleExport}
              disabled={actionLoading}
            >
              {actionLoading ? 'Exporting...' : 'Export'}
            </Button>
          )}
          {/* Transfer button for owners of active/suspended communities */}
          {community.isOwner && !isTakenDown && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleTransfer}
              disabled={actionLoading}
            >
              Transfer
            </Button>
          )}
          {/* Leave button (only when active) */}
          {!isInactive && community.isMember && !community.isOwner && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleLeave}
              disabled={actionLoading}
            >
              {actionLoading ? 'Leaving...' : 'Leave'}
            </Button>
          )}
          {/* Join controls (only when active) */}
          {!isInactive && !community.isMember && community.joinRequestStatus === 'pending' && (
            <Badge variant="outline">Request Pending</Badge>
          )}
          {!isInactive && !community.isMember && !community.joinRequestStatus && (
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
          {community.isOwner && !isTakenDown && (
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
        {community.isOwner && !isTakenDown && (
          <TabsContent value="settings" className="mt-4">
            <CommunitySettingsForm community={community} onUpdated={reload} />
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}
