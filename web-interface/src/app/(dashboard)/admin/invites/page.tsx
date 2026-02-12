'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { useInvitesQuery, useCreateInviteMutation } from '@/hooks/use-admin';
import { PageHeader } from '@/components/page-header';
import { DataTable } from '@/components/data-table/data-table';
import { StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Plus, Copy } from 'lucide-react';
import type { ColumnDef } from '@tanstack/react-table';
import type { InviteListItem } from '@/lib/api/types';

const PAGE_SIZE = 50;

export default function AdminInvitesPage() {
  const [page, setPage] = useState(0);
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [createOpen, setCreateOpen] = useState(false);
  const [maxUses, setMaxUses] = useState('10');
  const [expiresIn, setExpiresIn] = useState('');
  const [newCode, setNewCode] = useState<string | null>(null);

  const { data, isLoading } = useInvitesQuery({
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
    status: statusFilter || undefined,
  });

  const createMutation = useCreateInviteMutation();

  const handleCreate = () => {
    let expiresAt: string | undefined;
    if (expiresIn) {
      const d = new Date();
      d.setDate(d.getDate() + parseInt(expiresIn, 10));
      expiresAt = d.toISOString();
    }
    createMutation.mutate(
      { maxUses: parseInt(maxUses, 10) || 10, expiresAt },
      {
        onSuccess: (data) => {
          setNewCode(data.code);
          toast.success('Invite code created');
        },
        onError: (e) => toast.error(e.message),
      }
    );
  };

  const handleCopy = () => {
    if (newCode) {
      navigator.clipboard.writeText(newCode);
      toast.success('Copied to clipboard');
    }
  };

  const columns: ColumnDef<InviteListItem, unknown>[] = [
    {
      accessorKey: 'code',
      header: 'Code',
      cell: ({ row }) => (
        <code className="text-xs bg-muted px-2 py-1 rounded font-mono">{row.original.code}</code>
      ),
    },
    { accessorKey: 'maxUses', header: 'Max Uses' },
    { accessorKey: 'usesCount', header: 'Used' },
    {
      accessorKey: 'expiresAt',
      header: 'Expires',
      cell: ({ row }) =>
        row.original.expiresAt
          ? new Date(row.original.expiresAt).toLocaleDateString()
          : 'Never',
    },
    { accessorKey: 'createdByHandle', header: 'Created By' },
    { accessorKey: 'status', header: 'Status', cell: ({ row }) => <StatusBadge status={row.original.status} /> },
    {
      accessorKey: 'createdAt',
      header: 'Created',
      cell: ({ row }) => new Date(row.original.createdAt).toLocaleDateString(),
    },
  ];

  return (
    <div>
      <PageHeader title="Invites" description="Manage invite codes.">
        <Dialog open={createOpen} onOpenChange={(open) => { setCreateOpen(open); if (!open) setNewCode(null); }}>
          <DialogTrigger asChild>
            <Button>
              <Plus className="size-4 mr-2" />
              Create Invite
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Create Invite Code</DialogTitle>
              <DialogDescription>Generate a new invite code for user registration.</DialogDescription>
            </DialogHeader>
            {newCode ? (
              <div className="space-y-4">
                <div className="flex items-center gap-2">
                  <code className="flex-1 bg-muted px-3 py-2 rounded font-mono text-sm">{newCode}</code>
                  <Button variant="outline" size="sm" onClick={handleCopy}>
                    <Copy className="size-4" />
                  </Button>
                </div>
                <p className="text-sm text-muted-foreground">Share this code with users who need to register.</p>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label>Max Uses</Label>
                  <Input
                    type="number"
                    value={maxUses}
                    onChange={(e) => setMaxUses(e.target.value)}
                    min={1}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Expires In (days, optional)</Label>
                  <Input
                    type="number"
                    value={expiresIn}
                    onChange={(e) => setExpiresIn(e.target.value)}
                    placeholder="No expiration"
                    min={1}
                  />
                </div>
              </div>
            )}
            <DialogFooter>
              {!newCode && (
                <Button onClick={handleCreate} disabled={createMutation.isPending}>
                  {createMutation.isPending ? 'Creating...' : 'Create'}
                </Button>
              )}
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </PageHeader>

      <div className="mb-4">
        <Select value={statusFilter} onValueChange={(v) => { setStatusFilter(v === 'all' ? '' : v); setPage(0); }}>
          <SelectTrigger className="w-40">
            <SelectValue placeholder="All statuses" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="expired">Expired</SelectItem>
            <SelectItem value="exhausted">Exhausted</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <DataTable
        columns={columns}
        data={data?.invites ?? []}
        total={data?.total ?? 0}
        page={page}
        pageSize={PAGE_SIZE}
        onPageChange={setPage}
        isLoading={isLoading}
      />
    </div>
  );
}
