/**
 * Moving a pseudonym to another PDS (AT Protocol account migration). The
 * owner key is the pseudonym's only PLC rotation key, so the owner proves
 * control to the new PDS directly; the old PDS does not have to help.
 */
import { utf8ToBytes } from '@noble/hashes/utils';
import { derivePseudonymKeys, signBytes } from './keys.js';
import { base64UrlEncode } from './formats.js';

const CREATE_ACCOUNT = 'com.atproto.server.createAccount';

function b64urlJson(value: unknown): string {
  return base64UrlEncode(utf8ToBytes(JSON.stringify(value)));
}

/**
 * A short-lived ES256K JWT signed by the owner key, in the shape of AT
 * Protocol service auth: iss = the pseudonym DID, aud = the new PDS's service
 * DID, lxm = the method it may be used for.
 */
export function signOwnerJwt(p: { phrase: string; did: string; aud: string; lxm: string; ttlSeconds?: number }): string {
  const keys = derivePseudonymKeys(p.phrase);
  const now = Math.floor(Date.now() / 1000);
  const jti = base64UrlEncode(crypto.getRandomValues(new Uint8Array(16)));
  const header = b64urlJson({ typ: 'JWT', alg: 'ES256K' });
  const payload = b64urlJson({ iss: p.did, aud: p.aud, lxm: p.lxm, iat: now, exp: now + (p.ttlSeconds ?? 120), jti });
  return `${header}.${payload}.${signBytes(keys.ownerPrivateKey, utf8ToBytes(`${header}.${payload}`))}`;
}

async function call<T>(pdsUrl: string, nsid: string, body: unknown, bearer?: string): Promise<T> {
  const res = await fetch(`${pdsUrl}/xrpc/${nsid}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({})) as { error?: string; message?: string };
  if (!res.ok) throw new Error(`${nsid} failed (${res.status}): ${json.error ?? ''} ${json.message ?? ''}`.trim());
  return json as T;
}

/**
 * First step of a move: reserve a signing key at the new PDS and open the
 * pseudonym's account there. The account starts deactivated; nothing changes
 * for readers until the DID is pointed at the new PDS and the account is
 * activated. `newServiceDid` is the DID of the PDS you mean to move to.
 */
export async function openAccountForMove(p: {
  newPdsUrl: string; newServiceDid: string; phrase: string; did: string; handle: string;
}): Promise<{ did: string; handle: string; signingKey: string; accessJwt: string; refreshJwt: string }> {
  const { signingKey } = await call<{ signingKey: string }>(p.newPdsUrl, 'com.atproto.server.reserveSigningKey', { did: p.did });
  const proof = signOwnerJwt({ phrase: p.phrase, did: p.did, aud: p.newServiceDid, lxm: CREATE_ACCOUNT });
  const created = await call<{ did: string; handle: string; accessJwt: string; refreshJwt: string }>(
    p.newPdsUrl, CREATE_ACCOUNT, { did: p.did, handle: p.handle }, proof);
  if (created.did !== p.did) throw new Error(`New PDS opened ${created.did}, expected ${p.did}`);
  return { ...created, signingKey };
}
