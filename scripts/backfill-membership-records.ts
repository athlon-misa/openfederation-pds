/**
 * Backfill membership records in members' own repos (#385).
 *
 *     node --import ./scripts/register-ts-node.mjs scripts/backfill-membership-records.ts [--apply] [--community <did> ...]
 *
 * For every public community hosted here, writes a
 * net.openfederation.community.membership record (rkey = the community's DID)
 * into the repo of each member whose repo is on this PDS and lacks one.
 * Private communities get none. Members on other PDSes and accounts using
 * device signing are skipped: the server cannot write their repos.
 *
 * Without --apply it only reports. Idempotent: running it again writes
 * nothing new.
 */
import { closePool } from '../src/db/client.js';
import { backfillHomeMemberships } from '../src/community/membership/home-record.js';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const communities = args.flatMap((a, i) => (a === '--community' && args[i + 1] ? [args[i + 1]] : []));

async function main(): Promise<void> {
  const r = await backfillHomeMemberships({
    apply,
    communities: communities.length > 0 ? communities : undefined,
    log: (line) => console.log(line),
  });
  console.log(
    `${r.communities} public communities; ${apply ? `wrote ${r.written} of ${r.missing}` : `${r.missing} missing`} membership records; `
    + `${r.skipped} members skipped (repo elsewhere or device signing); ${r.failed} failed.`,
  );
  if (!apply) console.log('Dry run. Add --apply to write.');
  if (r.failed > 0) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => closePool());
