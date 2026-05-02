import { useQuery } from '@tanstack/react-query';
import { getServerConfig } from '@/lib/api/admin';
import { unwrapApi } from '@/lib/api/unwrap';

/**
 * Server config + admin-only stats. Pass `enabled: false` from non-admin
 * call sites to skip the request entirely — the response is admin/auditor
 * gated server-side, so non-admins would just get a 403.
 */
export function useServerConfigQuery(opts: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: ['server-config'],
    queryFn: async () => unwrapApi(await getServerConfig()),
    // Server config + counts move slowly; 5 min keeps tab-switches snappy.
    staleTime: 5 * 60 * 1000,
    enabled: opts.enabled ?? true,
  });
}
