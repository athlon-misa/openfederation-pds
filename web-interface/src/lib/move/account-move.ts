/**
 * Move this account to another PDS (#266, #268), in the standard AT Protocol
 * order: the new PDS opens a deactivated copy, the repository and every blob
 * are copied and checked, and only then does this PDS sign (after an emailed
 * code and the password) the PLC update that points the DID at the new home.
 * A failure before that step changes nothing here.
 */
import { MoveError, call, type TargetInfo } from './xrpc';

export const ACCOUNT_STEPS = [
  { id: 'open', label: 'Open the account at the new server' },
  { id: 'copy', label: 'Copy the repository' },
  { id: 'blobs', label: 'Copy files' },
  { id: 'check', label: 'Check the new server has everything' },
  { id: 'sign', label: 'Confirm with the emailed code' },
  { id: 'point', label: 'Point your DID at the new server' },
  { id: 'activate', label: 'Switch on the new account' },
  { id: 'retire', label: 'Switch off the copy here' },
] as const;
export type AccountStep = (typeof ACCOUNT_STEPS)[number]['id'];
/** Steps after which the DID has changed: a failure from here on is not "nothing changed". */
export const ACCOUNT_POINT_OF_NO_RETURN: AccountStep = 'point';

export async function moveAccount(p: {
  oldPdsUrl: string;
  target: TargetInfo;
  did: string;
  identifier: string;
  email: string;
  password: string;
  newHandle: string;
  inviteCode?: string;
  /** Resolves with the code this PDS emailed; the screen asks the user for it. */
  readCode: () => Promise<string>;
  onStep: (s: AccountStep) => void;
}): Promise<{ newPdsUrl: string }> {
  const old = await call<{ accessJwt: string }>(p.oldPdsUrl, 'com.atproto.server.createSession', {
    body: { identifier: p.identifier, password: p.password },
  });

  p.onStep('open');
  const { token } = await call<{ token: string }>(p.oldPdsUrl, 'com.atproto.server.getServiceAuth', {
    jwt: old.accessJwt, query: { aud: p.target.serviceDid, lxm: 'com.atproto.server.createAccount' },
  });
  const opened = await call<{ accessJwt: string }>(p.target.url, 'com.atproto.server.createAccount', {
    jwt: token,
    body: { did: p.did, handle: p.newHandle, email: p.email, password: p.password, ...(p.inviteCode ? { inviteCode: p.inviteCode } : {}) },
  });

  p.onStep('copy');
  const car = await fetch(`${p.oldPdsUrl}/xrpc/com.atproto.sync.getRepo?did=${encodeURIComponent(p.did)}`);
  if (!car.ok) throw new MoveError('This server did not export the repository');
  await call(p.target.url, 'com.atproto.repo.importRepo', {
    jwt: opened.accessJwt, raw: new Uint8Array(await car.arrayBuffer()), contentType: 'application/vnd.ipld.car',
  });

  p.onStep('blobs');
  for (;;) {
    const { blobs } = await call<{ blobs: { cid: string }[] }>(p.target.url, 'com.atproto.repo.listMissingBlobs', {
      jwt: opened.accessJwt, query: { limit: '100' },
    });
    if (blobs.length === 0) break;
    for (const { cid } of blobs) {
      const blob = await fetch(`${p.oldPdsUrl}/xrpc/com.atproto.sync.getBlob?did=${encodeURIComponent(p.did)}&cid=${cid}`);
      if (!blob.ok) throw new MoveError(`This server did not serve file ${cid}`);
      await call(p.target.url, 'com.atproto.repo.uploadBlob', {
        jwt: opened.accessJwt, raw: new Uint8Array(await blob.arrayBuffer()), contentType: blob.headers.get('content-type') ?? 'application/octet-stream',
      });
    }
  }

  p.onStep('check');
  const status = await call<{ repoCommit?: string; indexedRecords: number; expectedBlobs: number; importedBlobs: number }>(
    p.target.url, 'com.atproto.server.checkAccountStatus', { jwt: opened.accessJwt });
  const latest = await call<{ cid: string }>(p.oldPdsUrl, 'com.atproto.sync.getLatestCommit', { query: { did: p.did } });
  if ((status.repoCommit && status.repoCommit !== latest.cid) || status.indexedRecords === 0 || status.importedBlobs !== status.expectedBlobs) {
    throw new MoveError('The new server does not hold exactly what this server serves; your DID was not changed');
  }

  p.onStep('sign');
  const creds = await call<Record<string, unknown>>(p.target.url, 'com.atproto.identity.getRecommendedDidCredentials', { jwt: opened.accessJwt });
  await call(p.oldPdsUrl, 'com.atproto.identity.requestPlcOperationSignature', { jwt: old.accessJwt, body: {} });
  const code = await p.readCode();
  const { operation } = await call<{ operation: unknown }>(p.oldPdsUrl, 'com.atproto.identity.signPlcOperation', {
    jwt: old.accessJwt, body: { token: code, password: p.password, ...creds },
  });

  p.onStep('point');
  await call(p.oldPdsUrl, 'com.atproto.identity.submitPlcOperation', { jwt: old.accessJwt, body: { operation } });

  p.onStep('activate');
  await call(p.target.url, 'com.atproto.server.activateAccount', { jwt: opened.accessJwt, body: {} });

  p.onStep('retire');
  // The move is complete either way; this only switches the old copy off.
  await call(p.oldPdsUrl, 'com.atproto.server.deactivateAccount', { jwt: old.accessJwt, body: {} }).catch(() => undefined);
  return { newPdsUrl: p.target.url };
}
