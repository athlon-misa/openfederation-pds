'use client';

import { useAuthStore } from '@/store/auth-store';
import { useIdentityStatus } from '@/hooks/use-identity';
import type { CustodyMode, IdentityPolicy } from '@/lib/custody/custody';
import { Skeleton } from '@/components/ui/skeleton';
import { Note } from './explain';

export interface AccountContext {
  did: string;
  handle: string;
  email: string | null;
  accessToken: string;
  mode: CustodyMode;
  policy: IdentityPolicy | null;
  refresh: () => Promise<void>;
}

/**
 * The identity pages need an approved account of this server with a custody
 * mode. Anything else gets a plain explanation instead of empty controls.
 */
export function AccountGate({ children }: { children: (ctx: AccountContext) => React.ReactNode }) {
  const did = useAuthStore((s) => s.did);
  const handle = useAuthStore((s) => s.handle);
  const email = useAuthStore((s) => s.email);
  const accessToken = useAuthStore((s) => s.accessToken);
  const status = useAuthStore((s) => s.status);
  const identity = useIdentityStatus();

  if (status && status !== 'approved') {
    return <Note>These settings are available once your account is approved by this server&apos;s administrators.</Note>;
  }
  if (identity.isLoading || !did || !handle || !accessToken) {
    return <div className="space-y-3" aria-busy="true"><Skeleton className="h-24 rounded-xl" /><Skeleton className="h-40 rounded-xl" /></div>;
  }
  const mode = identity.data?.mode ?? null;
  if (!mode) {
    return (
      <Note>
        This server does not control your identity, so there is nothing to set here. Either you signed in with an account from another server (manage it there),
        or this is the server&apos;s own administrator account, which exists only on this server.
      </Note>
    );
  }
  return <>{children({ did, handle, email, accessToken, mode, policy: identity.data?.policy ?? null, refresh: identity.refresh })}</>;
}
