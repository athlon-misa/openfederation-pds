/**
 * What a demo server (DEMO_MODE=true) starts with: a visitor must be able to
 * sign up, make pen names, publish and move between the two demo servers
 * without an invite, an admin or an email. A default layer like the profile's
 * (src/settings/runtime-settings.ts): the environment, an admin's change and
 * the setup wizard's choice all still win over it.
 *
 * DEMO_MODE itself is read from the environment only; it is not a runtime
 * setting and nothing on the dashboard can switch it.
 */
import type { RuntimeSettingEnvVar } from '../settings/keys.js';

export const DEMO_SETTING_DEFAULTS: Readonly<Partial<Record<RuntimeSettingEnvVar, string>>> = Object.freeze({
  INVITE_REQUIRED: 'false',
  ACCOUNT_APPROVAL: 'automatic',
  EMAIL_VERIFICATION_POLICY: 'off',
  PSEUDONYMS_ENABLED: 'true',
  DEVICE_SIGNING_ALLOWED: 'true',
  IDENTITY_CUSTODY_ALLOWED: 'custodial,assisted,self',
  MIGRATION_ACCOUNTS: 'open',
  MIGRATION_PSEUDONYMS: 'open',
  MIGRATION_COMMUNITIES: 'open',
});

/** DEMO_MODE=true. Anything but true, false or unset is refused at start-up (readDemoConfig). */
export function isDemoModeEnv(env: Record<string, string | undefined>): boolean {
  return env.DEMO_MODE?.trim().toLowerCase() === 'true';
}
