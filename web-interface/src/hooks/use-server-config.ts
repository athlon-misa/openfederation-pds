import { useQuery } from '@tanstack/react-query';
import { getServerConfig } from '@/lib/api/admin';
import { unwrapApi } from '@/lib/api/unwrap';

export function useServerConfigQuery() {
  return useQuery({
    queryKey: ['server-config'],
    queryFn: async () => unwrapApi(await getServerConfig()),
    staleTime: 60 * 1000,
  });
}
