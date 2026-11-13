'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { useAuthStore } from '@/store/auth-store';
import { PageHeader } from '@/components/page-header';
import { RoleBadge } from '@/components/role-badge';
import { StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { changePassword } from '@/lib/api/account';
import { Note, Section, StatusMessage, WhatIsThis } from '@/components/account/explain';
import { useIdentityStatus } from '@/hooks/use-identity';
import { CUSTODY } from '@/lib/copy/glossary';

export default function AccountPage() {
  const handle = useAuthStore((s) => s.handle);
  const email = useAuthStore((s) => s.email);
  const did = useAuthStore((s) => s.did);
  const roles = useAuthStore((s) => s.roles);
  const status = useAuthStore((s) => s.status);
  const logout = useAuthStore((s) => s.logout);
  const router = useRouter();
  const identity = useIdentityStatus();
  const mode = identity.data?.mode ?? null;

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = currentPassword.length > 0 && newPassword.length >= 10 && newPassword === confirmPassword && !isSubmitting;

  async function handleChangePassword(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (newPassword !== confirmPassword) { setError('The two new passwords are not the same.'); return; }
    if (newPassword.length < 10) { setError('The new password needs at least 10 characters.'); return; }
    setIsSubmitting(true);
    try {
      const result = await changePassword(currentPassword, newPassword);
      if (!result.ok) { setError(result.message); setIsSubmitting(false); return; }
      toast.success('Password changed. Sign in again with the new one.');
      await logout();
      router.push('/login');
    } catch {
      setError('Something went wrong; your password was not changed.');
      setIsSubmitting(false);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader title="Your account" description="Your name on the network, your email and your password." />

      <Section title="About you">
        <dl className="grid gap-4 text-sm sm:grid-cols-2">
          <div>
            <dt className="font-medium">Handle</dt>
            <dd className="text-muted-foreground">@{handle}</dd>
          </div>
          <div>
            <dt className="font-medium">Email</dt>
            <dd className="break-all text-muted-foreground">{email || 'None'}</dd>
          </div>
          <div className="sm:col-span-2">
            <dt className="font-medium">Your identity</dt>
            <dd className="break-all font-mono text-xs text-muted-foreground">{did}</dd>
            <dd><WhatIsThis term="identity" className="mt-1" /></dd>
          </div>
          <div>
            <dt className="font-medium">Account status</dt>
            <dd className="mt-1">{status && <StatusBadge status={status} />}</dd>
          </div>
          {roles.length > 0 && (
            <div>
              <dt className="font-medium">Roles on this server</dt>
              <dd className="mt-1 flex flex-wrap gap-1">{roles.map((r) => <RoleBadge key={r} role={r} />)}</dd>
            </div>
          )}
          <div className="sm:col-span-2">
            <dt className="font-medium">Who controls your identity</dt>
            <dd className="text-muted-foreground">
              {identity.isLoading ? 'Checking…' : mode
                ? <>{CUSTODY[mode].title}: {CUSTODY[mode].short.toLowerCase()}. <Link className="underline underline-offset-4 hover:no-underline" href="/account/identity">See what this means or change it</Link></>
                : status === 'approved'
                  ? 'Your identity is managed by the server you signed in from, or this is the server\'s own administrator account.'
                  : 'Shown once your account is approved.'}
            </dd>
          </div>
        </dl>
      </Section>

      <Section
        title="Change your password"
        description="Your password lets you sign in here. Changing it signs you out on every device."
      >
        <Note>A new password does not change your 12 words or who controls your identity. If you forget it, you can reset it by email from the sign-in page.</Note>
        <form onSubmit={handleChangePassword} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="current-password">Current password</Label>
            <Input id="current-password" type="password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} autoComplete="current-password" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="new-password">New password</Label>
            <Input id="new-password" type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} autoComplete="new-password" aria-describedby="new-password-rules" />
            <p id="new-password-rules" className="text-xs text-muted-foreground">
              10 to 128 characters, with at least 3 of: lowercase letters, capital letters, digits, other characters.
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="confirm-password">New password, again</Label>
            <Input id="confirm-password" type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} autoComplete="new-password" />
          </div>
          {error && <StatusMessage ok={false} text={error} />}
          <Button type="submit" disabled={!canSubmit}>{isSubmitting ? 'Changing…' : 'Change password'}</Button>
        </form>
      </Section>
    </div>
  );
}
