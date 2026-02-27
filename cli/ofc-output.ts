/**
 * ofc CLI — Output formatting layer
 *
 * Conventions (clig.dev):
 *   stdout → machine-parseable data (tables, key-value, JSON)
 *   stderr → human messages (status, errors, hints)
 *
 * Respects: --json flag, NO_COLOR env, --no-color flag, TTY detection.
 */

import chalk from 'chalk';

// ── Global state (set once from Commander opts) ─────────────────────

let jsonMode = false;

export function setJsonMode(v: boolean): void {
  jsonMode = v;
}

export function isJsonMode(): boolean {
  return jsonMode;
}

// chalk v5 respects NO_COLOR and --no-color automatically via
// process.env.NO_COLOR and chalk.level. Force level 0 if piped.
if (!process.stderr.isTTY || !process.stdout.isTTY) {
  // Don't strip colors when only stdout is piped (common in `ofc ... | jq`)
  // Only disable when stderr is also non-TTY (e.g. `ofc ... 2>&1 | less`)
  if (!process.stderr.isTTY) {
    chalk.level = 0;
  }
}

// ── stderr helpers (human messages) ─────────────────────────────────

export function info(msg: string): void {
  if (jsonMode) return;
  process.stderr.write(`${chalk.blue('ℹ')} ${msg}\n`);
}

export function success(msg: string): void {
  if (jsonMode) return;
  process.stderr.write(`${chalk.green('✓')} ${msg}\n`);
}

export function error(msg: string): void {
  process.stderr.write(`${chalk.red('✗')} ${msg}\n`);
}

export function warn(msg: string): void {
  if (jsonMode) return;
  process.stderr.write(`${chalk.yellow('!')} ${msg}\n`);
}

export function hint(msg: string): void {
  if (jsonMode) return;
  process.stderr.write(`${chalk.dim(msg)}\n`);
}

// ── stdout helpers (machine-parseable data) ─────────────────────────

/** Print aligned columns to stdout. */
export function table(headers: string[], rows: string[][]): void {
  if (jsonMode) return; // caller should use json() instead

  // Calculate column widths
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map(r => (r[i] || '').length)),
  );

  const sep = '  ';
  const headerLine = headers.map((h, i) => h.padEnd(widths[i])).join(sep);
  const divider = widths.map(w => '─'.repeat(w)).join(sep);

  process.stdout.write(headerLine + '\n');
  process.stdout.write(divider + '\n');
  for (const row of rows) {
    const line = row.map((cell, i) => (cell || '').padEnd(widths[i])).join(sep);
    process.stdout.write(line + '\n');
  }
}

/** Print key-value pairs to stdout. */
export function keyValue(pairs: [string, string][]): void {
  if (jsonMode) return;

  const maxKey = Math.max(...pairs.map(([k]) => k.length));
  for (const [key, value] of pairs) {
    process.stdout.write(`${chalk.bold(key.padEnd(maxKey))}  ${value}\n`);
  }
}

/** Print JSON to stdout (always, regardless of jsonMode). */
export function json(data: unknown): void {
  process.stdout.write(JSON.stringify(data, null, 2) + '\n');
}
