import { useQuery, useQueryClient } from '@tanstack/react-query';
import { call } from '@/lib/move/xrpc';
import { identityPolicy, type CustodyMode, type IdentityPolicy } from '@/lib/custody/custody';
import { useAuthStore } from '@/store/auth-store';
import { THIS_PDS } from '@/lib/this-pds';

export { THIS_PDS };

export interface IdentityStatus {
  /** Null for accounts without a custody mode: signed in from another server, or the local admin. */
  mode: CustodyMode | null;
  policy: IdentityPolicy | null;
}

/**
 * Who controls this account's identity, and what this server offers. Shared
 * by the account pages; `refresh()` after a change so every page agrees.
 */
export function useIdentityStatus() {
  const did = useAuthStore((s) => s.did);
  const accessToken = useAuthStore((s) => s.accessToken);
  const status = useAuthStore((s) => s.status);
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ['identity-status', did],
    enabled: !!did && !!accessToken && status === 'approved',
    queryFn: async (): Promise<IdentityStatus> => {
      const level = await call<{ custodyMode?: CustodyMode | null }>(THIS_PDS, 'net.openfederation.account.getSecurityLevel', { jwt: accessToken ?? undefined }).catch(() => null);
      const policy = await identityPolicy(THIS_PDS);
      return { mode: level?.custodyMode ?? null, policy };
    },
  });
  return {
    ...query,
    refresh: () => client.invalidateQueries({ queryKey: ['identity-status'] }),
  };
}
