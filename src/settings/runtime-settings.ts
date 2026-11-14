/**
 * Runtime settings (#410): the choices the setup wizard offers, changeable by
 * an admin on Admin, Server settings without a restart.
 *
 * Each setting is still named by the environment variable it has always been
 * read from, and its value comes from the first of these that has one:
 *
 *   1. the environment (and .env): the operator's word, always wins, and the
 *      dashboard shows the setting as fixed;
 *   2. an admin's change, stored in the `server_settings` table;
 *   3. the setup wizard's choice, from its settings file (config.setupFileSettings);
 *   4. the profile's default (OPENFEDERATION_PROFILE), then the built-in default.
 *
 * Everything else stays in src/config.ts, read once at start-up.
 *
 * Readers call runtimeSettings() each time they need a value, so a change is
 * seen on the next request. This process refreshes its copy right after an
 * admin's change; other instances re-read the table every
 * REFRESH_INTERVAL_MS, so they follow within that time.
 *
 * Values are checked twice, the same way: the environment at start-up (an
 * invalid value stops the server, as before), an admin's change when it is
 * made (an invalid value or combination is refused with a plain message and
 * nothing is saved). Turning something off only stops new things: existing
 * pen names, accounts in a custody mode no longer offered, devices already
 * signing, accounts already moved here all keep working.
 */
import { config } from '../config.js';
import { query, getClient } from '../db/client.js';
import {
  CUSTODY_MODES, isCustodyMode, resolveIdentityPolicy, type CustodyMode, type IdentityPolicy, type IdentityProfile,
} from '../identity/custody-policy.js';
import { parseFederationPeers, mergePeerLists } from '../federation/peer-sources.js';
import { RUNTIME_SETTING_ENV_VARS, type RuntimeSettingEnvVar } from './keys.js';

/**
 * What an unverified email blocks (#83). The operator's decision, because an
 * open-source PDS serves closed single-user instances and open registration
 * alike:
 *   off                nothing sent, nothing gated
 *   advisory (default) verification emails sent, state surfaced, nothing gated
 *   require-for-write  unverified accounts read and log in, but cannot act
 *   require-for-login  unverified local accounts cannot create sessions
 * An unrecognized environment value falls back to advisory with a loud
 * warning: a typo must not silently lock users out, and equally must not
 * silently disable verification the operator thought was on.
 */
export const EMAIL_VERIFICATION_POLICIES = ['off', 'advisory', 'require-for-write', 'require-for-login'] as const;
export type EmailVerificationPolicy = (typeof EMAIL_VERIFICATION_POLICIES)[number];
export const ACCOUNT_MIGRATION_POLICIES = ['open', 'invite', 'closed'] as const;
export const PSEUDONYM_MIGRATION_POLICIES = ['open', 'token', 'closed'] as const;
export type AccountMigrationPolicy = (typeof ACCOUNT_MIGRATION_POLICIES)[number];
export type PseudonymMigrationPolicy = (typeof PSEUDONYM_MIGRATION_POLICIES)[number];

export interface RuntimeSettings {
  /** Custody modes, pen names and device signing (ADR-003). */
  identity: IdentityPolicy;
  pseudonym: { tokensPerEpoch: number; probationDays: number; probationDailyWrites: number };
  /** Who may move here from another PDS (#265). Pen names never use invite codes. */
  migration: { accounts: AccountMigrationPolicy; pseudonyms: PseudonymMigrationPolicy; communities: AccountMigrationPolicy };
  inviteRequired: boolean;
  emailVerificationPolicy: EmailVerificationPolicy;
  /** FEDERATION_PEERS plus the older PEER_PDS_URLS (environment only). */
  federationPeers: string[];
}

