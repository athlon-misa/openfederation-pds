'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { useAccountsQuery, useApproveAccountMutation, useRejectAccountMutation } from '@/hooks/use-admin';
import { PageHeader } from '@/components/page-header';
import { DataTable } from '@/components/data-table/data-table';
import { StatusBadge } from '@/components/status-badge';
import { RoleBadge } from '@/components/role-badge';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
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

  const { data, isLoading } = useAccountsQuery({
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
    status: status || undefined,
    role: role || undefined,
    q: search || undefined,
  });

  const approveMutation = useApproveAccountMutation();
  const rejectMutation = useRejectAccountMutation();

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
        if (row.original.status !== 'pending') return null;
        return (
          <div className="flex gap-1">
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                approveMutation.mutate(row.original.id, {
                  onSuccess: () => toast.success(`Approved ${row.original.handle}`),
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
                rejectMutation.mutate(row.original.id, {
                  onSuccess: () => toast.success(`Rejected ${row.original.handle}`),
                  onError: (e) => toast.error(e.message),
                });
              }}
              disabled={rejectMutation.isPending}
            >
              Reject
            </Button>
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
    </div>
  );
}
