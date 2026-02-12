'use client';

import { useAuthStore } from '@/store/auth-store';
import { PageHeader } from '@/components/page-header';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { RoleBadge } from '@/components/role-badge';
import { StatusBadge } from '@/components/status-badge';

export default function SettingsPage() {
  const handle = useAuthStore((s) => s.handle);
  const email = useAuthStore((s) => s.email);
  const did = useAuthStore((s) => s.did);
  const roles = useAuthStore((s) => s.roles);
  const status = useAuthStore((s) => s.status);

  return (
    <div>
      <PageHeader title="Settings" description="Your account information." />

      <Card className="max-w-lg">
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
    </div>
  );
}
