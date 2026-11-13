/**
 * Start-up, before the server's configuration is read (#405).
 *
 *  1. The settings file (if the wizard wrote one) fills in every variable the
 *     environment does not set.
 *  2. If this install still needs setting up, the setup server runs until
 *     the wizard is finished; then its settings file is loaded the same way.
 *  3. The caller imports the real server, which reads the configuration for
 *     the first time, so it sees the wizard's settings without a restart.
 *
 * Nothing here imports src/config.ts (see config-file.ts for why).
 */
import { existsSync } from 'node:fs';
import type { Server } from 'node:http';
import { resolveConfigFilePath, readConfigFile, applyConfigToEnv } from './config-file.js';
import { decideStartMode } from './mode.js';
import { ClaimGuard } from './claim.js';
import { createSetupApp } from './setup-app.js';
import { createSetupPool, createSetupStore } from './setup-store.js';

type Env = Record<string, string | undefined>;

export function loadSettingsFile(env: Env): void {
  const path = resolveConfigFilePath(env);
  const values = readConfigFile(path);
  if (!values) return;
  const applied = applyConfigToEnv(values, env);
  const overridden = Object.keys(values).length - applied.length;
  console.log(`Loaded ${applied.length} setting(s) from ${path}` +
    (overridden > 0 ? `; ${overridden} more are set by environment variables, which take precedence.` : '.'));
}

function announce(code: string, env: Env): void {
  const where = env.RAILWAY_PUBLIC_DOMAIN ? `https://${env.RAILWAY_PUBLIC_DOMAIN}/setup` : '/setup on this server\'s address';
  const bar = '='.repeat(64);
  console.log([
    '', bar,
    ' This server is not set up yet.',
    ` Open ${where}`,
    ' and enter this setup code when asked:',
    '',
    `     Setup code: ${code}`,
    '',
    ' The code changes every time the server starts.',
    bar, '',
  ].join('\n'));
}

/**
 * Run the setup server if this start needs one; resolve once setup is
 * finished (with its settings loaded into `env`), or at once when it is not
 * needed.
 */
export async function runSetupIfNeeded(env: Env = process.env): Promise<void> {
  const configPath = resolveConfigFilePath(env);
  const decision = decideStartMode(env, existsSync(configPath));
  if (decision.mode === 'normal') return;

  console.log(`Starting in setup mode (${decision.reason}). Settings will be saved to ${configPath}.`);
  const pool = createSetupPool(env);
  const store = createSetupStore(pool);
  const settingsLost = !existsSync(configPath) && (await store.completedAt().catch(() => null)) !== null;
  if (settingsLost) {
    console.error('FATAL: setup was finished on this server before, but its settings file is missing:');
    console.error(`  ${configPath}`);
    console.error('Restore the settings file you downloaded at the end of setup (or set the same values as');
    console.error('environment variables) and restart. Setup will not run again: it would create new secret');
    console.error('keys, and the keys stored in the database could no longer be unlocked.');
  }

  // A server whose settings were lost serves only the page explaining that:
  // no setup code is printed, because none would be accepted.
  const claim = new ClaimGuard({ announce: (code) => { if (!settingsLost) announce(code, env); } });
  const port = parseInt(env.PORT || '3000', 10);

  await new Promise<void>((resolveDone) => {
    let server: Server;
    const app = createSetupApp({
      env,
      store,
      configPath,
      claim,
      onComplete: () => {
        server.closeAllConnections?.();
        server.close(() => {
          pool.end().catch(() => undefined).finally(() => resolveDone());
        });
      },
    });
    server = app.listen(port, () => console.log(`Setup server listening on port ${port}`));
    const stop = (signal: string) => {
      console.log(`${signal} received during setup; stopping.`);
      server.close(() => { pool.end().finally(() => process.exit(0)); });
      setTimeout(() => process.exit(0), 5000).unref();
    };
    process.once('SIGTERM', () => stop('SIGTERM'));
    process.once('SIGINT', () => stop('SIGINT'));
  });

  process.removeAllListeners('SIGTERM');
  process.removeAllListeners('SIGINT');
  loadSettingsFile(env);
  console.log('Setup finished: starting the server with the new settings.');
}
