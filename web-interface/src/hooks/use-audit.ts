import { useQuery } from '@tanstack/react-query';
import { listAuditLog } from '@/lib/api/admin';

export const auditKeys = {
  list: (params: Record<string, unknown>) => ['audit', params] as const,
};

export function useAuditQuery(params: { limit?: number; offset?: number; action?: string; actorId?: string; targetId?: string; since?: string; until?: string } = {}) {
  return useQuery({
    queryKey: auditKeys.list(params),
    queryFn: async () => {
      const result = await listAuditLog(params);
      if (!result.ok) throw new Error(result.message);
      return result.data;
    },
  });
}
