'use client';

import { AccountNav } from '@/components/account/account-nav';

export default function AccountLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-4 md:flex-row md:gap-8">
      <AccountNav />
      <div className="account-content min-w-0 flex-1">{children}</div>
    </div>
  );
}
