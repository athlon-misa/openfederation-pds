/**
 * The settings an admin may change at runtime, on Admin, Server settings
 * (#410), by the environment variable each one has always been read from.
 *
 * Config-free on purpose: src/config.ts and the setup wizard both import it,
 * and nothing under src/setup/ may reach src/config.ts.
 *
 * None of these is a secret, and none may ever become one: their values are
 * shown on the dashboard and written to the audit log.
 */
export const RUNTIME_SETTING_ENV_VARS = [
  'PSEUDONYMS_ENABLED',
  'PSEUDONYM_TOKENS_PER_EPOCH',
  'PSEUDONYM_PROBATION_DAYS',
  'PSEUDONYM_PROBATION_DAILY_WRITES',
  'IDENTITY_CUSTODY_ALLOWED',
  'IDENTITY_CUSTODY_DEFAULT',
  'DEVICE_SIGNING_ALLOWED',
  'INVITE_REQUIRED',
  'EMAIL_VERIFICATION_POLICY',
  'MIGRATION_ACCOUNTS',
  'MIGRATION_PSEUDONYMS',
  'MIGRATION_COMMUNITIES',
  'FEDERATION_PEERS',
] as const;

export type RuntimeSettingEnvVar = (typeof RUNTIME_SETTING_ENV_VARS)[number];

export function isRuntimeSettingEnvVar(name: string): name is RuntimeSettingEnvVar {
  return (RUNTIME_SETTING_ENV_VARS as readonly string[]).includes(name);
}

/**
 * Split the setup wizard's settings file: the runtime settings in it are the
 * wizard's initial choices (a layer below an admin's changes), everything
 * else is applied to the environment as before.
 */
export function splitSettingsFile(values: Record<string, string>): { runtime: Record<string, string>; rest: Record<string, string> } {
  const runtime: Record<string, string> = {};
  const rest: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    if (isRuntimeSettingEnvVar(key)) runtime[key] = value;
    else rest[key] = value;
  }
  return { runtime, rest };
}
