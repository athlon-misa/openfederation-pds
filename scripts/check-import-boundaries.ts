#!/usr/bin/env node
/**
 * Import-boundary check.
 *
 * One rule, mechanically enforced: **modules import core; core never imports
 * modules.** Anything under `src/modules/` is optional surface (today: the
 * chain module — blockchain as notary, never authority). A pure-federation PDS
 * must be able to drop a module without core noticing, which is only true if
 * no core file reaches into one.
 *
 * Two exceptions, both about composition rather than dependency:
 *
 *   1. The composition roots listed in `COMPOSITION_ROOTS` may import a
 *      module, because something has to wire the application together.
 *   2. Even they may only import a module's public entry point
 *      (`src/modules/<name>/index.ts`) — never its internals.
 *
 * A module may import core freely, and may import its own files. It may not
 * import a *different* module.
 *
 * Run directly (`npm run lint:boundaries`) or import `findBoundaryViolations`
 * from a test.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The only files permitted to import a module. Keep this list tiny and
 * deliberate — every entry is a place where core knows a module exists.
 */
export const COMPOSITION_ROOTS = [
  'src/server/index.ts',
  'src/server/handler-registry.ts',
];

export interface BoundaryViolation {
  file: string;
  specifier: string;
  reason: string;
}

const IMPORT_PATTERN =
  /(?:^|[\s;}])(?:import|export)\s[^;]*?from\s*['"]([^'"]+)['"]|(?:^|[\s;}(=])import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, out);
    } else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

function toPosix(p: string): string {
  return p.split(sep).join('/');
}

/** Which module (if any) does this repo-relative path belong to? */
function moduleOf(relPath: string): string | null {
  const match = /^src\/modules\/([^/]+)\//.exec(relPath);
  return match ? match[1] : null;
}

/**
 * Resolve a relative import specifier to a repo-relative path, normalising the
 * ESM `.js` suffix back to the `.ts` source it refers to.
 */
function resolveSpecifier(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const resolved = posix.normalize(
    posix.join(posix.dirname(toPosix(fromFile)), specifier),
  );
  return resolved.replace(/\.js$/, '.ts');
}

/**
 * Scan `<root>/src` and report every import that crosses the boundary.
 * `root` is a parameter so tests can run the checker over a synthetic tree
 * instead of corrupting real source files.
 */
export function findBoundaryViolations(root = REPO_ROOT): BoundaryViolation[] {
  const violations: BoundaryViolation[] = [];

  for (const absolute of walk(join(root, 'src'))) {
    const file = toPosix(relative(root, absolute));
    const source = readFileSync(absolute, 'utf8');
    const owningModule = moduleOf(file);

    for (const match of source.matchAll(IMPORT_PATTERN)) {
      const specifier = match[1] ?? match[2];
      const target = resolveSpecifier(file, specifier);
      if (!target) continue;

      const targetModule = moduleOf(target);
      if (!targetModule) continue;               // importing core — always fine
      if (targetModule === owningModule) continue; // module's own internals

      if (owningModule) {
        violations.push({
          file,
          specifier,
          reason: `module "${owningModule}" imports module "${targetModule}" — modules must not depend on each other`,
        });
        continue;
      }

      if (!COMPOSITION_ROOTS.includes(file)) {
        violations.push({
          file,
          specifier,
          reason: `core file imports module "${targetModule}" — core must never depend on a module`,
        });
        continue;
      }

      if (target !== `src/modules/${targetModule}/index.ts`) {
        violations.push({
          file,
          specifier,
          reason: `composition root imports module internals; use src/modules/${targetModule}/index.js`,
        });
      }
    }
  }

  return violations;
}

function main(): void {
  const violations = findBoundaryViolations();
  if (violations.length === 0) {
    console.log('Import boundaries OK — no core file depends on src/modules/.');
    return;
  }

  console.error(`Import boundary violations (${violations.length}):`);
  for (const v of violations) {
    console.error(`  ${v.file}: imports '${v.specifier}' — ${v.reason}`);
  }
  console.error(
    '\nRule: modules import core; core never imports modules. Only ' +
      `${COMPOSITION_ROOTS.join(' and ')} may wire a module in, and only via its index.`,
  );
  process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