/** The dashboard's name for each setting, and the environment variable it is read from. */
export const SETTING_IDS = {
  pseudonymsEnabled: 'PSEUDONYMS_ENABLED',
  pseudonymTokensPerEpoch: 'PSEUDONYM_TOKENS_PER_EPOCH',
  pseudonymProbationDays: 'PSEUDONYM_PROBATION_DAYS',
  pseudonymProbationDailyWrites: 'PSEUDONYM_PROBATION_DAILY_WRITES',
  custodyAllowed: 'IDENTITY_CUSTODY_ALLOWED',
  custodyDefault: 'IDENTITY_CUSTODY_DEFAULT',
  deviceSigningAllowed: 'DEVICE_SIGNING_ALLOWED',
  inviteRequired: 'INVITE_REQUIRED',
  emailVerificationPolicy: 'EMAIL_VERIFICATION_POLICY',
  migrationAccounts: 'MIGRATION_ACCOUNTS',
  migrationPseudonyms: 'MIGRATION_PSEUDONYMS',
  migrationCommunities: 'MIGRATION_COMMUNITIES',
  federationPeers: 'FEDERATION_PEERS',
} as const satisfies Record<string, RuntimeSettingEnvVar>;

export type SettingId = keyof typeof SETTING_IDS;
export const SETTING_ID_LIST = Object.keys(SETTING_IDS) as SettingId[];
export type SettingSource = 'environment' | 'admin' | 'setup' | 'default';
export type SettingValue = boolean | number | string | string[];

export class SettingsError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly setting?: SettingId) {
    super(message);
  }
}

type Env = Record<string, string | undefined>;
type Layer = Partial<Record<RuntimeSettingEnvVar, string>>;

const MAX_PEERS = 50;
const LABEL: Record<CustodyMode, string> = { custodial: 'Custodial', assisted: 'Assisted', self: 'Self' };

function intIn(id: SettingId, value: unknown, min: number, max: number, what: string): string {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new SettingsError(400, 'InvalidSetting', `${what} must be a whole number from ${min} to ${max}.`, id);
  }
  return String(value);
}

function bool(id: SettingId, value: unknown, what: string): string {
  if (typeof value !== 'boolean') throw new SettingsError(400, 'InvalidSetting', `${what} must be on or off (true or false).`, id);
  return value ? 'true' : 'false';
}

function oneOf(id: SettingId, value: unknown, allowed: readonly string[], what: string): string {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new SettingsError(400, 'InvalidSetting', `${what} must be one of: ${allowed.join(', ')}.`, id);
  }
  return value;
}

/**
 * An admin's value, checked, as the string the environment variable would
 * hold. Stored that way so the start-up parsing reads both layers alike.
 */
export function encodeSetting(id: SettingId, value: unknown, env: Env = process.env): string {
  switch (id) {
    case 'pseudonymsEnabled': return bool(id, value, 'Pen names');
    case 'deviceSigningAllowed': return bool(id, value, 'Device signing');
    case 'inviteRequired': return bool(id, value, 'Invite-only sign-up');
    case 'pseudonymTokensPerEpoch': return intIn(id, value, 1, 1000, 'Creation passes per month');
    case 'pseudonymProbationDays': return intIn(id, value, 0, 365, 'Probation days');
    case 'pseudonymProbationDailyWrites': return intIn(id, value, 1, 100000, 'Posts a day on probation');
    case 'custodyAllowed': {
      if (!Array.isArray(value) || value.length === 0 || !value.every(isCustodyMode)) {
        throw new SettingsError(400, 'InvalidSetting', `Offer at least one way to look after accounts: ${CUSTODY_MODES.join(', ')}.`, id);
      }
      return CUSTODY_MODES.filter((m) => (value as string[]).includes(m)).join(',');
    }
    case 'custodyDefault': return oneOf(id, value, CUSTODY_MODES, 'The way offered first');
    case 'emailVerificationPolicy': return oneOf(id, value, EMAIL_VERIFICATION_POLICIES, 'Email verification');
    case 'migrationAccounts': return oneOf(id, value, ACCOUNT_MIGRATION_POLICIES, 'Accounts moving here');
    case 'migrationPseudonyms': return oneOf(id, value, PSEUDONYM_MIGRATION_POLICIES, 'Pen names moving here');
    case 'migrationCommunities': return oneOf(id, value, ACCOUNT_MIGRATION_POLICIES, 'Communities moving here');
    case 'federationPeers': {
      if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) {
        throw new SettingsError(400, 'InvalidSetting', 'Federation peers must be a list of web addresses.', id);
      }
      const list = (value as string[]).map((v) => v.trim()).filter(Boolean);
      if (list.length > MAX_PEERS) throw new SettingsError(400, 'InvalidSetting', `List at most ${MAX_PEERS} peers.`, id);
      if (list.some((v) => v.includes(','))) throw new SettingsError(400, 'InvalidSetting', 'Put one address on each line, without commas.', id);
      try {
        parseFederationPeers(list.join(','), { isProduction: env.NODE_ENV === 'production', selfUrl: env.PDS_SERVICE_URL || '' });
      } catch (err) {
        const msg = err instanceof Error ? err.message.replace(/^FEDERATION_PEERS: /, '') : String(err);
        throw new SettingsError(400, 'InvalidSetting', `Federation peers: ${msg}.`, id);
      }
      return list.join(',');
    }
  }
}

