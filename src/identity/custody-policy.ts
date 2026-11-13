/**
 * Custody modes (ADR-003, decisions 1 and 2).
 *
 *  - custodial: the PDS holds the only rotation key (shares 2 and 3).
 *  - assisted:  the user's rotation key first, the PDS's second (PLC lets the
 *               higher key cancel the lower key's update within 72 hours).
 *  - self:      the user's rotation key only. Pseudonyms are self by construction.
 *
 * The installation's policy comes from configuration. A profile only supplies
 * defaults; every setting overrides it. Anything unrecognised stops the server
 * at start-up rather than being silently ignored.
 */
export const CUSTODY_MODES = ['custodial', 'assisted', 'self'] as const;
export type CustodyMode = (typeof CUSTODY_MODES)[number];
export type IdentityProfile = 'community' | 'privacy';

export interface IdentityPolicy {
  profile: IdentityProfile | null;
  /** Modes ordinary accounts may have here; the PDS enforces this. */
  custodyAllowed: CustodyMode[];
  /** A hint for applications' onboarding. */
  custodyDefault: CustodyMode;
  /** New pseudonyms (tokens, creation, moving in). Existing ones keep working. */
  pseudonymsEnabled: boolean;
  /**
   * Whether `self` and `assisted` accounts may turn on device signing (#240):
   * their device holds the repo signing key and this server only prepares
   * commits. Off unless the `privacy` profile or DEVICE_SIGNING_ALLOWED says so.
   */
  deviceSigningAllowed: boolean;
}

const PROFILE_DEFAULTS: Record<IdentityProfile | 'none', Omit<IdentityPolicy, 'profile'>> = {
  none: { custodyAllowed: [...CUSTODY_MODES], custodyDefault: 'custodial', pseudonymsEnabled: true, deviceSigningAllowed: false },
  community: { custodyAllowed: [...CUSTODY_MODES], custodyDefault: 'custodial', pseudonymsEnabled: false, deviceSigningAllowed: false },
  privacy: { custodyAllowed: [...CUSTODY_MODES], custodyDefault: 'self', pseudonymsEnabled: true, deviceSigningAllowed: true },
};

export function isCustodyMode(value: unknown): value is CustodyMode {
  return typeof value === 'string' && (CUSTODY_MODES as readonly string[]).includes(value);
}

export function resolveIdentityPolicy(env: Record<string, string | undefined>): IdentityPolicy {
  const rawProfile = env.OPENFEDERATION_PROFILE?.trim();
  if (rawProfile && rawProfile !== 'community' && rawProfile !== 'privacy') {
    throw new Error(`OPENFEDERATION_PROFILE must be "community" or "privacy", not "${rawProfile}"`);
  }
  const profile = (rawProfile || null) as IdentityProfile | null;
  const base = PROFILE_DEFAULTS[profile ?? 'none'];

  let custodyAllowed = [...base.custodyAllowed];
  if (env.IDENTITY_CUSTODY_ALLOWED !== undefined) {
    const listed = env.IDENTITY_CUSTODY_ALLOWED.split(',').map((m) => m.trim()).filter(Boolean);
    const unknown = listed.filter((m) => !isCustodyMode(m));
    if (listed.length === 0 || unknown.length > 0) {
      throw new Error(`IDENTITY_CUSTODY_ALLOWED must list one or more of ${CUSTODY_MODES.join(', ')}${unknown.length ? ` (unknown: ${unknown.join(', ')})` : ''}`);
    }
    custodyAllowed = CUSTODY_MODES.filter((m) => listed.includes(m));
  }

  let custodyDefault = base.custodyDefault;
  const rawDefault = env.IDENTITY_CUSTODY_DEFAULT?.trim();
  if (rawDefault) {
    if (!isCustodyMode(rawDefault)) throw new Error(`IDENTITY_CUSTODY_DEFAULT must be one of ${CUSTODY_MODES.join(', ')}`);
    custodyDefault = rawDefault;
  }
  if (!custodyAllowed.includes(custodyDefault)) {
    // A profile default that the operator's own list excludes falls back to
    // the first allowed mode; an explicit default must be allowed.
    if (rawDefault) throw new Error(`IDENTITY_CUSTODY_DEFAULT (${custodyDefault}) must be one of IDENTITY_CUSTODY_ALLOWED (${custodyAllowed.join(', ')})`);
    custodyDefault = custodyAllowed[0];
  }

  let pseudonymsEnabled = base.pseudonymsEnabled;
  const rawPseudonyms = env.PSEUDONYMS_ENABLED?.trim();
  if (rawPseudonyms) {
    if (rawPseudonyms !== 'true' && rawPseudonyms !== 'false') throw new Error('PSEUDONYMS_ENABLED must be "true" or "false"');
    pseudonymsEnabled = rawPseudonyms === 'true';
  }

  let deviceSigningAllowed = base.deviceSigningAllowed;
  const rawDeviceSigning = env.DEVICE_SIGNING_ALLOWED?.trim();
  if (rawDeviceSigning) {
    if (rawDeviceSigning !== 'true' && rawDeviceSigning !== 'false') throw new Error('DEVICE_SIGNING_ALLOWED must be "true" or "false"');
    deviceSigningAllowed = rawDeviceSigning === 'true';
  }

  return { profile, custodyAllowed, custodyDefault, pseudonymsEnabled, deviceSigningAllowed };
}

export class CustodyPolicyError extends Error {
  readonly status = 403;
  readonly code = 'CustodyModeNotAllowed';
  constructor(mode: CustodyMode) { super(`This server does not allow ${mode} accounts`); }
}
