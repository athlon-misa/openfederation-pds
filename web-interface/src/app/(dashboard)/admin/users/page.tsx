'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import {
  useAccountsQuery,
  useApproveAccountMutation,
  useRejectAccountMutation,
  useSuspendAccountMutation,
  useUnsuspendAccountMutation,
  useTakedownAccountMutation,
  useDeleteAccountMutation,
} from '@/hooks/use-admin';
import { PageHeader } from '@/components/page-header';
import { DataTable } from '@/components/data-table/data-table';
import { StatusBadge } from '@/components/status-badge';
import { RoleBadge } from '@/components/role-badge';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { ColumnDef } from '@tanstack/react-table';
import type { AccountListItem } from '@/lib/api/types';

const PAGE_SIZE = 50;

export default function AdminUsersPage() {
  const [page, setPage] = useState(0);
  const [status, setStatus] = useState<string>('');
  const [role, setRole] = useState<string>('');
  const [search, setSearch] = useState('');

  const [actionTarget, setActionTarget] = useState<{
    did: string;
    action: 'suspend' | 'unsuspend' | 'takedown' | 'delete';
    handle: string;
  } | null>(null);
  const [reason, setReason] = useState('');

  const { data, isLoading } = useAccountsQuery({
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
    status: status || undefined,
    role: role || undefined,
    q: search || undefined,
  });

  const approveMutation = useApproveAccountMutation();
  const rejectMutation = useRejectAccountMutation();
  const suspendMutation = useSuspendAccountMutation();
  const unsuspendMutation = useUnsuspendAccountMutation();
  const takedownMutation = useTakedownAccountMutation();
  const deleteMutation = useDeleteAccountMutation();

  const handleAction = () => {
    if (!actionTarget) return;
    const { did, action } = actionTarget;
    if (action === 'suspend') {
      suspendMutation.mutate({ did, reason: reason || undefined }, {
        onSuccess: () => { toast.success('Account suspended'); setActionTarget(null); setReason(''); },
        onError: (e) => toast.error(e.message),
      });
    } else if (action === 'unsuspend') {
      unsuspendMutation.mutate(did, {
        onSuccess: () => { toast.success('Account unsuspended'); setActionTarget(null); },
        onError: (e) => toast.error(e.message),
      });
    } else if (action === 'takedown') {
      takedownMutation.mutate({ did, reason: reason || undefined }, {
        onSuccess: () => { toast.success('Account taken down'); setActionTarget(null); setReason(''); },
        onError: (e) => toast.error(e.message),
      });
    } else if (action === 'delete') {
      deleteMutation.mutate(did, {
        onSuccess: () => { toast.success('Account deleted'); setActionTarget(null); },
        onError: (e) => toast.error(e.message),
      });
    }
  };

  const columns: ColumnDef<AccountListItem, unknown>[] = [
    { accessorKey: 'handle', header: 'Handle' },
    { accessorKey: 'email', header: 'Email' },
    { accessorKey: 'status', header: 'Status', cell: ({ row }) => <StatusBadge status={row.original.status} /> },
    {
      accessorKey: 'roles',
      header: 'Roles',
      cell: ({ row }) => (
        <div className="flex gap-1">
          {row.original.roles.map((r) => (
            <RoleBadge key={r} role={r} />
          ))}
        </div>
      ),
    },
    {
      accessorKey: 'createdAt',
      header: 'Registered',
      cell: ({ row }) => new Date(row.original.createdAt).toLocaleDateString(),
    },
    {
      id: 'actions',
      header: 'Actions',
      cell: ({ row }) => {
        const u = row.original;
        const isAdmin = u.roles.includes('admin');

        if (u.status === 'pending') {
          return (
            <div className="flex gap-1">
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  approveMutation.mutate(u.id, {
                    onSuccess: () => toast.success(`Approved ${u.handle}`),
                    onError: (e) => toast.error(e.message),
                  });
                }}
                disabled={approveMutation.isPending}
              >
                Approve
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  rejectMutation.mutate(u.id, {
                    onSuccess: () => toast.success(`Rejected ${u.handle}`),
                    onError: (e) => toast.error(e.message),
                  });
                }}
                disabled={rejectMutation.isPending}
              >
                Reject
              </Button>
            </div>
          );
        }

        if (isAdmin) return null;

        return (
          <div className="flex gap-1">
            {u.status === 'approved' && (
              <Button size="sm" variant="outline" onClick={() => setActionTarget({ did: u.did, action: 'suspend', handle: u.handle })}>
                Suspend
              </Button>
            )}
            {u.status === 'suspended' && (
              <>
                <Button size="sm" variant="outline" onClick={() => setActionTarget({ did: u.did, action: 'unsuspend', handle: u.handle })}>
                  Unsuspend
                </Button>
                <Button size="sm" variant="destructive" onClick={() => setActionTarget({ did: u.did, action: 'takedown', handle: u.handle })}>
                  Takedown
                </Button>
              </>
            )}
            {(u.status === 'approved' || u.status === 'suspended' || u.status === 'takendown') && (
              <Button size="sm" variant="destructive" onClick={() => setActionTarget({ did: u.did, action: 'delete', handle: u.handle })}>
                Delete
              </Button>
            )}
          </div>
        );
      },
    },
  ];

  return (
    <div>
      <PageHeader title="Users" description="Manage user accounts and approvals." />

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center mb-4">
        <Input
          placeholder="Search handle or email..."
          value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(0); }}
          className="max-w-xs"
        />
        <Select value={status} onValueChange={(v) => { setStatus(v === 'all' ? '' : v); setPage(0); }}>
          <SelectTrigger className="w-40">
            <SelectValue placeholder="All statuses" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="pending">Pending</SelectItem>
            <SelectItem value="approved">Approved</SelectItem>
            <SelectItem value="rejected">Rejected</SelectItem>
            <SelectItem value="suspended">Suspended</SelectItem>
            <SelectItem value="takendown">Taken down</SelectItem>
            <SelectItem value="deactivated">Deactivated</SelectItem>
            <SelectItem value="disabled">Disabled</SelectItem>
          </SelectContent>
        </Select>
        <Select value={role} onValueChange={(v) => { setRole(v === 'all' ? '' : v); setPage(0); }}>
          <SelectTrigger className="w-40">
            <SelectValue placeholder="All roles" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All roles</SelectItem>
            <SelectItem value="admin">Admin</SelectItem>
            <SelectItem value="moderator">Moderator</SelectItem>
            <SelectItem value="user">User</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <DataTable
        columns={columns}
        data={data?.users ?? []}
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
          title={`${actionTarget.action.charAt(0).toUpperCase() + actionTarget.action.slice(1)} account`}
          description={
            actionTarget.action === 'unsuspend'
              ? `Unsuspend @${actionTarget.handle}?`
              : actionTarget.action === 'delete'
              ? `Permanently delete @${actionTarget.handle} and all their data? This cannot be undone.`
              : `${actionTarget.action === 'suspend' ? 'Suspend' : 'Take down'} @${actionTarget.handle}?${actionTarget.action === 'takedown' ? ' This requires a prior data export.' : ''}`
          }
          confirmLabel={actionTarget.action.charAt(0).toUpperCase() + actionTarget.action.slice(1)}
          variant={actionTarget.action === 'takedown' || actionTarget.action === 'delete' ? 'destructive' : 'default'}
          loading={suspendMutation.isPending || unsuspendMutation.isPending || takedownMutation.isPending || deleteMutation.isPending}
          onConfirm={handleAction}
        >
          {(actionTarget.action === 'suspend' || actionTarget.action === 'takedown') && (
            <Textarea
              placeholder="Reason (optional)"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="mt-2"
            />
          )}
        </ConfirmDialog>
      )}
    </div>
  );
}