function isSet(value: string | undefined): value is string {
  return value !== undefined && value.trim() !== '';
}

/** The variables the environment sets (a blank value counts as unset). */
export function environmentLayer(env: Env): Layer {
  const out: Layer = {};
  for (const key of RUNTIME_SETTING_ENV_VARS) if (isSet(env[key])) out[key] = env[key];
  return out;
}

export interface Resolved {
  settings: RuntimeSettings;
  sources: Record<SettingId, SettingSource>;
}

let warnedEmailPolicy: string | null = null;

/**
 * The effective settings from the layers, highest first: environment, admin,
 * setup file, then defaults. Throws, with the start-up messages, when the
 * combination is invalid.
 */
export function resolveRuntimeSettings(env: Env, admin: Layer, setup: Layer): Resolved {
  const fromEnv = environmentLayer(env);
  const merged: Env = {};
  const sources = {} as Record<SettingId, SettingSource>;
  for (const id of SETTING_ID_LIST) {
    const key = SETTING_IDS[id];
    if (fromEnv[key] !== undefined) { merged[key] = fromEnv[key]; sources[id] = 'environment'; }
    else if (isSet(admin[key])) { merged[key] = admin[key]; sources[id] = 'admin'; }
    else if (isSet(setup[key])) { merged[key] = setup[key]; sources[id] = 'setup'; }
    else sources[id] = 'default';
  }

  const identity = resolveIdentityPolicy({ ...merged, OPENFEDERATION_PROFILE: env.OPENFEDERATION_PROFILE });

  const int = (raw: string | undefined, fallback: number, min: number) => {
    const v = parseInt(raw ?? String(fallback), 10);
    return Number.isFinite(v) && v >= min ? v : fallback;
  };
  const pick = <T extends string>(list: readonly T[], raw: string | undefined, fallback: T): T =>
    list.find((v) => v === raw) ?? fallback;

  let emailVerificationPolicy: EmailVerificationPolicy = 'advisory';
  const rawPolicy = merged.EMAIL_VERIFICATION_POLICY;
  if (rawPolicy !== undefined) {
    const found = EMAIL_VERIFICATION_POLICIES.find((v) => v === rawPolicy);
    if (found) emailVerificationPolicy = found;
    else if (warnedEmailPolicy !== rawPolicy) {
      warnedEmailPolicy = rawPolicy;
      console.warn(`WARNING: EMAIL_VERIFICATION_POLICY "${rawPolicy}" is not recognized; using "advisory".`);
    }
  }

  const selfUrl = env.PDS_SERVICE_URL || '';
  const federationPeers = mergePeerLists(
    // Validated; an invalid value in the environment stops the server.
    parseFederationPeers(merged.FEDERATION_PEERS, { isProduction: env.NODE_ENV === 'production', selfUrl }),
    // The older name, kept as it was so existing deployments keep working.
    (env.PEER_PDS_URLS || '').split(',').map((u) => u.trim()).filter(Boolean).filter((u) => u !== selfUrl),
  );

  return {
    settings: {
      identity,
      pseudonym: {
        tokensPerEpoch: int(merged.PSEUDONYM_TOKENS_PER_EPOCH, 20, 1),
        probationDays: int(merged.PSEUDONYM_PROBATION_DAYS, 7, 0),
        probationDailyWrites: int(merged.PSEUDONYM_PROBATION_DAILY_WRITES, 20, 1),
      },
      migration: {
        accounts: pick(ACCOUNT_MIGRATION_POLICIES, merged.MIGRATION_ACCOUNTS, 'invite'),
        pseudonyms: pick(PSEUDONYM_MIGRATION_POLICIES, merged.MIGRATION_PSEUDONYMS, 'open'),
        communities: pick(ACCOUNT_MIGRATION_POLICIES, merged.MIGRATION_COMMUNITIES, 'invite'),
      },
      inviteRequired: merged.INVITE_REQUIRED !== 'false',
      emailVerificationPolicy,
      federationPeers,
    },
    sources,
  };
}

