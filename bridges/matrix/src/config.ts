import { readFileSync } from 'fs';

export interface CommunityMapping {
  communityDid: string;
  matrixSpaceId: string;
  rolePowerLevels: Record<string, number>;
}

export interface BridgeConfig {
  pdsUrl: string;
  pdsAuth: {
    handle: string;
    password: string;
  };
  mode: 'public' | 'self-hosted' | 'partner-hosted';
  matrix: {
    homeserverUrl: string;
    adminToken: string;
    handleTemplate?: string;
  };
  communityMappings: CommunityMapping[];
  syncIntervalMs: number;
}

export function loadConfig(path: string): BridgeConfig {
  const raw = JSON.parse(readFileSync(path, 'utf-8'));

  if (!raw.pdsUrl) throw new Error('Missing pdsUrl in config');
  if (!raw.pdsAuth?.handle || !raw.pdsAuth?.password) throw new Error('Missing pdsAuth in config');
  if (!raw.matrix?.homeserverUrl) throw new Error('Missing matrix.homeserverUrl in config');
  if (!raw.matrix?.adminToken) throw new Error('Missing matrix.adminToken in config');
  if (!raw.communityMappings?.length) throw new Error('No communityMappings defined');

  return {
    pdsUrl: raw.pdsUrl,
    pdsAuth: raw.pdsAuth,
    mode: raw.mode || 'public',
    matrix: raw.matrix,
    communityMappings: raw.communityMappings,
    syncIntervalMs: raw.syncIntervalMs || 60000,
  };
}
