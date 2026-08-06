/**
 * Residuals from the #189 governance branch (#202).
 *
 * Two behaviours and one documentation fix, grouped because each is small:
 *
 *   1. `governanceConfig` merged a level deeper, so a proposal changing one key
 *      no longer silently resets the others.
 *   2. A standing-but-insufficient objection is visible to readers.
 *   3. Three lexicon descriptions state the trust guarantee accurately (asserted
 *      here so the wording cannot quietly regress).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  xrpcGet, xrpcAuthPost,
  createTestUser, isPLCAvailable, uniqueHandle,
} from './helpers.js';
import { recordToWrite } from '../../src/governance/timelock.js';
import { query } from '../../src/db/client.js';

type User = { accessJwt: string; did: string; handle: string };

const SETTINGS_COLLECTION = 'net.openfederation.community.settings';

describe('governanceConfig merges instead of being replaced (#202)', () => {
  let plcAvailable = false;
  let owner: User;
  let communityDid: string;

  beforeAll(async () => {
    plcAvailable = await isPLCAvailable();
    if (!plcAvailable) return;
    owner = await createTestUser(uniqueHandle('res-owner'));
    const created = await xrpcAuthPost('net.openfederation.community.create', owner.accessJwt, {
      handle: uniqueHandle('res-comm'), didMethod: 'plc', visibility: 'public', joinPolicy: 'open',
    });
    expect(created.status).toBe(201);
    communityDid = created.body.did;

    await xrpcAuthPost('net.openfederation.community.setGovernanceModel', owner.accessJwt, {
      communityDid,
      governanceModel: 'simple-majority',
      governanceConfig: {
        quorum: 3, voterRole: 'moderator', proposalTtlDays: 7,
        timelockHours: 48, objectionThreshold: 2,
      },
    });
  });

  it('keeps config keys a proposal did not name', async () => {
    if (!plcAvailable) return;

    // The reported failure: proposing only `quorum` also reset `timelockHours`
    // to 24 and `objectionThreshold` to 1 — changes nobody voted for.
    const merged = await recordToWrite(communityDid, {
      targetCollection: SETTINGS_COLLECTION,
      targetRkey: 'self',
      proposedRecord: { governanceConfig: { quorum: 5 } },
    }) as any;

    expect(merged.governanceConfig.quorum).toBe(5);
    expect(merged.governanceConfig.timelockHours).toBe(48);
    expect(merged.governanceConfig.objectionThreshold).toBe(2);
    expect(merged.governanceConfig.voterRole).toBe('moderator');
  });

  it('still lets a proposal set a key back to a different value', async () => {
    if (!plcAvailable) return;
    const merged = await recordToWrite(communityDid, {
      targetCollection: SETTINGS_COLLECTION,
      targetRkey: 'self',
      proposedRecord: { governanceConfig: { timelockHours: 0 } },
    }) as any;
    expect(merged.governanceConfig.timelockHours).toBe(0);
    expect(merged.governanceConfig.quorum).toBe(3);
  });

  it('still merges unrelated top-level settings fields', async () => {
    if (!plcAvailable) return;
    const merged = await recordToWrite(communityDid, {
      targetCollection: SETTINGS_COLLECTION,
      targetRkey: 'self',
      proposedRecord: { governanceConfig: { quorum: 9 } },
    }) as any;
    // Fields the proposal never named must survive. The settings record holds
    // visibility/joinPolicy/didMethod alongside the governance block.
    expect(merged.visibility).toBeTruthy();
    expect(merged.joinPolicy).toBeTruthy();
    expect(merged.governanceModel).toBe('simple-majority');
  });

  it('leaves non-settings proposals untouched', async () => {
    if (!plcAvailable) return;
    const proposed = { displayName: 'Profile change' };
    const merged = await recordToWrite(communityDid, {
      targetCollection: 'net.openfederation.community.profile',
      targetRkey: 'self',
      proposedRecord: proposed,
    });
    expect(merged).toEqual(proposed);
  });
});

describe('a standing objection is visible before it holds (#202)', () => {
  let plcAvailable = false;
  let owner: User;
  let voters: User[] = [];
  let communityDid: string;
  let proposalRkey: string;

  beforeAll(async () => {
    plcAvailable = await isPLCAvailable();
    if (!plcAvailable) return;

    owner = await createTestUser(uniqueHandle('obj-owner'));
    for (let i = 0; i < 2; i++) voters.push(await createTestUser(uniqueHandle(`obj-v${i}`)));

    const created = await xrpcAuthPost('net.openfederation.community.create', owner.accessJwt, {
      handle: uniqueHandle('obj-comm'), didMethod: 'plc', visibility: 'public', joinPolicy: 'open',
    });
    communityDid = created.body.did;

    const roles = await xrpcGet('net.openfederation.community.listRoles', { communityDid });
    const modRoleRkey = roles.body.roles.find((r: any) => r.name === 'moderator').rkey;
    for (const v of voters) {
      await xrpcAuthPost('net.openfederation.community.join', v.accessJwt, { did: communityDid });
      await xrpcAuthPost('net.openfederation.community.updateMember', owner.accessJwt, {
        communityDid, memberDid: v.did, roleRkey: modRoleRkey,
      });
    }

    // Threshold 2 so a single objection stands without holding — the state that
    // was previously invisible. Long timelock so it stays pending.
    await xrpcAuthPost('net.openfederation.community.setGovernanceModel', owner.accessJwt, {
      communityDid,
      governanceModel: 'simple-majority',
      governanceConfig: {
        quorum: 2, voterRole: 'moderator', proposalTtlDays: 7,
        timelockHours: 48, objectionThreshold: 2,
      },
    });

    const proposal = await xrpcAuthPost('net.openfederation.community.createProposal', owner.accessJwt, {
      communityDid,
      targetCollection: 'net.openfederation.community.profile',
      targetRkey: 'self',
      action: 'write',
      proposedRecord: { displayName: 'Objected' },
    });
    proposalRkey = proposal.body.rkey;
    // Pass it so it enters the contest window.
    await xrpcAuthPost('net.openfederation.community.voteOnProposal', voters[0].accessJwt, {
      communityDid, proposalRkey, vote: 'for',
    });
  });

  it('reports nothing while no objection stands', async () => {
    if (!plcAvailable) return;
    const res = await xrpcGet('net.openfederation.community.getProposal', { communityDid, rkey: proposalRkey });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('pending-application');
    expect(res.body.objectionCount).toBeUndefined();
  });

  it('reports a standing objection that has not yet reached the threshold', async () => {
    if (!plcAvailable) return;

    const obj = await xrpcAuthPost('net.openfederation.community.objectToProposal', voters[1].accessJwt, {
      communityDid, proposalRkey, reason: 'not yet',
    });
    expect(obj.status).toBe(200);

    const res = await xrpcGet('net.openfederation.community.getProposal', { communityDid, rkey: proposalRkey });
    expect(res.status).toBe(200);
    expect(res.body.objectionCount).toBe(1);
    expect(res.body.objectionThreshold).toBe(2);
    // Below the threshold: the application is not held, which is exactly why
    // the count had to be surfaced some other way.
    expect(res.body.status).toBe('pending-application');
  });
});

describe('lexicon descriptions state the guarantee accurately (#202)', () => {
  const read = (name: string) =>
    JSON.parse(readFileSync(`src/lexicon/net.openfederation.governance.${name}.json`, 'utf-8'));

  it.each(['decision', 'vote', 'objection'])(
    '%s no longer claims verification without trusting the PDS',
    (name) => {
      const d = read(name);
      expect(d.description).not.toMatch(/without trusting the community's PDS/i);
      // What it must say instead: the honest property, and the one case where
      // independence really is complete.
      expect(d.description).toMatch(/tamper-evidence and public consistency/i);
      expect(d.description).toMatch(/externally-hosted|does not hold keys for/i);
    },
  );

  it.each([['decision', 2], ['vote', 3], ['objection', 2]])(
    '%s revision bumped to %i for the wording change',
    (name, revision) => {
      expect(read(name as string).revision).toBe(revision);
    },
  );
});