/** One setting's effective value, in the dashboard's shape. */
export function settingValue(s: RuntimeSettings, id: SettingId, env: Env = process.env): SettingValue {
  switch (id) {
    case 'pseudonymsEnabled': return s.identity.pseudonymsEnabled;
    case 'pseudonymTokensPerEpoch': return s.pseudonym.tokensPerEpoch;
    case 'pseudonymProbationDays': return s.pseudonym.probationDays;
    case 'pseudonymProbationDailyWrites': return s.pseudonym.probationDailyWrites;
    case 'custodyAllowed': return [...s.identity.custodyAllowed];
    case 'custodyDefault': return s.identity.custodyDefault;
    case 'deviceSigningAllowed': return s.identity.deviceSigningAllowed;
    case 'inviteRequired': return s.inviteRequired;
    case 'emailVerificationPolicy': return s.emailVerificationPolicy;
    case 'migrationAccounts': return s.migration.accounts;
    case 'migrationPseudonyms': return s.migration.pseudonyms;
    case 'migrationCommunities': return s.migration.communities;
    // The configurable list only, not the older PEER_PDS_URLS.
    case 'federationPeers': {
      const legacy = new Set((env.PEER_PDS_URLS || '').split(',').map((u) => u.trim()).filter(Boolean));
      return s.federationPeers.filter((u) => !legacy.has(u));
    }
  }
}

/**
 * The rules between settings, checked on an admin's change, in plain words.
 * (resolveRuntimeSettings checks the first again, with the start-up message.)
 */
function checkDefaultOffered(merged: Layer): void {
  const allowed = merged.IDENTITY_CUSTODY_ALLOWED
    ? CUSTODY_MODES.filter((m) => merged.IDENTITY_CUSTODY_ALLOWED!.split(',').map((x) => x.trim()).includes(m))
    : [...CUSTODY_MODES];
  const explicitDefault = merged.IDENTITY_CUSTODY_DEFAULT?.trim();
  if (explicitDefault && isCustodyMode(explicitDefault) && !allowed.includes(explicitDefault)) {
    throw new SettingsError(400, 'InvalidCombination',
      `The way offered first (${LABEL[explicitDefault]}) must be one of the ways offered (${allowed.map((m) => LABEL[m]).join(', ')}). Choose another one to offer first in the same change.`,
      'custodyDefault');
  }
}

function checkDeviceSigning(s: RuntimeSettings, changed: Set<SettingId>): void {
  const allowed = s.identity.custodyAllowed;
  if ((changed.has('custodyAllowed') || changed.has('deviceSigningAllowed'))
    && s.identity.deviceSigningAllowed && !allowed.includes('self') && !allowed.includes('assisted')) {
    throw new SettingsError(400, 'InvalidCombination',
      'Device signing is only for Self and Assisted accounts. Offer Self or Assisted, or turn device signing off in the same change.',
      changed.has('deviceSigningAllowed') ? 'deviceSigningAllowed' : 'custodyAllowed');
  }
}

// ── The cache ────────────────────────────────────────────────────

export const REFRESH_INTERVAL_MS = 15_000;

