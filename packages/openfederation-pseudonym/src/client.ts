// packages/openfederation-pseudonym/src/client.ts
import { generatePseudonymPhrase, derivePseudonymKeys, signText } from './keys.js';
import { buildPseudonymGenesisOp, signGenesisOp, didForSignedOp, type SignedPlcGenesisOp } from './plc.js';
import { buildLinkStatement, buildLoginMessage, buildPresenceMessage, currentEpoch } from './formats.js';
import { importTokenPublicKey, blindTokens, finalizeTokens, type CreationToken } from './tokens.js';

export interface RevealBundle {
  version: 1;
  statement: string;
  pseudonym: { did: string; sig: string; genesisOp: SignedPlcGenesisOp };
  owner: { did: string; sig: string; signingKey: string };
  commitmentSalt: string;
}

async function xrpc<T>(pdsUrl: string, nsid: string, body?: unknown, jwt?: string): Promise<T> {
  const res = await fetch(`${pdsUrl}/xrpc/${nsid}`, body === undefined
    ? { headers: jwt ? { Authorization: `Bearer ${jwt}` } : {} }
    : { method: 'POST', headers: { 'Content-Type': 'application/json', ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}) }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({})) as { error?: string; message?: string };
  if (!res.ok) throw new Error(`${nsid} failed (${res.status}): ${json.error ?? ''} ${json.message ?? ''}`.trim());
  return json as T;
}

/** Fetch epoch keys. Call WITHOUT credentials (ideally over Tor) so the keys are the ones everyone sees. */
export async function fetchTokenKeys(pdsUrl: string): Promise<{ epoch: string; publicKey: string }[]> {
  return (await xrpc<{ keys: { epoch: string; publicKey: string }[] }>(pdsUrl, 'net.openfederation.pseudonym.getTokenKeys')).keys;
}

/** Collect this epoch's batch. Apps call this on a fixed schedule whether or not tokens are needed. */
export async function collectTokens(p: { pdsUrl: string; accessJwt: string; keys: { epoch: string; publicKey: string }[]; count: number }): Promise<CreationToken[]> {
  const epoch = currentEpoch();
  const key = p.keys.find((k) => k.epoch === epoch);
  if (!key) throw new Error('No published key for the current epoch');
  const pub = await importTokenPublicKey(key.publicKey);
  const pending = await blindTokens(pub, epoch, p.count);
  const res = await xrpc<{ blindSignatures: string[] }>(p.pdsUrl, 'net.openfederation.pseudonym.collectTokens',
    { epoch, blindedMessages: pending.blinded }, p.accessJwt);
  return finalizeTokens(pub, pending, res.blindSignatures);
}

