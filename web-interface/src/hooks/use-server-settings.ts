import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getServerSettings, updateServerSettings, type SettingId, type SettingValue } from '@/lib/api/server-settings';
import { unwrapApi } from '@/lib/api/unwrap';

const KEY = ['admin', 'server-settings'] as const;

export function useServerSettingsQuery() {
  return useQuery({
    queryKey: KEY,
    queryFn: async () => unwrapApi(await getServerSettings()),
  });
}

export function useUpdateServerSettingsMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (changes: Partial<Record<SettingId, SettingValue | null>>) => unwrapApi(await updateServerSettings(changes)),
    onSuccess: (data) => {
      qc.setQueryData(KEY, data);
      // getConfig shows invite-only sign-up.
      qc.invalidateQueries({ queryKey: ['server-config'] });
    },
  });
}