interface State extends Resolved {
  admin: Layer;
  /** Why the saved changes are not in effect, when they conflict with the environment. */
  problem: string | null;
}

function computeState(admin: Layer, previous: State | null): State {
  try {
    return { ...resolveRuntimeSettings(process.env, admin, config.setupFileSettings), admin, problem: null };
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    if (Object.keys(admin).length === 0) {
      if (previous) { console.error(`Runtime settings: ${why}; keeping the previous values.`); return previous; }
      throw err;
    }
    // The environment changed under an admin's saved choices. The environment
    // wins: the saved changes wait until the conflict is gone.
    console.warn(`WARNING: the server settings changed on the dashboard conflict with the environment (${why}); they are ignored until that is fixed.`);
    try {
      return { ...resolveRuntimeSettings(process.env, {}, config.setupFileSettings), admin, problem: why };
    } catch (inner) {
      if (previous) return previous;
      throw inner;
    }
  }
}

// From the environment and the setup file at start-up: an invalid value stops
// the server here, as it always has.
let state: State = computeState({}, null);

/**
 * The settings in effect now. Call it each time; never keep the result: it is
 * replaced when the settings change. (Tests set its fields directly, as they
 * did on src/config.ts; that lasts until the next change or refresh.)
 */
export function runtimeSettings(): RuntimeSettings {
  return state.settings;
}

async function readAdminLayer(): Promise<{ layer: Layer; rows: Array<{ name: string; value: string; updated_at: Date; updated_by: string | null }> }> {
  const res = await query<{ name: string; value: string; updated_at: Date; updated_by: string | null }>(
    'SELECT name, value, updated_at, updated_by FROM server_settings',
  );
  const layer: Layer = {};
  for (const row of res.rows) {
    if ((RUNTIME_SETTING_ENV_VARS as readonly string[]).includes(row.name)) layer[row.name as RuntimeSettingEnvVar] = row.value;
  }
  return { layer, rows: res.rows };
}

/** Re-read the admin's changes from the database. Never throws. */
export async function refreshRuntimeSettings(): Promise<void> {
  try {
    const { layer } = await readAdminLayer();
    state = computeState(layer, state);
  } catch (err) {
    console.error('Runtime settings: could not read server_settings:', err instanceof Error ? err.message : err);
  }
}

let timer: ReturnType<typeof setInterval> | null = null;

export async function startRuntimeSettings(): Promise<void> {
  await refreshRuntimeSettings();
  if (timer) return;
  timer = setInterval(() => { void refreshRuntimeSettings(); }, REFRESH_INTERVAL_MS);
  timer.unref();
}

