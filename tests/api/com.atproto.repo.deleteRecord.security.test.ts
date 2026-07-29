import { beforeAll, describe, expect, it } from 'vitest';
import { Secp256k1Keypair } from '@atproto/crypto';
import { query } from '../../src/db/client.js';
import { decryptKeyBytes } from '../../src/auth/encryption.js';
import {
  getServiceDid,
  signServiceAuthJwt,
} from '../../src/auth/service-auth.js';
import {
  getAdminToken,
  uniqueHandle,
  xrpcAuthGet,
  xrpcAuthPost,
  xrpcGet,
  xrpcPost,
} from './helpers.js';

const SETTINGS_COLLECTION = 'net.openfederation.community.settings';
const PROFILE_COLLECTION = 'net.openfederation.community.profile';
const MEMBER_COLLECTION = 'net.openfederation.community.member';
const ROLE_COLLECTION = 'net.openfederation.community.role';
const UNPROTECTED_COLLECTION = 'com.example.note';
const GENERIC_GOVERNED_COLLECTION = 'net.openfederation.community.auditNote';

type TestUser = {
  accessJwt: string;
  did: string;
  handle: string;
};

async function createApprovedUser(prefix: string): Promise<TestUser> {
  const adminToken = await getAdminToken();
  const handle = uniqueHandle(prefix);
  const invite = await xrpcAuthPost('net.openfederation.invite.create', adminToken, {
    maxUses: 1,
  });
  expect(invite.status).toBe(201);

  const registration = await xrpcPost('net.openfederation.account.register', {
    handle,
    email: `${handle}@test.local`,
    password: 'TestPassword123!',
    inviteCode: invite.body.code,
  });
  expect(registration.status).toBe(201);

  const approval = await xrpcAuthPost('net.openfederation.account.approve', adminToken, {
    userId: registration.body.id,
  });
  expect(approval.status).toBe(200);

  const session = await xrpcPost('com.atproto.server.createSession', {
    identifier: handle,
    password: 'TestPassword123!',
  });
  expect(session.status).toBe(200);

  return {
    accessJwt: session.body.accessJwt,
    did: session.body.did,
    handle: session.body.handle,
  };
}

async function loadSigningKey(did: string): Promise<Secp256k1Keypair> {
  const key = await query<{ signing_key_bytes: Buffer }>(
    'SELECT signing_key_bytes FROM user_signing_keys WHERE user_did = $1',
    [did],
  );
  expect(key.rows).toHaveLength(1);
  const decrypted = await decryptKeyBytes(
    key.rows[0].signing_key_bytes,
    'identity.signing-key',
  );
  return Secp256k1Keypair.import(decrypted, { exportable: true });
}

async function loadCommunitySigningKey(did: string): Promise<Secp256k1Keypair> {
  const key = await query<{ signing_key_bytes: Buffer }>(
    'SELECT signing_key_bytes FROM signing_keys WHERE community_did = $1',
    [did],
  );
  expect(key.rows).toHaveLength(1);
  const decrypted = await decryptKeyBytes(
    key.rows[0].signing_key_bytes,
    'identity.signing-key',
  );
  return Secp256k1Keypair.import(decrypted, { exportable: true });
}

async function createServiceAuthToken(
  user: TestUser,
  lxm: string,
): Promise<string> {
  return signServiceAuthJwt({
    keypair: await loadSigningKey(user.did),
    iss: user.did,
    aud: getServiceDid(),
    exp: Math.floor(Date.now() / 1000) + 60,
    lxm,
  });
}

async function createCommunityServiceAuthToken(
  did: string,
  lxm: string,
): Promise<string> {
  return signServiceAuthJwt({
    keypair: await loadCommunitySigningKey(did),
    iss: did,
    aud: getServiceDid(),
    exp: Math.floor(Date.now() / 1000) + 60,
    lxm,
  });
}

