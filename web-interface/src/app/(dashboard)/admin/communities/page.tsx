'use client';

import { useState } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import {
  useAdminCommunitiesQuery,
  useSuspendCommunityMutation,
  useUnsuspendCommunityMutation,
  useAdminReverseTakedownMutation,
  useAdminDeleteCommunityMutation,
} from '@/hooks/use-admin';
import { PageHeader } from '@/components/page-header';
import { DataTable } from '@/components/data-table/data-table';
import { StatusBadge } from '@/components/status-badge';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { TakedownDialog } from '@/components/takedown-dialog';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import type { ColumnDef } from '@tanstack/react-table';
import type { CommunityListAllItem } from '@/lib/api/types';

const PAGE_SIZE = 50;

export default function AdminCommunitiesPage() {
  const [page, setPage] = useState(0);
  const { data, isLoading } = useAdminCommunitiesQuery(PAGE_SIZE, page * PAGE_SIZE);

  const suspendMutation = useSuspendCommunityMutation();
  const unsuspendMutation = useUnsuspendCommunityMutation();
  const reverseTakedownMutation = useAdminReverseTakedownMutation();
  const [takedownTarget, setTakedownTarget] = useState<{ did: string; handle: string } | null>(null);

  const deleteCommMutation = useAdminDeleteCommunityMutation();

  const [actionTarget, setActionTarget] = useState<{ did: string; action: 'suspend' | 'unsuspend' | 'reverseTakedown' | 'delete'; handle: string } | null>(null);
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
    } else if (action === 'reverseTakedown') {
      reverseTakedownMutation.mutate(did, {
        onSuccess: (r) => { toast.success(`Takedown reversed; community is ${r.status}`); setActionTarget(null); },
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
              <Button size="sm" variant="outline" onClick={() => setActionTarget({ did: c.did, action: 'unsuspend', handle: c.handle })}>
                Unsuspend
              </Button>
            )}
            {(st === 'active' || st === 'suspended') && (
              <Button size="sm" variant="destructive" onClick={() => setTakedownTarget({ did: c.did, handle: c.handle })}>
                Takedown
              </Button>
            )}
            {st === 'takendown' && (
              <Button size="sm" variant="outline" onClick={() => setActionTarget({ did: c.did, action: 'reverseTakedown', handle: c.handle })}>
                Reverse takedown
              </Button>
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
          title={{ suspend: 'Suspend community', unsuspend: 'Unsuspend community', reverseTakedown: 'Reverse takedown', delete: 'Delete community' }[actionTarget.action]}
          description={{
            suspend: `Suspend @${actionTarget.handle}? It is hidden and read-only; nothing is deleted and the owner can still export.`,
            unsuspend: `Unsuspend @${actionTarget.handle}?`,
            reverseTakedown: `Reverse the takedown of @${actionTarget.handle}? It returns to its previous status and its export links stop working.`,
            delete: `Permanently delete @${actionTarget.handle} and all its data? This cannot be undone.`,
          }[actionTarget.action]}
          confirmLabel={{ suspend: 'Suspend', unsuspend: 'Unsuspend', reverseTakedown: 'Reverse takedown', delete: 'Delete' }[actionTarget.action]}
          variant={actionTarget.action === 'delete' ? 'destructive' : 'default'}
          loading={suspendMutation.isPending || unsuspendMutation.isPending || reverseTakedownMutation.isPending || deleteCommMutation.isPending}
          onConfirm={handleAction}
        >
          {actionTarget.action === 'suspend' && (
            <Textarea placeholder="Reason (optional)" value={reason} onChange={(e) => setReason(e.target.value)} className="mt-2" />
          )}
        </ConfirmDialog>
      )}

      <TakedownDialog
        target={takedownTarget ? { ...takedownTarget, kind: 'community' } : null}
        onClose={() => setTakedownTarget(null)}
      />
    </div>
  );
}
