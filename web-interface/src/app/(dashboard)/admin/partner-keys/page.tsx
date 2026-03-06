'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { usePartnerKeysQuery, useCreatePartnerKeyMutation, useRevokePartnerKeyMutation } from '@/hooks/use-admin';
import { PageHeader } from '@/components/page-header';
import { DataTable } from '@/components/data-table/data-table';
import { StatusBadge } from '@/components/status-badge';
import { ConfirmDialog } from '@/components/confirm-dialog';
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
import { Plus, Copy } from 'lucide-react';
import type { ColumnDef } from '@tanstack/react-table';
import type { PartnerKeyListItem } from '@/lib/api/types';

export default function AdminPartnerKeysPage() {
  const [createOpen, setCreateOpen] = useState(false);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [partnerName, setPartnerName] = useState('');
  const [allowedOrigins, setAllowedOrigins] = useState('');
  const [rateLimitPerHour, setRateLimitPerHour] = useState('100');
  const [revokeTarget, setRevokeTarget] = useState<{ id: string; name: string } | null>(null);

  const { data, isLoading } = usePartnerKeysQuery();
  const createMutation = useCreatePartnerKeyMutation();
  const revokeMutation = useRevokePartnerKeyMutation();

  const resetForm = () => {
    setName('');
    setPartnerName('');
    setAllowedOrigins('');
    setRateLimitPerHour('100');
  };

  const handleCreate = () => {
    const origins = allowedOrigins
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean);
    createMutation.mutate(
      {
        name,
        partnerName,
        allowedOrigins: origins.length > 0 ? origins : undefined,
        rateLimitPerHour: parseInt(rateLimitPerHour, 10) || 100,
      },
      {
        onSuccess: (data) => {
          setNewKey(data.key);
          toast.success('Partner key created');
        },
        onError: (e) => toast.error(e.message),
      }
    );
  };

  const handleCopy = () => {
    if (newKey) {
      navigator.clipboard.writeText(newKey);
      toast.success('Copied to clipboard');
    }
  };

  const handleRevoke = () => {
    if (!revokeTarget) return;
    revokeMutation.mutate(revokeTarget.id, {
      onSuccess: () => {
        toast.success('Partner key revoked');
        setRevokeTarget(null);
      },
      onError: (e) => toast.error(e.message),
    });
  };

  const columns: ColumnDef<PartnerKeyListItem, unknown>[] = [
    { accessorKey: 'name', header: 'Name' },
    { accessorKey: 'partnerName', header: 'Partner' },
    {
      accessorKey: 'keyPrefix',
      header: 'Key Prefix',
      cell: ({ row }) => (
        <code className="text-xs bg-muted px-2 py-1 rounded font-mono">{row.original.keyPrefix}...</code>
      ),
    },
    {
      accessorKey: 'status',
      header: 'Status',
      cell: ({ row }) => <StatusBadge status={row.original.status} />,
    },
    {
      accessorKey: 'allowedOrigins',
      header: 'Origins',
      cell: ({ row }) => row.original.allowedOrigins?.join(', ') || 'Any',
    },
    { accessorKey: 'rateLimitPerHour', header: 'Rate Limit/hr' },
    { accessorKey: 'totalRegistrations', header: 'Registrations' },
    {
      accessorKey: 'lastUsedAt',
      header: 'Last Used',
      cell: ({ row }) =>
        row.original.lastUsedAt
          ? new Date(row.original.lastUsedAt).toLocaleDateString()
          : 'Never',
    },
    {
      accessorKey: 'createdAt',
      header: 'Created',
      cell: ({ row }) => new Date(row.original.createdAt).toLocaleDateString(),
    },
    {
      id: 'actions',
      header: '',
      cell: ({ row }) =>
        row.original.status === 'active' ? (
          <Button
            size="sm"
            variant="destructive"
            onClick={() => setRevokeTarget({ id: row.original.id, name: row.original.name })}
          >
            Revoke
          </Button>
        ) : null,
    },
  ];

  return (
    <div>
      <PageHeader title="Partner Keys" description="Manage API keys for third-party partner applications.">
        <Dialog open={createOpen} onOpenChange={(open) => { setCreateOpen(open); if (!open) { setNewKey(null); resetForm(); } }}>
          <DialogTrigger asChild>
            <Button>
              <Plus className="size-4 mr-2" />
              Create Key
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Create Partner Key</DialogTitle>
              <DialogDescription>Generate a new API key for a partner application.</DialogDescription>
            </DialogHeader>
            {newKey ? (
              <div className="space-y-4">
                <div className="flex items-center gap-2">
                  <code className="flex-1 bg-muted px-3 py-2 rounded font-mono text-sm break-all">{newKey}</code>
                  <Button variant="outline" size="sm" onClick={handleCopy}>
                    <Copy className="size-4" />
                  </Button>
                </div>
                <p className="text-sm text-destructive font-medium">
                  Save this key now. It will not be shown again.
                </p>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label>Key Name</Label>
                  <Input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="e.g. FlappySoccer Production"
                  />
                </div>
                <div className="space-y-2">
                  <Label>Partner Name</Label>
                  <Input
                    value={partnerName}
                    onChange={(e) => setPartnerName(e.target.value)}
                    placeholder="e.g. games.grvty.tech"
                  />
                </div>
                <div className="space-y-2">
                  <Label>Allowed Origins (comma-separated, optional)</Label>
                  <Input
                    value={allowedOrigins}
                    onChange={(e) => setAllowedOrigins(e.target.value)}
                    placeholder="e.g. https://games.grvty.tech, https://app.example.com"
                  />
                </div>
                <div className="space-y-2">
                  <Label>Rate Limit (registrations per hour)</Label>
                  <Input
                    type="number"
                    value={rateLimitPerHour}
                    onChange={(e) => setRateLimitPerHour(e.target.value)}
                    min={1}
                    max={10000}
                  />
                </div>
              </div>
            )}
            <DialogFooter>
              {!newKey && (
                <Button
                  onClick={handleCreate}
                  disabled={createMutation.isPending || !name.trim() || !partnerName.trim()}
                >
                  {createMutation.isPending ? 'Creating...' : 'Create'}
                </Button>
              )}
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </PageHeader>

      <DataTable
        columns={columns}
        data={data?.keys ?? []}
        total={data?.keys?.length ?? 0}
        isLoading={isLoading}
      />

      <ConfirmDialog
        open={!!revokeTarget}
        onOpenChange={(open) => { if (!open) setRevokeTarget(null); }}
        title="Revoke partner key"
        description={`Revoke the key "${revokeTarget?.name}"? This will immediately prevent all registrations using this key. This action cannot be undone.`}
        confirmLabel="Revoke"
        variant="destructive"
        loading={revokeMutation.isPending}
        onConfirm={handleRevoke}
      />
    </div>
  );
}