export function stopRuntimeSettings(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

// ── The admin API ────────────────────────────────────────────────

export interface SettingView {
  id: SettingId;
  envVar: RuntimeSettingEnvVar;
  value: SettingValue;
  source: SettingSource;
  /** Set by the server's environment: shown, never changeable here. */
  fixed: boolean;
  /** What the setting falls back to without an admin's change. */
  fallback: SettingValue;
  fallbackSource: Exclude<SettingSource, 'admin'>;
  changedAt?: string;
}

export interface SettingsView {
  /** OPENFEDERATION_PROFILE, when set: it supplies the defaults. */
  profile?: IdentityProfile;
  settings: SettingView[];
  /** Why the saved changes are ignored, while they conflict with the environment. */
  problem?: string;
  refreshSeconds: number;
}

export async function describeRuntimeSettings(): Promise<SettingsView> {
  const { layer, rows } = await readAdminLayer();
  state = computeState(layer, state);
  let fallback: Resolved;
  try {
    fallback = resolveRuntimeSettings(process.env, {}, config.setupFileSettings);
  } catch {
    fallback = state;
  }
  const changedAt = new Map(rows.map((r) => [r.name, new Date(r.updated_at).toISOString()]));
  return {
    ...(state.settings.identity.profile ? { profile: state.settings.identity.profile } : {}),
    ...(state.problem ? { problem: state.problem } : {}),
    refreshSeconds: REFRESH_INTERVAL_MS / 1000,
    settings: SETTING_ID_LIST.map((id) => {
      const fallbackSource = fallback.sources[id] as Exclude<SettingSource, 'admin'>;
      const view: SettingView = {
        id,
        envVar: SETTING_IDS[id],
        value: settingValue(state.settings, id),
        // While the saved changes conflict with the environment, this is
        // already the value without them.
        source: state.sources[id],
        fixed: state.sources[id] === 'environment',
        fallback: settingValue(fallback.settings, id),
        fallbackSource,
      };
      const at = changedAt.get(SETTING_IDS[id]);
      if (at && view.source === 'admin') view.changedAt = at;
      return view;
    }),
  };
}

export interface SettingChange { id: SettingId; envVar: RuntimeSettingEnvVar; before: SettingValue; after: SettingValue; reset: boolean }

/**
 * Apply an admin's changes: a value sets the setting, null removes the
 * admin's change (back to the setup choice or the default). All or nothing:
 * any invalid value or combination refuses the whole change.
 */
export async function updateRuntimeSettings(changes: Record<string, unknown>, actorId: string | null): Promise<SettingChange[]> {
  const ids = Object.keys(changes);
  if (ids.length === 0) throw new SettingsError(400, 'InvalidRequest', 'Nothing to change.');
  for (const id of ids) {
    if (!(SETTING_ID_LIST as string[]).includes(id)) throw new SettingsError(400, 'InvalidRequest', `There is no setting called ${id}.`);
  }
  const env = environmentLayer(process.env);
  const encoded = new Map<SettingId, string | null>();
  for (const id of ids as SettingId[]) {
    if (env[SETTING_IDS[id]] !== undefined) {
      throw new SettingsError(400, 'SettingFixedByEnvironment',
        `This setting is set by the server's environment (${SETTING_IDS[id]}) and cannot be changed here. Change it where the server's environment variables are set, then restart the server.`, id);
    }
    const value = changes[id];
    encoded.set(id, value === null ? null : encodeSetting(id, value));
  }

  const client = await getClient();
  let next: State;
  let before: State;
  try {
    await client.query('BEGIN');
    // One change at a time, across every instance.
    await client.query('LOCK TABLE server_settings IN SHARE ROW EXCLUSIVE MODE');
    const res = await client.query<{ name: string; value: string }>('SELECT name, value FROM server_settings');
    const current: Layer = {};
    for (const row of res.rows) {
      if ((RUNTIME_SETTING_ENV_VARS as readonly string[]).includes(row.name)) current[row.name as RuntimeSettingEnvVar] = row.value;
    }
    before = computeState(current, state);
    const after: Layer = { ...current };
    for (const [id, value] of encoded) {
      if (value === null) delete after[SETTING_IDS[id]];
      else after[SETTING_IDS[id]] = value;
    }
    checkDefaultOffered({ ...config.setupFileSettings, ...after, ...env });
    let resolved: Resolved;
    try {
      resolved = resolveRuntimeSettings(process.env, after, config.setupFileSettings);
    } catch (err) {
      throw new SettingsError(400, 'InvalidCombination', err instanceof Error ? err.message : String(err));
    }
    checkDeviceSigning(resolved.settings, new Set(encoded.keys()));

    for (const [id, value] of encoded) {
      if (value === null) {
        await client.query('DELETE FROM server_settings WHERE name = $1', [SETTING_IDS[id]]);
      } else {
        await client.query(
          `INSERT INTO server_settings (name, value, updated_at, updated_by) VALUES ($1, $2, NOW(), $3)
           ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW(), updated_by = EXCLUDED.updated_by`,
          [SETTING_IDS[id], value, actorId],
        );
      }
    }
    await client.query('COMMIT');
    next = { ...resolved, admin: after, problem: null };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }

  state = next;
  return [...encoded.keys()].map((id) => ({
    id,
    envVar: SETTING_IDS[id],
    before: settingValue(before.settings, id),
    after: settingValue(next.settings, id),
    reset: encoded.get(id) === null,
  }));
}
