/**
 * Re-wrap every stored key under the current KEY_ENCRYPTION_SECRET.
 *
 *   KEY_ENCRYPTION_SECRET=<new> KEY_ENCRYPTION_SECRET_PREVIOUS=<old> \
 *     node --import ./scripts/register-ts-node.mjs scripts/rotate-key-encryption-secret.ts [--apply]
 *
 * Without --apply it only reports. Exits non-zero if any key opens with
 * neither secret. Full procedure: docs/HARDENING.md.
 */
import { rotateKeyEncryption } from '../src/crypto/rotate-key-encryption.js';
import { closePool } from '../src/db/client.js';

const apply = process.argv.includes('--apply');
try {
  const r = await rotateKeyEncryption({ apply, log: (l) => console.log(l) });
  console.log(`${apply ? 'Re-wrapped' : 'Would re-wrap'} ${apply ? r.rotated : r.toRotate} keys; ${r.failed.length} unreadable; ${r.raced} changed during the run.`);
  for (const f of r.failed) console.error(`UNREADABLE ${f.table}.${f.column} [${f.key}]: ${f.error}`);
  if (r.raced) console.log('Some rows changed while running: run again.');
  if (!apply) console.log('Dry run. Add --apply to write.');
  process.exitCode = r.failed.length ? 1 : 0;
} finally {
  await closePool();
}
