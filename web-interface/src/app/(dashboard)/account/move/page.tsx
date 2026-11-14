'use client';

import { PageHeader } from '@/components/page-header';
import { AccountGate } from '@/components/account/account-gate';
import { MoveAccountCard } from '@/components/move/move-account-card';

export default function MovePage() {
  return (
    <div className="space-y-6">
      <PageHeader title="Move to another server" description="Take your account, posts and files to another server. Your identity stays the same." />
      <AccountGate>
        {(ctx) => ctx.email
          ? <MoveAccountCard did={ctx.did} handle={ctx.handle} email={ctx.email} mode={ctx.mode} />
          : <p className="text-sm text-muted-foreground">Moving needs an email address on your account, for the confirmation code.</p>}
      </AccountGate>
    </div>
  );
}
