/**
 * When a community repository is imported (a community moving here), votes and
 * objections in it are kept only if their author signed them. Those are a
 * private community's members' records; anything else in that collection is a
 * claim nobody made.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { Secp256k1Keypair } from '@atproto/crypto';
import { cidForRecord } from '@atproto/repo';
import { setPlcClientForTests } from '../../src/identity/plc-client.js';
import { communityGovernanceRecordsToKeep } from '../../src/repo/import.js';

const COMMUNITY = 'did:plc:importedcommunity00000000';
const VOTER = 'did:plc:importedvoter000000000000';
const VOTE = 'net.openfederation.governance.vote';

async function signed(keypair: Secp256k1Keypair, record: Record<string, unknown>) {
  const unsigned = { ...record, author: VOTER };
  const cid = await cidForRecord(unsigned);
  return { ...unsigned, authorSig: { key: keypair.did(), sig: Buffer.from(await keypair.sign(cid.bytes)).toString('base64url') } };
}

describe('governance records in an imported community repo', () => {
  afterEach(() => setPlcClientForTests(null));

  it('keeps a vote signed by its author, drops unsigned and wrongly signed ones', async () => {
    const voterKey = await Secp256k1Keypair.create();
    const otherKey = await Secp256k1Keypair.create();
    setPlcClientForTests({
      registerDidPlc: async () => { throw new Error('not used'); },
      resolveFromPlc: async () => null,
      getPlcLog: async (did) => (did === VOTER
        ? [{ type: 'plc_operation', rotationKeys: [], verificationMethods: { atproto: voterKey.did() }, alsoKnownAs: [], services: {} }]
        : null),
    });
    const base = { $type: VOTE, community: COMMUNITY, proposalRkey: 'p1', vote: 'for', createdAt: new Date().toISOString() };
    const records = [
      { collection: VOTE, rkey: 'good', cid: 'x', record: await signed(voterKey, base) },
      { collection: VOTE, rkey: 'unsigned', cid: 'x', record: { ...base, author: VOTER } },
      { collection: VOTE, rkey: 'forged', cid: 'x', record: await signed(otherKey, base) },
      { collection: VOTE, rkey: 'anonymous', cid: 'x', record: base },
      { collection: 'net.openfederation.community.profile', rkey: 'self', cid: 'x', record: { displayName: 'x' } },
    ];
    const kept = await communityGovernanceRecordsToKeep(records);
    expect(kept.map((r) => r.rkey).sort()).toEqual(['good', 'self']);
  });
});
