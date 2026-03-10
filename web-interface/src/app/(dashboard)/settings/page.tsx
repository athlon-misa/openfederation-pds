'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuthStore } from '@/store/auth-store';
import { PageHeader } from '@/components/page-header';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { RoleBadge } from '@/components/role-badge';
import { StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { changePassword } from '@/lib/api/account';
import { toast } from 'sonner';

export default function SettingsPage() {
  const handle = useAuthStore((s) => s.handle);
  const email = useAuthStore((s) => s.email);
  const did = useAuthStore((s) => s.did);
  const roles = useAuthStore((s) => s.roles);
  const status = useAuthStore((s) => s.status);
  const logout = useAuthStore((s) => s.logout);
  const router = useRouter();

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit =
    currentPassword.length > 0 &&
    newPassword.length >= 10 &&
    newPassword === confirmPassword &&
    !isSubmitting;

  async function handleChangePassword(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (newPassword !== confirmPassword) {
      setError('New passwords do not match');
      return;
    }

    if (newPassword.length < 10) {
      setError('New password must be at least 10 characters');
      return;
    }

    setIsSubmitting(true);

    try {
      const result = await changePassword(currentPassword, newPassword);

      if (!result.ok) {
        setError(result.message);
        setIsSubmitting(false);
        return;
      }

      toast.success('Password changed successfully. Please log in again.');
      logout();
      router.push('/login');
    } catch {
      setError('An unexpected error occurred');
      setIsSubmitting(false);
    }
  }

  return (
    <div>
      <PageHeader title="Settings" description="Your account information." />

      <div className="space-y-6 max-w-lg">
        <Card>
          <CardHeader>
            <CardTitle>Account</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <p className="text-sm font-medium">Handle</p>
              <p className="text-sm text-muted-foreground">@{handle}</p>
            </div>
            <div>
              <p className="text-sm font-medium">Email</p>
              <p className="text-sm text-muted-foreground">{email}</p>
            </div>
            <div>
              <p className="text-sm font-medium">DID</p>
              <p className="text-xs text-muted-foreground font-mono break-all">{did}</p>
            </div>
            <div>
              <p className="text-sm font-medium">Status</p>
              {status && <StatusBadge status={status} />}
            </div>
            <div>
              <p className="text-sm font-medium mb-1">Roles</p>
              <div className="flex gap-1">
                {roles.map((r) => (
                  <RoleBadge key={r} role={r} />
                ))}
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Change Password</CardTitle>
            <CardDescription>
              After changing your password, all sessions will be invalidated and you will need to log in again.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleChangePassword} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="current-password">Current Password</Label>
                <Input
                  id="current-password"
                  type="password"
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                  autoComplete="current-password"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="new-password">New Password</Label>
                <Input
                  id="new-password"
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  autoComplete="new-password"
                />
                <p className="text-xs text-muted-foreground">
                  10-128 characters, must contain at least 3 of: lowercase, uppercase, digit, special character
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="confirm-password">Confirm New Password</Label>
                <Input
                  id="confirm-password"
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  autoComplete="new-password"
                />
              </div>

              {error && (
                <p className="text-sm text-destructive">{error}</p>
              )}

              <Button type="submit" disabled={!canSubmit}>
                {isSubmitting ? 'Changing...' : 'Change Password'}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
