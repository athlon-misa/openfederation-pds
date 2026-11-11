/**
 * Move a community to another PDS (#267, ADR-002, #268). The owner proves
 * control with the community's primary rotation key; the new PDS pulls the
 * repository and files; the DID is changed only once the new PDS reports the
 * exact commit this PDS serves. A failure before that step changes nothing.
 */
import { buildMoveOp, signPlcOp } from '@open-federation/pseudonym';
import { MoveError, call, plcDirectoryOf, type TargetInfo } from './xrpc';
import { signJwt } from './jwt';

export const COMMUNITY_STEPS = [
  { id: 'open', label: 'The new server pulls the community' },
  { id: 'check', label: 'Check it holds exactly what is here' },
  { id: 'point', label: 'Point the community DID at the new server' },
  { id: 'activate', label: 'Switch it on at the new server' },
  { id: 'retire', label: 'Mark the copy here as moved' },
] as const;
export type CommunityStep = (typeof COMMUNITY_STEPS)[number]['id'];
export const COMMUNITY_POINT_OF_NO_RETURN: CommunityStep = 'point';

interface Recommended { rotationKeys: string[]; alsoKnownAs: string[]; verificationMethods: { atproto: string }; services: { atproto_pds: { endpoint: string } } }

export async function moveCommunity(p: {
  oldPdsUrl: string;
  target: TargetInfo;
  did: string;
  ownerDid: string;
  ownerAccessJwt: string;
  rotationKey: Uint8Array;
  newHandle: string;
  inviteCode?: string;
  onStep: (s: CommunityStep) => void;
}): Promise<{ newPdsUrl: string; missingAttestationKeys: number }> {
  const plcUrl = await plcDirectoryOf(p.oldPdsUrl);

  // migrateIn takes the label; the new server adds its own domain.
  const domain = p.target.handleDomains.find((d) => p.newHandle.endsWith(d));
  const label = domain ? p.newHandle.slice(0, -domain.length) : p.newHandle;

  p.onStep('open');
  const proof = signJwt(p.rotationKey, { iss: p.did, aud: p.target.serviceDid, lxm: 'net.openfederation.community.migrateIn', sub: p.ownerDid });
  const opened = await call<{ repoCommit: string; progressCode?: string }>(p.target.url, 'net.openfederation.community.migrateIn', {
    jwt: proof, body: { did: p.did, handle: label, ...(p.inviteCode ? { inviteCode: p.inviteCode } : {}) },
  });

  p.onStep('check');
  const status = await call<{ repoCommit: string; indexedRecords: number; expectedBlobs: number; importedBlobs: number; recommended: Recommended }>(
    p.target.url, 'net.openfederation.community.checkMigration', { query: { did: p.did, ...(opened.progressCode ? { code: opened.progressCode } : {}) } });
  const latest = await call<{ cid: string }>(p.oldPdsUrl, 'com.atproto.sync.getLatestCommit', { query: { did: p.did }, jwt: p.ownerAccessJwt });
  if (status.repoCommit !== opened.repoCommit || status.repoCommit !== latest.cid || status.indexedRecords === 0 || status.importedBlobs !== status.expectedBlobs) {
    throw new MoveError('The new server does not hold exactly what this server serves; the community DID was not changed');
  }

  p.onStep('point');
  const r = status.recommended;
  const logRes = await fetch(`${plcUrl}/${p.did}/log`);
  if (!logRes.ok) throw new MoveError('Could not read the community DID from the PLC directory');
  const log = (await logRes.json()) as Parameters<typeof buildMoveOp>[0]['previous'][];
  const op = signPlcOp(buildMoveOp({
    previous: log[log.length - 1], rotationKeys: r.rotationKeys, signingDidKey: r.verificationMethods.atproto,
    pdsEndpoint: r.services.atproto_pds.endpoint, handle: r.alsoKnownAs[0].slice('at://'.length),
  }), p.rotationKey);
  const plc = await fetch(`${plcUrl}/${p.did}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(op) });
  if (!plc.ok) throw new MoveError(`The PLC directory refused the update (${plc.status}): ${await plc.text()}`);

  p.onStep('activate');
  const { token } = await call<{ token: string }>(p.oldPdsUrl, 'com.atproto.server.getServiceAuth', {
    jwt: p.ownerAccessJwt, query: { aud: p.target.serviceDid, lxm: 'net.openfederation.community.activate' },
  });
  const activated = await call<{ missingAttestationKeys: number }>(p.target.url, 'net.openfederation.community.activate', { jwt: token, body: { did: p.did } });

  p.onStep('retire');
  await call(p.oldPdsUrl, 'net.openfederation.community.markMoved', { jwt: p.ownerAccessJwt, body: { did: p.did } }).catch(() => undefined);
  return { newPdsUrl: p.target.url, missingAttestationKeys: activated.missingAttestationKeys };
}
