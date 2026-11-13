/**
 * The settings file the setup wizard writes (#405).
 *
 * The server reads its configuration from environment variables, and keeps
 * doing so. The wizard does not change that: it writes the variables it
 * chose into one file on the server's persistent disk, and at start-up that
 * file fills in every variable the environment does not already set. So:
 *
 *  - an operator who configures everything with environment variables sees
 *    no difference (no file, nothing read);
 *  - an environment variable always wins over the file, which is how an
 *    operator overrides one wizard setting without editing the file;
 *  - the file is plain `KEY=value` lines, the same format as `.env`, so it
 *    can be read, backed up, or turned into environment variables by hand.
 *
 * Nothing in src/setup/ may import src/config.ts: that module reads the
 * environment once, when first imported, and the setup wizard runs before
 * the file it writes exists. tests/unit/setup-config-free.test.ts holds this.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync, chmodSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import dotenv from 'dotenv';

export const CONFIG_FILE_NAME = 'openfederation.env';

type Env = Record<string, string | undefined>;

/**
 * Where the settings file lives:
 *  1. OPENFEDERATION_CONFIG_FILE, when set;
 *  2. on Railway, the root of the volume attached to the service;
 *  3. otherwise `data/openfederation.env` under the working directory (in the
 *     Docker image, /app/data, next to the local blob store).
 */
export function resolveConfigFilePath(env: Env, cwd: string = process.cwd()): string {
  const explicit = env.OPENFEDERATION_CONFIG_FILE?.trim();
  if (explicit) return isAbsolute(explicit) ? explicit : resolve(cwd, explicit);
  const volume = env.RAILWAY_VOLUME_MOUNT_PATH?.trim();
  if (volume) return join(volume, CONFIG_FILE_NAME);
  return join(cwd, 'data', CONFIG_FILE_NAME);
}

export function readConfigFile(path: string): Record<string, string> | null {
  if (!existsSync(path)) return null;
  return dotenv.parse(readFileSync(path, 'utf-8'));
}

/**
 * Fill in, from the file, every variable the environment does not set.
 * Returns the names it filled in (never the values: they include secrets).
 */
export function applyConfigToEnv(values: Record<string, string>, env: Env = process.env): string[] {
  const applied: string[] = [];
  for (const [key, value] of Object.entries(values)) {
    if (env[key] !== undefined) continue;
    env[key] = value;
    applied.push(key);
  }
  return applied;
}

/** One `KEY=value` line; values are quoted whenever dotenv would misread them bare. */
function line(key: string, value: string): string {
  if (!/^[A-Z][A-Z0-9_]*$/.test(key)) throw new Error(`Not a variable name: ${key}`);
  if (/[\r\n]/.test(value)) throw new Error(`${key} contains a line break`);
  if (value === '' || /^[A-Za-z0-9_.,:/@+=-]+$/.test(value)) return `${key}=${value}`;
  // dotenv reads single-quoted values literally (no escapes, no expansion).
  if (!value.includes("'")) return `${key}='${value}'`;
  if (!value.includes('"') && !value.includes('\\')) return `${key}="${value}"`;
  if (!value.includes('`')) return `${key}=\`${value}\``;
  throw new Error(`${key} cannot be written to the settings file`);
}

export function serializeConfig(values: Record<string, string>, generatedAt: Date = new Date()): string {
  const header = [
    '# OpenFederation PDS settings, written by the setup wizard',
    `# on ${generatedAt.toISOString()}.`,
    '#',
    '# This file holds the server\'s secrets. Keep a private copy (for example in',
    '# a password manager): without KEY_ENCRYPTION_SECRET the keys stored in the',
    '# database cannot be decrypted. Anyone who has this file can act as your server.',
    '#',
    '# Any environment variable with the same name overrides the value here.',
    '',
  ];
  return header.join('\n') + Object.entries(values).map(([k, v]) => line(k, v)).join('\n') + '\n';
}

/**
 * Write the file atomically (temporary file, then rename) and readable by its
 * owner only. Refuses to replace an existing file: the wizard writes it once.
 */
export function writeConfigFile(path: string, values: Record<string, string>): string {
  if (existsSync(path)) throw new Error(`A settings file already exists at ${path}`);
  const text = serializeConfig(values);
  // Prove it reads back exactly before it goes anywhere.
  const roundTrip = dotenv.parse(text);
  for (const [k, v] of Object.entries(values)) {
    if (roundTrip[k] !== v) throw new Error(`${k} does not survive being written to the settings file`);
  }
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600, flag: 'wx' });
  try {
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* already gone */ }
    throw err;
  }
  return text;
}

export function removeConfigFile(path: string): void {
  try { unlinkSync(path); } catch { /* nothing to remove */ }
}

/**
 * Whether the settings file could be written where it is meant to go, tried
 * by writing and removing a probe file. Returns the reason when it cannot.
 */
export function probeConfigLocation(path: string): { writable: boolean; reason?: string } {
  const probe = join(dirname(path), `.openfederation-probe-${randomBytes(4).toString('hex')}`);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(probe, 'probe', { flag: 'wx' });
    unlinkSync(probe);
    return { writable: true };
  } catch (err) {
    return { writable: false, reason: err instanceof Error ? err.message : String(err) };
  }
}
