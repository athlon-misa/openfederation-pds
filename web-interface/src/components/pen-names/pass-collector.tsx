'use client';

import { useEffect } from 'react';
import { useAuthStore } from '@/store/auth-store';
import { useIdentityStatus, THIS_PDS } from '@/hooks/use-identity';
import { autoCollectPasses } from '@/lib/pen-names/pen-names';

/**
 * Collects this month's passes in the background, on whichever dashboard
 * page the person is signed in to, once a month: the full batch, whether or
 * not any were used (lib/pen-names/pen-names.ts). Renders nothing.
 */
export function PassCollector() {
  const did = useAuthStore((s) => s.did);
  const accessToken = useAuthStore((s) => s.accessToken);
  const identity = useIdentityStatus();
  // Accounts this server keeps the identity of; others cannot collect (the same rule as the account pages).
  const eligible = !!identity.data?.mode && identity.data.policy?.pseudonymsEnabled !== false;

  useEffect(() => {
    if (!did || !accessToken || !eligible) return;
    void autoCollectPasses({ pdsUrl: THIS_PDS, ownerDid: did, ownerAccessJwt: accessToken });
  }, [did, accessToken, eligible]);

  return null;
}
