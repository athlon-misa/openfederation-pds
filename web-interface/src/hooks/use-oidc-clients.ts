import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { unwrapApi } from '@/lib/api/unwrap';
import {
  listOidcClients, createOidcClient, getOidcClientSetup, rotateOidcClientSecret, deleteOidcClient,
  type CreateOidcClientInput,
} from '@/lib/api/oidc-clients';

const KEY = ['admin', 'oidcClients'] as const;

export function useOidcClientsQuery() {
  return useQuery({ queryKey: KEY, queryFn: async () => unwrapApi(await listOidcClients()) });
}

export function useCreateOidcClientMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateOidcClientInput) => unwrapApi(await createOidcClient(input)),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: KEY }); },
  });
}

export function useOidcClientSetupMutation() {
  return useMutation({ mutationFn: async (clientId: string) => unwrapApi(await getOidcClientSetup(clientId)) });
}

export function useRotateOidcClientSecretMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (clientId: string) => unwrapApi(await rotateOidcClientSecret(clientId)),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: KEY }); },
  });
}

export function useDeleteOidcClientMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (clientId: string) => unwrapApi(await deleteOidcClient(clientId)),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: KEY }); },
  });
}
