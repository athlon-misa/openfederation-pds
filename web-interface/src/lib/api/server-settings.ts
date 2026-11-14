import { xrpc } from '../api-client';

/** Admin, Server settings (#410): what an admin can change without a restart. */
export type SettingId =
  | 'pseudonymsEnabled'
  | 'pseudonymTokensPerEpoch'
  | 'pseudonymProbationDays'
  | 'pseudonymProbationDailyWrites'
  | 'custodyAllowed'
  | 'custodyDefault'
  | 'deviceSigningAllowed'
  | 'inviteRequired'
  | 'accountApproval'
  | 'emailVerificationPolicy'
  | 'migrationAccounts'
  | 'migrationPseudonyms'
  | 'migrationCommunities'
  | 'federationPeers'
  | 'defaultAppearance';

export type SettingValue = boolean | number | string | string[];
export type SettingSource = 'environment' | 'admin' | 'setup' | 'default';

export interface ServerSetting {
  id: SettingId;
  envVar: string;
  value: SettingValue;
  source: SettingSource;
  fixed: boolean;
  fallback: SettingValue;
  fallbackSource: Exclude<SettingSource, 'admin'>;
  changedAt?: string;
}

export interface ServerSettingsResponse {
  profile?: 'community' | 'privacy';
  settings: ServerSetting[];
  problem?: string;
  refreshSeconds: number;
}

export interface UpdateServerSettingsResponse extends ServerSettingsResponse {
  changed: Array<{ id: SettingId; envVar: string; before: SettingValue; after: SettingValue; reset: boolean }>;
}

export async function getServerSettings() {
  return xrpc<ServerSettingsResponse>('net.openfederation.admin.getServerSettings', { method: 'GET' });
}

/** A value sets the setting; null drops the admin's change. All or nothing. */
export async function updateServerSettings(changes: Partial<Record<SettingId, SettingValue | null>>) {
  return xrpc<UpdateServerSettingsResponse>('net.openfederation.admin.updateServerSettings', { body: { changes } });
}
