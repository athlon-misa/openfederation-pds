'use client';

import { useState } from 'react';
import { useParams } from 'next/navigation';
import { toast } from 'sonner';
import { useRouter } from 'next/navigation';
import {
  useCommunityDetailQuery,
  useMembersQuery,
  useJoinRequestsQuery,
  useJoinCommunityMutation,
  useLeaveCommunityMutation,
  useExportCommunityMutation,
  useTransferCommunityMutation,
  useResolveJoinRequestMutation,
  useUpdateCommunityMutation,
  useRemoveMemberMutation,
  useDeleteCommunityMutation,
} from '@/hooks/use-communities';
import { useAuthStore } from '@/store/auth-store';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Skeleton } from '@/components/ui/skeleton';
import { DataTable } from '@/components/data-table/data-table';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { CommunitySettingsForm } from '@/components/community-settings-form';
import { StatusBadge } from '@/components/status-badge';
import { RoleBadge } from '@/components/role-badge';
import type { ColumnDef } from '@tanstack/react-table';
import type { CommunityMember, JoinRequest } from '@/lib/api/types';

export default function CommunityDetailPage() {
  const params = useParams();
  const router = useRouter();
  const did = decodeURIComponent(params.did as string);
  const isAdmin = useAuthStore((s) => s.isAdmin);

  const [membersPage, setMembersPage] = useState(0);
  const [requestsPage, setRequestsPage] = useState(0);
  const [transferOpen, setTransferOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<{ did: string; handle: string } | null>(null);

  const { data: community, isLoading, error } = useCommunityDetailQuery(did);
  const { data: membersData, isLoading: membersLoading } = useMembersQuery(did, 50, membersPage * 50);
  const { data: requestsData, isLoading: requestsLoading } = useJoinRequestsQuery(did, 50, requestsPage * 50);

  const joinMutation = useJoinCommunityMutation();
  const leaveMutation = useLeaveCommunityMutation();
  const exportMutation = useExportCommunityMutation();
  const transferMutation = useTransferCommunityMutation();
  const resolveRequestMutation = useResolveJoinRequestMutation();
  const removeMemberMutation = useRemoveMemberMutation();
  const deleteCommunityMutation = useDeleteCommunityMutation();

  const canManageMembers = community?.isOwner || isAdmin;

  const memberColumns: ColumnDef<CommunityMember, unknown>[] = [
    { accessorKey: 'handle', header: 'Handle' },
    { accessorKey: 'did', header: 'DID', cell: ({ row }) => (
      <span className="text-xs text-muted-foreground font-mono">{row.original.did.slice(0, 24)}...</span>
    )},
    { accessorKey: 'role', header: 'Role', cell: ({ row }) => <RoleBadge role={row.original.role} /> },
    { accessorKey: 'joinedAt', header: 'Joined', cell: ({ row }) => new Date(row.original.joinedAt).toLocaleDateString() },
    ...(canManageMembers ? [{
      id: 'actions' as const,
      header: 'Actions' as const,
      cell: ({ row }: { row: { original: CommunityMember } }) => {
        if (row.original.role === 'owner') return null;
        return (
          <Button
            size="sm"
            variant="outline"
            onClick={() => setRemoveTarget({ did: row.original.did, handle: row.original.handle })}
            disabled={removeMemberMutation.isPending}
          >
            Remove
          </Button>
        );
      },
    } as ColumnDef<CommunityMember, unknown>] : []),
  ];

  const requestColumns: ColumnDef<JoinRequest, unknown>[] = [
    { accessorKey: 'handle', header: 'Handle' },
    { accessorKey: 'status', header: 'Status', cell: ({ row }) => <StatusBadge status={row.original.status} /> },
    { accessorKey: 'createdAt', header: 'Requested', cell: ({ row }) => new Date(row.original.createdAt).toLocaleDateString() },
    {
      id: 'actions',
      header: 'Actions',
      cell: ({ row }) => {
        if (row.original.status !== 'pending') return null;
        return (
          <div className="flex gap-1">
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                resolveRequestMutation.mutate(
                  { requestId: row.original.id, action: 'approve' },
                  { onSuccess: () => toast.success('Approved'), onError: (e) => toast.error(e.message) }
                );
              }}
              disabled={resolveRequestMutation.isPending}
            >
              Approve
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                resolveRequestMutation.mutate(
                  { requestId: row.original.id, action: 'reject' },
                  { onSuccess: () => toast.success('Rejected'), onError: (e) => toast.error(e.message) }
                );
              }}
              disabled={resolveRequestMutation.isPending}
            >
              Reject
            </Button>
          </div>
        );
      },
    },
  ];

  const handleJoin = () => {
    joinMutation.mutate(did, {
      onSuccess: (data) => {
        toast.success(data.status === 'joined' ? 'Joined community!' : 'Join request sent');
      },
      onError: (e) => toast.error(e.message),
    });
  };

  const handleLeave = () => {
    leaveMutation.mutate(did, {
      onSuccess: () => toast.success('Left community'),
      onError: (e) => toast.error(e.message),
    });
  };

  const handleExport = () => {
    exportMutation.mutate(did, {
      onSuccess: (data) => {
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `community-export-${community?.handle || did}.json`;
        a.click();
        URL.revokeObjectURL(url);
        toast.success('Community data exported');
      },
      onError: (e) => toast.error(e.message),
    });
  };

  const handleTransfer = () => {
    transferMutation.mutate(did, {
      onSuccess: (data) => {
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `community-transfer-${community?.handle || did}.json`;
        a.click();
        URL.revokeObjectURL(url);
        toast.success('Transfer package downloaded');
        setTransferOpen(false);
      },
      onError: (e) => toast.error(e.message),
    });
  };

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-4 w-48" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (error || !community) {
    return <p className="text-muted-foreground">Community not found.</p>;
  }

  const isSuspended = community.status === 'suspended';
  const isTakenDown = community.status === 'takendown';
  const isInactive = isSuspended || isTakenDown;
  const handleDelete = () => {
    deleteCommunityMutation.mutate(did, {
      onSuccess: () => {
        toast.success('Community deleted');
        router.push('/communities');
      },
      onError: (e) => toast.error(e.message),
    });
  };

  const handleRemoveMember = () => {
    if (!removeTarget) return;
    removeMemberMutation.mutate(
      { did, memberDid: removeTarget.did },
      {
        onSuccess: () => {
          toast.success(`Removed ${removeTarget.handle}`);
          setRemoveTarget(null);
        },
        onError: (e) => toast.error(e.message),
      }
    );
  };

  const actionLoading = joinMutation.isPending || leaveMutation.isPending || exportMutation.isPending || transferMutation.isPending || deleteCommunityMutation.isPending;

  return (
    <div>
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
          {community.isOwner && (
            <Button variant="outline" size="sm" onClick={handleExport} disabled={actionLoading}>
              Export
            </Button>
          )}
          {community.isOwner && !isTakenDown && (
            <Button variant="outline" size="sm" onClick={() => setTransferOpen(true)} disabled={actionLoading}>
              Transfer
            </Button>
          )}
          {(community.isOwner || isAdmin) && (
            <Button variant="destructive" size="sm" onClick={() => setDeleteOpen(true)} disabled={actionLoading}>
              Delete
            </Button>
          )}
          {!isInactive && community.isMember && !community.isOwner && (
            <Button variant="outline" size="sm" onClick={handleLeave} disabled={actionLoading}>
              Leave
            </Button>
          )}
          {!isInactive && !community.isMember && community.joinRequestStatus === 'pending' && (
            <Badge variant="outline">Request Pending</Badge>
          )}
          {!isInactive && !community.isMember && !community.joinRequestStatus && (
            <Button size="sm" onClick={handleJoin} disabled={actionLoading}>
              {community.joinPolicy === 'approval' ? 'Request to Join' : 'Join'}
            </Button>
          )}
        </div>
      </div>

      <Tabs defaultValue="members">
        <TabsList>
          <TabsTrigger value="members">Members</TabsTrigger>
          {(community.isOwner || isAdmin) && community.joinPolicy === 'approval' && (
            <TabsTrigger value="requests">Join Requests</TabsTrigger>
          )}
          {community.isOwner && !isTakenDown && (
            <TabsTrigger value="settings">Settings</TabsTrigger>
          )}
        </TabsList>
        <TabsContent value="members" className="mt-4">
          <DataTable
            columns={memberColumns}
            data={membersData?.members ?? []}
            total={membersData?.total ?? 0}
            page={membersPage}
            onPageChange={setMembersPage}
            isLoading={membersLoading}
          />
        </TabsContent>
        {(community.isOwner || isAdmin) && community.joinPolicy === 'approval' && (
          <TabsContent value="requests" className="mt-4">
            <DataTable
              columns={requestColumns}
              data={requestsData?.requests ?? []}
              total={requestsData?.total ?? 0}
              page={requestsPage}
              onPageChange={setRequestsPage}
              isLoading={requestsLoading}
            />
          </TabsContent>
        )}
        {community.isOwner && !isTakenDown && (
          <TabsContent value="settings" className="mt-4">
            <CommunitySettingsForm community={community} onUpdated={() => {}} />
          </TabsContent>
        )}
      </Tabs>

      <ConfirmDialog
        open={transferOpen}
        onOpenChange={setTransferOpen}
        title="Transfer Community"
        description="This will generate a transfer package for migrating this community to another PDS. Are you sure?"
        confirmLabel="Transfer"
        variant="destructive"
        loading={transferMutation.isPending}
        onConfirm={handleTransfer}
      />

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title="Delete Community"
        description={`This will permanently delete "${community.displayName}" and all its data. This action cannot be undone.`}
        confirmLabel="Delete"
        variant="destructive"
        loading={deleteCommunityMutation.isPending}
        onConfirm={handleDelete}
      />

      <ConfirmDialog
        open={!!removeTarget}
        onOpenChange={(open) => { if (!open) setRemoveTarget(null); }}
        title="Remove Member"
        description={`Are you sure you want to remove @${removeTarget?.handle} from this community?`}
        confirmLabel="Remove"
        variant="destructive"
        loading={removeMemberMutation.isPending}
        onConfirm={handleRemoveMember}
      />
    </div>
  );
}