/** Create a pseudonym. Call WITHOUT the owner's credentials. The phrase is returned once and never stored. */
export async function createPseudonym(p: { pdsUrl: string; plcUrl: string; pdsServiceUrl: string; handle: string; ownerDid: string; token: CreationToken }): Promise<{ phrase: string; did: string; handle: string }> {
  const phrase = generatePseudonymPhrase();
  const keys = derivePseudonymKeys(phrase);
  const { signingKey } = await xrpc<{ signingKey: string }>(p.pdsUrl, 'com.atproto.server.reserveSigningKey', {});
  const signed = signGenesisOp(buildPseudonymGenesisOp({
    ownerDidKey: keys.ownerDidKey, signingDidKey: signingKey, handle: p.handle,
    pdsEndpoint: p.pdsServiceUrl, ownerDid: p.ownerDid, commitmentSaltHex: keys.commitmentSaltHex,
  }), keys.ownerPrivateKey);
  const did = didForSignedOp(signed);
  const plcRes = await fetch(`${p.plcUrl}/${did}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(signed) });
  if (!plcRes.ok) throw new Error(`PLC rejected genesis (${plcRes.status}): ${await plcRes.text()}`);
  const created = await xrpc<{ did: string; handle: string }>(p.pdsUrl, 'net.openfederation.pseudonym.createAccount', { did, token: p.token });
  if (created.did !== did) throw new Error(`PDS created ${created.did}, expected ${did}`);
  return { phrase, did: created.did, handle: created.handle };
}

/**
 * Phrase login. `expectedServiceDid` is the DID of the PDS you mean to log in
 * to (e.g. `did:web:pds.example.com`). The login message is signed over the
 * service DID, so the client refuses to sign one naming any other service:
 * otherwise a malicious server could relay another PDS's challenge and log in
 * there as you.
 */
export async function loginWithPhrase(p: { pdsUrl: string; phrase: string; expectedServiceDid: string }): Promise<{ did: string; handle: string; accessJwt: string; refreshJwt: string }> {
  if (!p.expectedServiceDid) throw new Error('expectedServiceDid is required');
  const keys = derivePseudonymKeys(p.phrase);
  const ch = await xrpc<{ challengeId: string; challenge: string; serviceDid: string }>(
    p.pdsUrl, 'net.openfederation.pseudonym.getLoginChallenge', { ownerKey: keys.ownerDidKey });
  if (ch.serviceDid !== p.expectedServiceDid) {
    throw new Error(`Login challenge is for ${ch.serviceDid}, expected ${p.expectedServiceDid}; refusing to sign`);
  }
  const signature = signText(keys.ownerPrivateKey, buildLoginMessage({ serviceDid: ch.serviceDid, challenge: ch.challenge }));
  return xrpc(p.pdsUrl, 'net.openfederation.pseudonym.createSession', { challengeId: ch.challengeId, signature });
}

export async function createRevealBundle(p: { pdsUrl: string; plcUrl: string; phrase: string; pseudonymDid: string; ownerDid: string; ownerAccessJwt: string }): Promise<RevealBundle> {
  const keys = derivePseudonymKeys(p.phrase);
  const logRes = await fetch(`${p.plcUrl}/${p.pseudonymDid}/log`);
  if (!logRes.ok) throw new Error(`PLC log lookup failed (${logRes.status})`);
  const genesisOp = (await logRes.json() as SignedPlcGenesisOp[])[0];
  const statement = buildLinkStatement({ pseudonymDid: p.pseudonymDid, ownerDid: p.ownerDid, issuedAt: new Date().toISOString() });
  const owner = await xrpc<{ ownerDid: string; sig: string; signingKey: string }>(
    p.pdsUrl, 'net.openfederation.pseudonym.signLink', { statement }, p.ownerAccessJwt);
  return {
    version: 1, statement, commitmentSalt: keys.commitmentSaltHex,
    pseudonym: { did: p.pseudonymDid, sig: signText(keys.ownerPrivateKey, statement), genesisOp },
    owner: { did: owner.ownerDid, sig: owner.sig, signingKey: owner.signingKey },
  };
}

export async function publishReveal(p: { pdsUrl: string; bundle: RevealBundle; pseudonymAccessJwt: string; ownerAccessJwt: string }): Promise<void> {
  const record = {
    $type: 'net.openfederation.pseudonym.link',
    statement: p.bundle.statement, pseudonymSig: p.bundle.pseudonym.sig, ownerSig: p.bundle.owner.sig,
    ownerSigningKey: p.bundle.owner.signingKey, commitmentSalt: p.bundle.commitmentSalt,
    genesisOp: p.bundle.pseudonym.genesisOp, createdAt: new Date().toISOString(),
  };
  const targets: [string, string][] = [[p.bundle.pseudonym.did, p.pseudonymAccessJwt], [p.bundle.owner.did, p.ownerAccessJwt]];
  for (const [repo, jwt] of targets) {
    await xrpc(p.pdsUrl, 'com.atproto.repo.createRecord', { repo, collection: 'net.openfederation.pseudonym.link', record }, jwt);
  }
}

export function signPresence(p: { phrase: string; pseudonymDid: string; challenge: string }): { ownerKey: string; signature: string } {
  const keys = derivePseudonymKeys(p.phrase);
  return { ownerKey: keys.ownerDidKey, signature: signText(keys.ownerPrivateKey, buildPresenceMessage({ pseudonymDid: p.pseudonymDid, challenge: p.challenge })) };
}
