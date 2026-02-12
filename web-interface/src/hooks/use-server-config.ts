import { useQuery } from '@tanstack/react-query';
import { getServerConfig } from '@/lib/api/admin';

export function useServerConfigQuery() {
  return useQuery({
    queryKey: ['server-config'],
    queryFn: async () => {
      const result = await getServerConfig();
      if (!result.ok) throw new Error(result.message);
      return result.data;
    },
    staleTime: 60 * 1000,
  });
}
