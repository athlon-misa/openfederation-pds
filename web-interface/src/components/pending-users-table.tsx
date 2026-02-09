'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { listPending, approveAccount, rejectAccount } from '@/lib/api/admin';
import type { PendingUser } from '@/lib/api/types';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

export function PendingUsersTable() {
  const [users, setUsers] = useState<PendingUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      const result = await listPending();
      if (result.ok) {
        setUsers(result.data.users);
      }
      setLoading(false);
    }
    load();
  }, []);

  const handleApprove = async (userId: string) => {
    setActionLoading(userId);
    const result = await approveAccount(userId);
    if (result.ok) {
      setUsers((prev) => prev.filter((u) => u.id !== userId));
      toast.success('Account approved');
    } else {
      toast.error(result.message);
    }
    setActionLoading(null);
  };

  const handleReject = async (userId: string) => {
    setActionLoading(userId);
    const result = await rejectAccount(userId);
    if (result.ok) {
      setUsers((prev) => prev.filter((u) => u.id !== userId));
      toast.success('Account rejected');
    } else {
      toast.error(result.message);
    }
    setActionLoading(null);
  };

  if (loading) {
    return <p className="text-muted-foreground py-4">Loading...</p>;
  }

  if (users.length === 0) {
    return (
      <p className="text-muted-foreground py-4">No pending accounts.</p>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Handle</TableHead>
          <TableHead>Email</TableHead>
          <TableHead>Registered</TableHead>
          <TableHead className="text-right">Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {users.map((user) => (
          <TableRow key={user.id}>
            <TableCell className="font-medium">{user.handle}</TableCell>
            <TableCell>{user.email}</TableCell>
            <TableCell>{new Date(user.created_at).toLocaleDateString()}</TableCell>
            <TableCell className="text-right">
              <div className="flex justify-end gap-2">
                <Button
                  size="sm"
                  onClick={() => handleApprove(user.id)}
                  disabled={actionLoading === user.id}
                >
                  Approve
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={() => handleReject(user.id)}
                  disabled={actionLoading === user.id}
                >
                  Reject
                </Button>
              </div>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
