'use client';

import { useState } from 'react';
import { useAuditQuery } from '@/hooks/use-audit';
import { PageHeader } from '@/components/page-header';
import { DataTable } from '@/components/data-table/data-table';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { ColumnDef } from '@tanstack/react-table';
import type { AuditEntry } from '@/lib/api/types';

const PAGE_SIZE = 50;

const ACTION_TYPES = [
  'account.approve',
  'account.reject',
  'account.register',
  'invite.create',
  'session.create',
  'session.refresh',
  'session.delete',
  'community.create',
  'community.update',
  'community.join',
  'community.leave',
  'community.export',
  'community.suspend',
  'community.unsuspend',
  'community.takedown',
  'community.transfer.initiate',
  'join_request.approve',
  'join_request.reject',
];

export default function AdminAuditPage() {
  const [page, setPage] = useState(0);
  const [action, setAction] = useState<string>('');

  const { data, isLoading } = useAuditQuery({
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
    action: action || undefined,
  });

  const columns: ColumnDef<AuditEntry, unknown>[] = [
    {
      accessorKey: 'createdAt',
      header: 'Timestamp',
      cell: ({ row }) => (
        <span className="text-xs text-muted-foreground whitespace-nowrap">
          {new Date(row.original.createdAt).toLocaleString()}
        </span>
      ),
    },
    {
      accessorKey: 'action',
      header: 'Action',
      cell: ({ row }) => (
        <Badge variant="outline" className="font-mono text-xs">
          {row.original.action}
        </Badge>
      ),
    },
    {
      accessorKey: 'actorHandle',
      header: 'Actor',
      cell: ({ row }) => row.original.actorHandle || row.original.actorId || '-',
    },
    {
      accessorKey: 'targetId',
      header: 'Target',
      cell: ({ row }) =>
        row.original.targetId ? (
          <span className="text-xs font-mono text-muted-foreground">
            {row.original.targetId.slice(0, 20)}...
          </span>
        ) : (
          '-'
        ),
    },
    {
      accessorKey: 'meta',
      header: 'Details',
      cell: ({ row }) =>
        row.original.meta ? (
          <details className="cursor-pointer">
            <summary className="text-xs text-muted-foreground">View</summary>
            <pre className="mt-1 text-xs bg-muted p-2 rounded max-w-xs overflow-auto">
              {JSON.stringify(row.original.meta, null, 2)}
            </pre>
          </details>
        ) : (
          '-'
        ),
    },
  ];

  return (
    <div>
      <PageHeader title="Audit Log" description="View all admin and security-relevant actions." />

      <div className="mb-4">
        <Select value={action} onValueChange={(v) => { setAction(v === 'all' ? '' : v); setPage(0); }}>
          <SelectTrigger className="w-64">
            <SelectValue placeholder="All actions" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All actions</SelectItem>
            {ACTION_TYPES.map((a) => (
              <SelectItem key={a} value={a}>
                {a}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <DataTable
        columns={columns}
        data={data?.entries ?? []}
        total={data?.total ?? 0}
        page={page}
        pageSize={PAGE_SIZE}
        onPageChange={setPage}
        isLoading={isLoading}
      />
    </div>
  );
}
