#!/usr/bin/env node
/**
 * Fails when production dependencies have a high or critical advisory that is
 * not accepted in .github/audit-allowlist.json, or when an accepted entry is
 * past its review date. Reads `npm audit --omit=dev --json` on stdin.
 *
 *   npm audit --omit=dev --json | node scripts/audit-check.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export function checkAudit(report, allowlist, today = new Date()) {
  const accepted = new Map(allowlist.accepted.map((a) => [a.id, a]));
  const found = new Map();
  for (const [pkg, v] of Object.entries(report.vulnerabilities ?? {})) {
    for (const via of v.via ?? []) {
      if (typeof via !== 'object' || !['high', 'critical'].includes(via.severity)) continue;
      const id = String(via.url ?? '').split('/').pop() || `${pkg}:${via.title}`;
      found.set(id, { id, package: via.name ?? pkg, severity: via.severity, title: via.title });
    }
  }
  const unaccepted = [...found.values()].filter((f) => !accepted.has(f.id));
  const expired = [...found.values()]
    .map((f) => accepted.get(f.id))
    .filter((a) => a && new Date(a.review_by) < today);
  return { found: [...found.values()], unaccepted, expired };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const allowlist = JSON.parse(readFileSync(join(root, '.github', 'audit-allowlist.json'), 'utf8'));
  const report = JSON.parse(readFileSync(0, 'utf8') || '{}');
  const { found, unaccepted, expired } = checkAudit(report, allowlist);
  for (const f of found) {
    const state = unaccepted.includes(f) ? 'NOT ACCEPTED' : 'accepted';
    console.log(`${f.severity.padEnd(8)} ${f.id} ${f.package}: ${f.title} [${state}]`);
  }
  for (const a of expired) console.log(`EXPIRED   ${a.id} ${a.package}: review date ${a.review_by} has passed`);
  if (unaccepted.length || expired.length) {
    console.error(`audit-check: ${unaccepted.length} unaccepted, ${expired.length} past review date. Fix them or update .github/audit-allowlist.json with a reason.`);
    process.exit(1);
  }
  console.log(`audit-check: ok (${found.length} high/critical, all accepted)`);
}
