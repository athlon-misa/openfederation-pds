'use client';

import { useState } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import {
  useAdminCommunitiesQuery,
  useSuspendCommunityMutation,
  useUnsuspendCommunityMutation,
  useTakedownCommunityMutation,
  useAdminDeleteCommunityMutation,
} from '@/hooks/use-admin';
import { PageHeader } from '@/components/page-header';
import { DataTable } from '@/components/data-table/data-table';
import { StatusBadge } from '@/components/status-badge';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { ColumnDef } from '@tanstack/react-table';
import type { CommunityListAllItem } from '@/lib/api/types';

const PAGE_SIZE = 50;

export default function AdminCommunitiesPage() {
  const [page, setPage] = useState(0);
  const { data, isLoading } = useAdminCommunitiesQuery(PAGE_SIZE, page * PAGE_SIZE);

  const suspendMutation = useSuspendCommunityMutation();
  const unsuspendMutation = useUnsuspendCommunityMutation();
  const takedownMutation = useTakedownCommunityMutation();

  const deleteCommMutation = useAdminDeleteCommunityMutation();

  const [actionTarget, setActionTarget] = useState<{ did: string; action: 'suspend' | 'unsuspend' | 'takedown' | 'delete'; handle: string } | null>(null);
  const [reason, setReason] = useState('');

  const handleAction = () => {
    if (!actionTarget) return;
    const { did, action } = actionTarget;
    if (action === 'suspend') {
      suspendMutation.mutate({ did, reason: reason || undefined }, {
        onSuccess: () => { toast.success('Community suspended'); setActionTarget(null); setReason(''); },
        onError: (e) => toast.error(e.message),
      });
    } else if (action === 'unsuspend') {
      unsuspendMutation.mutate(did, {
        onSuccess: () => { toast.success('Community unsuspended'); setActionTarget(null); },
        onError: (e) => toast.error(e.message),
      });
    } else if (action === 'takedown') {
      takedownMutation.mutate({ did, reason: reason || undefined }, {
        onSuccess: () => { toast.success('Community taken down'); setActionTarget(null); setReason(''); },
        onError: (e) => toast.error(e.message),
      });
    } else if (action === 'delete') {
      deleteCommMutation.mutate(did, {
        onSuccess: () => { toast.success('Community deleted'); setActionTarget(null); },
        onError: (e) => toast.error(e.message),
      });
    }
  };

  const columns: ColumnDef<CommunityListAllItem, unknown>[] = [
    {
      accessorKey: 'displayName',
      header: 'Name',
      cell: ({ row }) => (
        <Link href={`/communities/${encodeURIComponent(row.original.did)}`} className="font-medium hover:underline">
          {row.original.displayName}
        </Link>
      ),
    },
    { accessorKey: 'handle', header: 'Handle', cell: ({ row }) => `@${row.original.handle}` },
    { accessorKey: 'status', header: 'Status', cell: ({ row }) => <StatusBadge status={row.original.status ?? 'active'} /> },
    { accessorKey: 'visibility', header: 'Visibility' },
    { accessorKey: 'memberCount', header: 'Members' },
    {
      accessorKey: 'createdAt',
      header: 'Created',
      cell: ({ row }) => new Date(row.original.createdAt).toLocaleDateString(),
    },
    {
      id: 'actions',
      header: 'Actions',
      cell: ({ row }) => {
        const c = row.original;
        const st = c.status ?? 'active';
        return (
          <div className="flex gap-1">
            {st === 'active' && (
              <Button size="sm" variant="outline" onClick={() => setActionTarget({ did: c.did, action: 'suspend', handle: c.handle })}>
                Suspend
              </Button>
            )}
            {st === 'suspended' && (
              <>
                <Button size="sm" variant="outline" onClick={() => setActionTarget({ did: c.did, action: 'unsuspend', handle: c.handle })}>
                  Unsuspend
                </Button>
                <Button size="sm" variant="destructive" onClick={() => setActionTarget({ did: c.did, action: 'takedown', handle: c.handle })}>
                  Takedown
                </Button>
              </>
            )}
            <Button size="sm" variant="destructive" onClick={() => setActionTarget({ did: c.did, action: 'delete', handle: c.handle })}>
              Delete
            </Button>
          </div>
        );
      },
    },
  ];

  return (
    <div>
      <PageHeader title="Communities" description="Manage all communities on the PDS." />

      <DataTable
        columns={columns}
        data={data?.communities ?? []}
        total={data?.total ?? 0}
        page={page}
        pageSize={PAGE_SIZE}
        onPageChange={setPage}
        isLoading={isLoading}
      />

      {actionTarget && (
        <ConfirmDialog
          open={!!actionTarget}
          onOpenChange={(open) => { if (!open) { setActionTarget(null); setReason(''); } }}
          title={`${actionTarget.action.charAt(0).toUpperCase() + actionTarget.action.slice(1)} community`}
          description={
            actionTarget.action === 'unsuspend'
              ? `Unsuspend @${actionTarget.handle}?`
              : actionTarget.action === 'delete'
              ? `Permanently delete @${actionTarget.handle} and all its data? This cannot be undone.`
              : `${actionTarget.action === 'suspend' ? 'Suspend' : 'Take down'} @${actionTarget.handle}? ${actionTarget.action === 'takedown' ? 'This requires a prior export.' : ''}`
          }
          confirmLabel={actionTarget.action.charAt(0).toUpperCase() + actionTarget.action.slice(1)}
          variant={actionTarget.action === 'takedown' || actionTarget.action === 'delete' ? 'destructive' : 'default'}
          loading={suspendMutation.isPending || unsuspendMutation.isPending || takedownMutation.isPending || deleteCommMutation.isPending}
          onConfirm={handleAction}
        />
      )}
    </div>
  );
}