async function installAuditFailureTrigger(input: {
  triggerName: string;
  timing: 'INSERT' | 'UPDATE';
  rkey: string;
}): Promise<void> {
  await query(`DROP TRIGGER IF EXISTS ${input.triggerName} ON audit_log`);
  await query(`DROP FUNCTION IF EXISTS ${input.triggerName}()`);
  await query(`
    CREATE FUNCTION ${input.triggerName}()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      IF NEW.meta->>'rkey' = '${input.rkey}' THEN
        RAISE EXCEPTION 'intentional audit ${input.timing.toLowerCase()} failure';
      END IF;
      RETURN NEW;
    END;
    $$
  `);
  await query(`
    CREATE TRIGGER ${input.triggerName}
    BEFORE ${input.timing} ON audit_log
    FOR EACH ROW
    EXECUTE FUNCTION ${input.triggerName}()
  `);
}

async function removeAuditFailureTrigger(triggerName: string): Promise<void> {
  await query(`DROP TRIGGER IF EXISTS ${triggerName} ON audit_log`);
  await query(`DROP FUNCTION IF EXISTS ${triggerName}()`);
}

describe('com.atproto.repo collection mutation security', () => {
  let owner: TestUser;
  let moderator: TestUser;
  let member: TestUser;
  let communityDid: string;
  let oracleCommunityDid: string;
  let oracleCredential: { id: string; key: string };
  let adminToken: string;

  beforeAll(async () => {
    owner = await createApprovedUser('rp-owner');
    moderator = await createApprovedUser('rp-mod');
    member = await createApprovedUser('rp-member');
    adminToken = await getAdminToken();

    const create = await xrpcAuthPost('net.openfederation.community.create', owner.accessJwt, {
      handle: uniqueHandle('rp-community'),
      didMethod: 'plc',
      visibility: 'private',
      joinPolicy: 'open',
    });
    expect(create.status).toBe(201);
    communityDid = create.body.did;

    const join = await xrpcAuthPost('net.openfederation.community.join', moderator.accessJwt, {
      did: communityDid,
    });
    expect(join.status).toBe(200);

    const roles = await xrpcAuthGet(
      'net.openfederation.community.listRoles',
      owner.accessJwt,
      { communityDid },
    );
    expect(roles.status).toBe(200);
    const moderatorRole = roles.body.roles.find((role: { name: string }) => role.name === 'moderator');
    expect(moderatorRole?.rkey).toBeTruthy();

    const promote = await xrpcAuthPost(
      'net.openfederation.community.updateMember',
      owner.accessJwt,
      {
        communityDid,
        memberDid: moderator.did,
        roleRkey: moderatorRole.rkey,
      },
    );
    expect(promote.status).toBe(200);

    const memberJoin = await xrpcAuthPost(
      'net.openfederation.community.join',
      member.accessJwt,
      { did: communityDid },
    );
    expect(memberJoin.status).toBe(200);

    const createOracleCommunity = await xrpcAuthPost(
      'net.openfederation.community.create',
      member.accessJwt,
      {
        handle: uniqueHandle('rp-oracle'),
        didMethod: 'plc',
        visibility: 'private',
        joinPolicy: 'open',
      },
    );
    expect(createOracleCommunity.status).toBe(201);
    oracleCommunityDid = createOracleCommunity.body.did;

    const credential = await xrpcAuthPost(
      'net.openfederation.oracle.createCredential',
      adminToken,
      {
        communityDid: oracleCommunityDid,
        name: 'Collection policy test Oracle',
      },
    );
    expect(credential.status).toBe(201);
    oracleCredential = {
      id: credential.body.id,
      key: credential.body.key,
    };

    const governance = await xrpcAuthPost(
      'net.openfederation.community.setGovernanceModel',
      member.accessJwt,
      {
        communityDid: oracleCommunityDid,
        governanceModel: 'on-chain',
        governanceConfig: {
          chainId: 'eip155:31337',
          contractAddress: '0x0000000000000000000000000000000000000001',
          protectedCollections: [GENERIC_GOVERNED_COLLECTION],
        },
      },
    );
    expect(governance.status).toBe(200);
  });

  it('forbids a moderator from deleting private community settings', async () => {
    const deletion = await xrpcAuthPost(
      'com.atproto.repo.deleteRecord',
      moderator.accessJwt,
      {
        repo: communityDid,
        collection: SETTINGS_COLLECTION,
        rkey: 'self',
      },
    );

    const settings = await xrpcAuthGet(
      'com.atproto.repo.listRecords',
      owner.accessJwt,
      { repo: communityDid, collection: SETTINGS_COLLECTION },
    );
    const outsiderView = await xrpcGet('net.openfederation.community.get', {
      did: communityDid,
    });

    expect.soft(deletion.status).toBe(403);
    expect.soft(deletion.body.error).toBe('Forbidden');
    expect.soft(settings.status).toBe(200);
    expect.soft(settings.body.records).toHaveLength(1);
    expect.soft(settings.body.records?.[0]?.value?.visibility).toBe('private');
    expect.soft(outsiderView.status).toBe(404);
  });

  it('preserves mandatory settings even when the owner requests deletion', async () => {
    const deletion = await xrpcAuthPost('com.atproto.repo.deleteRecord', owner.accessJwt, {
      repo: communityDid,
      collection: SETTINGS_COLLECTION,
      rkey: 'self',
    });
    const settings = await xrpcAuthGet(
      'com.atproto.repo.listRecords',
      owner.accessJwt,
      { repo: communityDid, collection: SETTINGS_COLLECTION },
    );

    expect.soft(deletion.status).toBe(400);
    expect.soft(deletion.body.error).toBe('UseDedicatedEndpoint');
    expect.soft(settings.body.records).toHaveLength(1);
    expect.soft(settings.body.records?.[0]?.value?.visibility).toBe('private');
  });

  it('forbids a moderator from updating protected settings through putRecord', async () => {
    const settings = await xrpcAuthGet(
      'com.atproto.repo.listRecords',
      owner.accessJwt,
      { repo: communityDid, collection: SETTINGS_COLLECTION },
    );
    const currentSettings = settings.body.records[0].value;

    const update = await xrpcAuthPost('com.atproto.repo.putRecord', moderator.accessJwt, {
      repo: communityDid,
      collection: SETTINGS_COLLECTION,
      rkey: 'self',
      record: {
        ...currentSettings,
        visibility: 'public',
      },
    });

    expect(update.status).toBe(403);
    expect(update.body.error).toBe('Forbidden');

    const preserved = await xrpcAuthGet(
      'com.atproto.repo.listRecords',
      owner.accessJwt,
      { repo: communityDid, collection: SETTINGS_COLLECTION },
    );
    expect(preserved.body.records[0].value.visibility).toBe('private');
  });

  it('forces community profile replacement and deletion through the specialized endpoint', async () => {
    const profiles = await xrpcAuthGet(
      'com.atproto.repo.listRecords',
      owner.accessJwt,
      { repo: communityDid, collection: PROFILE_COLLECTION },
    );
    expect(profiles.status).toBe(200);
    const currentProfile = profiles.body.records[0].value;

    const update = await xrpcAuthPost(
      'com.atproto.repo.putRecord',
      moderator.accessJwt,
      {
        repo: communityDid,
        collection: PROFILE_COLLECTION,
        rkey: 'self',
        record: {
          ...currentProfile,
          displayName: 'Moderator bypass',
          arbitraryField: 'not accepted by community.update',
        },
      },
    );
    const deletion = await xrpcAuthPost(
      'com.atproto.repo.deleteRecord',
      moderator.accessJwt,
      {
        repo: communityDid,
        collection: PROFILE_COLLECTION,
        rkey: 'self',
      },
    );
    const preserved = await xrpcAuthGet(
      'com.atproto.repo.listRecords',
      owner.accessJwt,
      { repo: communityDid, collection: PROFILE_COLLECTION },
    );

    expect.soft(update.status).toBe(400);
    expect.soft(update.body.error).toBe('UseDedicatedEndpoint');
    expect.soft(deletion.status).toBe(400);
    expect.soft(deletion.body.error).toBe('UseDedicatedEndpoint');
    expect.soft(preserved.body.records).toHaveLength(1);
    expect.soft(preserved.body.records[0].value).toEqual(currentProfile);
  });

  it('prevents generic member writes from promoting a moderator to legacy owner', async () => {
    const members = await xrpcAuthGet(
      'com.atproto.repo.listRecords',
      moderator.accessJwt,
      { repo: communityDid, collection: MEMBER_COLLECTION },
    );
    const moderatorRecord = members.body.records.find(
      (member: { value: { did?: string } }) => member.value.did === moderator.did,
    );
    expect(moderatorRecord).toBeTruthy();
    const moderatorRkey = moderatorRecord.uri.split('/').pop();

    const promotion = await xrpcAuthPost(
      'com.atproto.repo.putRecord',
      moderator.accessJwt,
      {
        repo: communityDid,
        collection: MEMBER_COLLECTION,
        rkey: moderatorRkey,
        record: {
          ...moderatorRecord.value,
          role: 'owner',
          roleRkey: null,
        },
      },
    );
    const capabilities = await xrpcAuthGet(
      'net.openfederation.community.myCapabilities',
      moderator.accessJwt,
      { communityDid },
    );

    expect.soft(promotion.status).toBe(400);
    expect.soft(promotion.body.error).toBe('UseDedicatedEndpoint');
    expect.soft(capabilities.body.permissions).not.toContain('community.settings.write');
  });

  it('forbids a moderator from creating a protected role through createRecord', async () => {
    const creation = await xrpcAuthPost(
      'com.atproto.repo.createRecord',
      moderator.accessJwt,
      {
        repo: communityDid,
        collection: ROLE_COLLECTION,
        rkey: 'unauthorized-role',
        record: {
          name: 'unauthorized',
          permissions: ['community.settings.write'],
        },
      },
    );

    expect(creation.status).toBe(403);
    expect(creation.body.error).toBe('Forbidden');

    const roles = await xrpcAuthGet(
      'com.atproto.repo.listRecords',
      owner.accessJwt,
      { repo: communityDid, collection: ROLE_COLLECTION },
    );
    expect(
      roles.body.records.some(
        (role: { value: { name?: string } }) => role.value.name === 'unauthorized',
      ),
    ).toBe(false);
  });

  it('returns Forbidden instead of an undeclared error for a non-community target repo', async () => {
    const deletion = await xrpcAuthPost(
      'com.atproto.repo.deleteRecord',
      moderator.accessJwt,
      {
        repo: `did:plc:missing-${Date.now()}`,
        collection: UNPROTECTED_COLLECTION,
        rkey: 'missing',
      },
    );

    expect(deletion.status).toBe(403);
    expect(deletion.body.error).toBe('Forbidden');
  });

  it('preserves ordinary self-repo mutations and unprotected community mutations', async () => {
    const selfCreate = await xrpcAuthPost('com.atproto.repo.createRecord', moderator.accessJwt, {
      repo: moderator.did,
      collection: UNPROTECTED_COLLECTION,
      rkey: 'self-note',
      record: { text: 'self repo remains ATProto-compatible' },
    });
    expect(selfCreate.status).toBe(200);

    const communityCreate = await xrpcAuthPost('com.atproto.repo.createRecord', owner.accessJwt, {
      repo: communityDid,
      collection: UNPROTECTED_COLLECTION,
      rkey: 'community-note',
      record: { text: 'allowed community record' },
    });
    expect(communityCreate.status).toBe(200);

    const moderatorDelete = await xrpcAuthPost(
      'com.atproto.repo.deleteRecord',
      moderator.accessJwt,
      {
        repo: communityDid,
        collection: UNPROTECTED_COLLECTION,
        rkey: 'community-note',
      },
    );
    expect(moderatorDelete.status).toBe(200);

    const selfDelete = await xrpcAuthPost('com.atproto.repo.deleteRecord', moderator.accessJwt, {
      repo: moderator.did,
      collection: UNPROTECTED_COLLECTION,
      rkey: 'self-note',
    });
    expect(selfDelete.status).toBe(200);
  });

  it('allows direct member self-repo writes but rejects cross-community writes', async () => {
    const selfCreate = await xrpcAuthPost(
      'com.atproto.repo.createRecord',
      member.accessJwt,
      {
        repo: member.did,
        collection: UNPROTECTED_COLLECTION,
        rkey: 'direct-member-self',
        record: { text: 'member self write' },
      },
    );
    const crossCommunityCreate = await xrpcAuthPost(
      'com.atproto.repo.createRecord',
      member.accessJwt,
      {
        repo: communityDid,
        collection: UNPROTECTED_COLLECTION,
        rkey: 'direct-member-cross-community',
        record: { text: 'member cross-community write' },
      },
    );
    const cleanup = await xrpcAuthPost(
      'com.atproto.repo.deleteRecord',
      member.accessJwt,
      {
        repo: member.did,
        collection: UNPROTECTED_COLLECTION,
        rkey: 'direct-member-self',
      },
    );

    expect.soft(selfCreate.status).toBe(200);
    expect.soft(crossCommunityCreate.status).toBe(403);
    expect.soft(crossCommunityCreate.body.error).toBe('Forbidden');
    expect.soft(cleanup.status).toBe(200);
  });

  it('allows service-auth self-repo writes but rejects cross-community writes', async () => {
    const selfToken = await createServiceAuthToken(
      member,
      'com.atproto.repo.createRecord',
    );
    const selfCreate = await xrpcAuthPost(
      'com.atproto.repo.createRecord',
      selfToken,
      {
        repo: member.did,
        collection: UNPROTECTED_COLLECTION,
        rkey: 'service-auth-self',
        record: { text: 'service-auth self write' },
      },
    );
    const crossCommunityToken = await createServiceAuthToken(
      member,
      'com.atproto.repo.createRecord',
    );
    const crossCommunityCreate = await xrpcAuthPost(
      'com.atproto.repo.createRecord',
      crossCommunityToken,
      {
        repo: communityDid,
        collection: UNPROTECTED_COLLECTION,
        rkey: 'service-auth-cross-community',
        record: { text: 'service-auth cross-community write' },
      },
    );

    expect.soft(selfCreate.status).toBe(200);
    expect.soft(crossCommunityCreate.status).toBe(403);
    expect.soft(crossCommunityCreate.body.error).toBe('Forbidden');
  });

  it('does not let a signed community DID bypass settings or profile lifecycle policy', async () => {
    const create = await xrpcAuthPost(
      'net.openfederation.community.create',
      owner.accessJwt,
      {
        handle: uniqueHandle('rp-svccomm'),
        didMethod: 'plc',
        visibility: 'private',
        joinPolicy: 'approval',
      },
    );
    expect(create.status).toBe(201);
    const serviceCommunityDid = create.body.did;

    const settingsBefore = await xrpcAuthGet(
      'com.atproto.repo.listRecords',
      owner.accessJwt,
      {
        repo: serviceCommunityDid,
        collection: SETTINGS_COLLECTION,
      },
    );
    const profileBefore = await xrpcAuthGet(
      'com.atproto.repo.listRecords',
      owner.accessJwt,
      {
        repo: serviceCommunityDid,
        collection: PROFILE_COLLECTION,
      },
    );

    const settingsToken = await createCommunityServiceAuthToken(
      serviceCommunityDid,
      'com.atproto.repo.putRecord',
    );
    const settingsBypass = await xrpcAuthPost(
      'com.atproto.repo.putRecord',
      settingsToken,
      {
        repo: serviceCommunityDid,
        collection: SETTINGS_COLLECTION,
        rkey: 'self',
        record: {
          governanceModel: 'benevolent-dictator',
          visibility: 'public',
        },
      },
    );
    const profileToken = await createCommunityServiceAuthToken(
      serviceCommunityDid,
      'com.atproto.repo.deleteRecord',
    );
    const profileBypass = await xrpcAuthPost(
      'com.atproto.repo.deleteRecord',
      profileToken,
      {
        repo: serviceCommunityDid,
        collection: PROFILE_COLLECTION,
        rkey: 'self',
      },
    );

    const settingsAfter = await xrpcAuthGet(
      'com.atproto.repo.listRecords',
      owner.accessJwt,
      {
        repo: serviceCommunityDid,
        collection: SETTINGS_COLLECTION,
      },
    );
    const profileAfter = await xrpcAuthGet(
      'com.atproto.repo.listRecords',
      owner.accessJwt,
      {
        repo: serviceCommunityDid,
        collection: PROFILE_COLLECTION,
      },
    );

    expect.soft(settingsBypass.status).toBe(403);
    expect.soft(settingsBypass.body.error).toBe('Forbidden');
    expect.soft(profileBypass.status).toBe(403);
    expect.soft(profileBypass.body.error).toBe('Forbidden');
    expect.soft(settingsAfter.body.records[0].value).toEqual(
      settingsBefore.body.records[0].value,
    );
    expect.soft(profileAfter.body.records[0].value).toEqual(
      profileBefore.body.records[0].value,
    );
  });

  it('rejects an Oracle-authorized protected mutation without proof evidence', async () => {
    const update = await xrpcAuthPost(
      'com.atproto.repo.putRecord',
      member.accessJwt,
      {
        repo: oracleCommunityDid,
        collection: GENERIC_GOVERNED_COLLECTION,
        rkey: 'proofless',
        record: { text: 'must not be applied without proof evidence' },
      },
    ).set('X-Oracle-Key', oracleCredential.key);
    const records = await xrpcAuthGet(
      'com.atproto.repo.listRecords',
      member.accessJwt,
      {
        repo: oracleCommunityDid,
        collection: GENERIC_GOVERNED_COLLECTION,
      },
    );
    const audit = await query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM audit_log
       WHERE action = 'oracle.proofApplied'
         AND actor_id = $1
         AND target_id = $2
         AND meta->>'rkey' = 'proofless'`,
      [oracleCredential.id, oracleCommunityDid],
    );

    expect.soft(update.status).toBe(400);
    expect.soft(update.body.error).toBe('InvalidRequest');
    expect.soft(
      records.body.records.some(
        (entry: { uri: string }) => entry.uri.endsWith('/proofless'),
      ),
    ).toBe(false);
    expect.soft(audit.rows[0].count).toBe('0');
  });

  it('does not mutate when the required pending audit insert fails', async () => {
    const rkey = 'audit-insert-failure';
    const triggerName = 'test_fail_oracle_audit_insert';
    await installAuditFailureTrigger({
      triggerName,
      timing: 'INSERT',
      rkey,
    });

    let update;
    try {
      update = await xrpcAuthPost(
        'com.atproto.repo.putRecord',
        member.accessJwt,
        {
          repo: oracleCommunityDid,
          collection: GENERIC_GOVERNED_COLLECTION,
          rkey,
          record: { text: 'must not survive a pending-audit insert failure' },
          governanceProof: {
            chainId: 'eip155:31337',
            transactionHash: '0xauditinsertfailure',
          },
        },
      ).set('X-Oracle-Key', oracleCredential.key);
    } finally {
      await removeAuditFailureTrigger(triggerName);
    }

    const records = await xrpcAuthGet(
      'com.atproto.repo.listRecords',
      member.accessJwt,
      {
        repo: oracleCommunityDid,
        collection: GENERIC_GOVERNED_COLLECTION,
      },
    );
    const audit = await query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM audit_log
       WHERE target_id = $1
         AND meta->>'rkey' = $2`,
      [oracleCommunityDid, rkey],
    );

    expect.soft(update.status).toBe(500);
    expect.soft(update.body.error).toBe('InternalServerError');
    expect.soft(
      records.body.records.some(
        (entry: { uri: string }) => entry.uri.endsWith(`/${rkey}`),
      ),
    ).toBe(false);
    expect.soft(audit.rows[0].count).toBe('0');
  });

  it('keeps durable pending evidence when audit finalization fails after mutation', async () => {
    const rkey = 'audit-finalize-failure';
    const triggerName = 'test_fail_oracle_audit_finalize';
    await installAuditFailureTrigger({
      triggerName,
      timing: 'UPDATE',
      rkey,
    });

    let update;
    try {
      update = await xrpcAuthPost(
        'com.atproto.repo.putRecord',
        member.accessJwt,
        {
          repo: oracleCommunityDid,
          collection: GENERIC_GOVERNED_COLLECTION,
          rkey,
          record: { text: 'mutation with durable pending evidence' },
          governanceProof: {
            chainId: 'eip155:31337',
            transactionHash: '0xauditfinalizefailure',
          },
        },
      ).set('X-Oracle-Key', oracleCredential.key);
    } finally {
      await removeAuditFailureTrigger(triggerName);
    }

    const records = await xrpcAuthGet(
      'com.atproto.repo.listRecords',
      member.accessJwt,
      {
        repo: oracleCommunityDid,
        collection: GENERIC_GOVERNED_COLLECTION,
      },
    );
    const audit = await query<{
      action: string;
      meta: { status: string; rkey: string; authorizationKey: string };
    }>(
      `SELECT action, meta
       FROM audit_log
       WHERE target_id = $1
         AND meta->>'rkey' = $2
       ORDER BY id DESC
       LIMIT 1`,
      [oracleCommunityDid, rkey],
    );

    expect.soft(update.status).toBe(500);
    expect.soft(update.body.error).toBe('InternalServerError');
    expect.soft(
      records.body.records.some(
        (entry: { uri: string }) => entry.uri.endsWith(`/${rkey}`),
      ),
    ).toBe(true);
    expect.soft(audit.rows).toHaveLength(1);
    expect.soft(audit.rows[0]).toMatchObject({
      action: 'oracle.proofAuthorized',
      meta: {
        status: 'pending',
        rkey,
        authorizationKey: expect.any(String),
        operation: 'put',
        recordCid: expect.any(String),
      },
    });
  });

  it('allows an Oracle-approved generic governed mutation and audits its proof', async () => {
    const governanceProof = {
      chainId: 'eip155:31337',
      transactionHash: '0xcollectionpolicy',
    };
    const update = await xrpcAuthPost('com.atproto.repo.putRecord', member.accessJwt, {
      repo: oracleCommunityDid,
      collection: GENERIC_GOVERNED_COLLECTION,
      rkey: 'oracle-approved',
      record: { text: 'Oracle-approved generic record' },
      governanceProof,
    }).set('X-Oracle-Key', oracleCredential.key);

    expect(update.status).toBe(200);

    const replay = await xrpcAuthPost('com.atproto.repo.putRecord', member.accessJwt, {
      repo: oracleCommunityDid,
      collection: GENERIC_GOVERNED_COLLECTION,
      rkey: 'oracle-approved',
      record: { text: 'must not overwrite the idempotent first application' },
      governanceProof,
    }).set('X-Oracle-Key', oracleCredential.key);
    const stored = await xrpcAuthGet(
      'com.atproto.repo.listRecords',
      member.accessJwt,
      {
        repo: oracleCommunityDid,
        collection: GENERIC_GOVERNED_COLLECTION,
      },
    );
    const storedRecord = stored.body.records.find(
      (entry: { uri: string }) => entry.uri.endsWith('/oracle-approved'),
    );

    const audit = await query<{
      action: string;
      actor_id: string;
      target_id: string;
      meta: {
        collection: string;
        rkey: string;
        action: string;
        proof: typeof governanceProof;
      };
    }>(
      `SELECT action, actor_id, target_id, meta
       FROM audit_log
       WHERE action = 'oracle.proofApplied'
         AND actor_id = $1
         AND target_id = $2
         AND meta->'proof'->>'transactionHash' = $3
       ORDER BY id`,
      [
        oracleCredential.id,
        oracleCommunityDid,
        governanceProof.transactionHash,
      ],
    );
    expect(replay.status).toBe(200);
    expect(storedRecord.value.text).toBe('Oracle-approved generic record');
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({
      action: 'oracle.proofApplied',
      actor_id: oracleCredential.id,
      target_id: oracleCommunityDid,
      meta: {
        collection: GENERIC_GOVERNED_COLLECTION,
        rkey: 'oracle-approved',
        action: 'write',
        status: 'applied',
        authorizationKey: expect.any(String),
        authorizedAt: expect.any(String),
        appliedAt: expect.any(String),
        operation: 'put',
        recordCid: expect.any(String),
        proof: governanceProof,
      },
    });
  });

  it('blocks raw on-chain settings downgrade and malformed replacement through putRecord', async () => {
    const create = await xrpcAuthPost(
      'net.openfederation.community.create',
      moderator.accessJwt,
      {
        handle: uniqueHandle('rp-bypass'),
        didMethod: 'plc',
        visibility: 'private',
        joinPolicy: 'approval',
      },
    );
    expect(create.status).toBe(201);
    const protectedCommunityDid = create.body.did;

    const credential = await xrpcAuthPost(
      'net.openfederation.oracle.createCredential',
      adminToken,
      {
        communityDid: protectedCommunityDid,
        name: 'Settings bypass regression Oracle',
      },
    );
    expect(credential.status).toBe(201);

    const governance = await xrpcAuthPost(
      'net.openfederation.community.setGovernanceModel',
      moderator.accessJwt,
      {
        communityDid: protectedCommunityDid,
        governanceModel: 'on-chain',
        governanceConfig: {
          chainId: 'eip155:31337',
          contractAddress: '0x0000000000000000000000000000000000000002',
        },
      },
    );
    expect(governance.status).toBe(200);

    const bypass = await xrpcAuthPost(
      'com.atproto.repo.putRecord',
      moderator.accessJwt,
      {
        repo: protectedCommunityDid,
        collection: SETTINGS_COLLECTION,
        rkey: 'self',
        record: {
          governanceModel: 'benevolent-dictator',
        },
        governanceProof: {
          chainId: 'eip155:31337',
          transactionHash: '0xsettingsbypass',
        },
      },
    ).set('X-Oracle-Key', credential.body.key);
    const settings = await xrpcAuthGet(
      'com.atproto.repo.listRecords',
      moderator.accessJwt,
      {
        repo: protectedCommunityDid,
        collection: SETTINGS_COLLECTION,
      },
    );

    expect.soft(bypass.status).toBe(400);
    expect.soft(bypass.body.error).toBe('UseDedicatedEndpoint');
    expect.soft(settings.body.records).toHaveLength(1);
    expect.soft(settings.body.records[0].value).toMatchObject({
      governanceModel: 'on-chain',
      visibility: 'private',
      joinPolicy: 'approval',
    });
  });
});
