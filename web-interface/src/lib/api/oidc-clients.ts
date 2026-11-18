import { xrpc } from '../api-client';

/** Admin, Sign-in for other apps (ADR-005): apps that sign people in through this server. */
export type OidcPreset = 'mastodon' | 'lemmy' | 'gotosocial' | 'generic';

export interface OidcClient {
  clientId: string;
  name: string;
  redirectUris: string[];
  scopes: string[];
  communityDid?: string;
  preset?: OidcPreset;
  appUrl?: string;
  createdBy?: string;
  createdAt: string;
  secretRotatedAt?: string;
}

export interface ListOidcClientsResponse {
  enabled: boolean;
  issuer: string;
  clients: OidcClient[];
}

export interface CreateOidcClientInput {
  name: string;
  preset?: OidcPreset;
  appUrl?: string;
  redirectUris?: string[];
  communityDid?: string;
}

export interface CreateOidcClientResponse {
  client: OidcClient;
  clientSecret: string;
  issuer: string;
  configuration?: string;
}

export function listOidcClients() {
  return xrpc<ListOidcClientsResponse>('net.openfederation.oidc.listClients', { method: 'GET' });
}

export function createOidcClient(input: CreateOidcClientInput) {
  return xrpc<CreateOidcClientResponse>('net.openfederation.oidc.createClient', { body: input });
}

export function getOidcClientSetup(clientId: string) {
  return xrpc<{ client: OidcClient; issuer: string; configuration: string }>('net.openfederation.oidc.getClientSetup', {
    method: 'GET',
    params: { clientId },
  });
}

export function rotateOidcClientSecret(clientId: string) {
  return xrpc<{ clientId: string; clientSecret: string; configuration?: string }>('net.openfederation.oidc.rotateClientSecret', {
    body: { clientId },
  });
}

export function deleteOidcClient(clientId: string) {
  return xrpc<{ deleted: boolean }>('net.openfederation.oidc.deleteClient', { body: { clientId } });
}
