/**
 * Whether this start is a normal start or a first-run setup (#405).
 *
 * Setup mode exists because a production server refuses to start without its
 * secrets, so a fresh install could not even show a page asking for them. It
 * is entered only where the server would otherwise have refused to start, or
 * where the operator asks for it; nothing that starts today starts any
 * differently:
 *
 *   OPENFEDERATION_SETUP=off  never (an operator who wants the old refusal)
 *   settings file present     never: the wizard already ran
 *   OPENFEDERATION_SETUP=on   yes (for trying the wizard outside production)
 *   NODE_ENV=production with neither AUTH_JWT_SECRET nor
 *   KEY_ENCRYPTION_SECRET set yes: an unconfigured install
 *   anything else             no, exactly as before
 *
 * Production with only one of the two secrets set is a half-configured
 * environment-variable install, not a fresh one; it still stops with the
 * usual message rather than offering a wizard that would generate the other.
 */
export type StartMode =
  | { mode: 'normal'; reason: string }
  | { mode: 'setup'; reason: string };

type Env = Record<string, string | undefined>;

export function decideStartMode(env: Env, configFileExists: boolean): StartMode {
  const flag = env.OPENFEDERATION_SETUP?.trim().toLowerCase();
  if (flag === 'off') return { mode: 'normal', reason: 'OPENFEDERATION_SETUP=off' };
  if (configFileExists) return { mode: 'normal', reason: 'settings file present' };
  if (flag === 'on') return { mode: 'setup', reason: 'OPENFEDERATION_SETUP=on' };
  const unset = (name: string) => !env[name]?.trim();
  if (env.NODE_ENV === 'production' && unset('AUTH_JWT_SECRET') && unset('KEY_ENCRYPTION_SECRET')) {
    return { mode: 'setup', reason: 'production with no secrets configured' };
  }
  return { mode: 'normal', reason: 'configured by environment' };
}
