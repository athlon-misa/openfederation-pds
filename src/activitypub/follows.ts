/**
 * Answering follows of a community's ActivityPub actor (#464).
 *
 * The actor is discovery-only: it never posts, and the PDS keeps no list of
 * followers. Until now its inbox refused every delivery, so a Mastodon user
 * who followed a community saw "Follow requested" forever. A signed Follow of
 * the community is now answered with a signed Accept; everything else is
 * acknowledged and dropped.
 *
 * Sending the Accept means POSTing to an address the follower names, so the
 * Follow must carry a valid HTTP signature from the actor it claims to come
 * from, and every URL the PDS fetches or posts to must be a public https
 * address in production (src/security/outbound-fetch.ts).
 */
import crypto from 'crypto';
import { config } from '../config.js';
import { assertPublicHttpsUrl, OutboundFetchError, readLimitedText } from '../security/outbound-fetch.js';
import { parseSignatureHeader, signedPostHeaders, verifySignedPost, type VerifyFailure } from './http-signature.js';

const AS_CONTEXT = 'https://www.w3.org/ns/activitystreams';
const FETCH_TIMEOUT_MS = 10_000;
const MAX_DOCUMENT_BYTES = 256 * 1024;

/** Destination check: public https only in production; dev and test may use local http servers. */
export async function checkOutboundUrl(url: string): Promise<URL> {
  if (config.env.isProduction) return assertPublicHttpsUrl(url);
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new OutboundFetchError('Outbound URL must use HTTP(S)');
  }
  return parsed;
}

async function fetchActivityJson(url: string): Promise<Record<string, unknown>> {
  const safe = await checkOutboundUrl(url);
  const res = await fetch(safe, {
    headers: { Accept: 'application/activity+json, application/ld+json; profile="https://www.w3.org/ns/activitystreams"' },
    redirect: 'error',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new OutboundFetchError(`Fetching ${safe.host} failed with ${res.status}`);
  const doc = JSON.parse(await readLimitedText(res, MAX_DOCUMENT_BYTES)) as unknown;
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new OutboundFetchError('Not an ActivityPub document');
  return doc as Record<string, unknown>;
}

function idOf(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string') {
    return (value as { id: string }).id;
  }
  return null;
}

function keysOf(actor: Record<string, unknown>): Array<{ id: string; owner: string | null; publicKeyPem: string }> {
  const raw = actor.publicKey;
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return list.flatMap((k) => {
    if (!k || typeof k !== 'object') return [];
    const key = k as { id?: unknown; owner?: unknown; publicKeyPem?: unknown };
    if (typeof key.id !== 'string' || typeof key.publicKeyPem !== 'string') return [];
    return [{ id: key.id, owner: typeof key.owner === 'string' ? key.owner : null, publicKeyPem: key.publicKeyPem }];
  });
}

export interface RemoteActor {
  id: string;
  inbox: string;
  publicKeyPem: string;
}

/**
 * The actor that owns `keyId`. The key is only believed when the owner's own
 * actor document lists it: anyone can publish a key document naming someone
 * else as its owner.
 */
export async function resolveSigner(keyId: string): Promise<RemoteActor> {
  const docUrl = keyId.split('#')[0];
  const doc = await fetchActivityJson(docUrl);
  // Mastodon: keyId is "<actor>#main-key" and the document is the actor
  // itself, believed only when it is the document at its own id. Others
  // publish a separate key document naming its owner, whose own document is
  // then fetched from the owner's id.
  let actor: Record<string, unknown>;
  let ownerId: string;
  if (idOf(doc.id) === docUrl && typeof doc.inbox === 'string') {
    actor = doc;
    ownerId = docUrl;
  } else {
    if (typeof doc.owner !== 'string') throw new OutboundFetchError('The signing key has no owner');
    ownerId = doc.owner;
    actor = await fetchActivityJson(ownerId);
    if (idOf(actor.id) !== ownerId) throw new OutboundFetchError('The key owner\'s document has a different id');
  }
  const key = keysOf(actor).find((k) => k.id === keyId);
  if (!key) throw new OutboundFetchError('The key owner does not list this key');
  if (typeof actor.inbox !== 'string') throw new OutboundFetchError('The key owner has no inbox');
  return { id: ownerId, inbox: actor.inbox, publicKeyPem: key.publicKeyPem };
}

export type InboxOutcome =
  | { status: 202; accept: null }
  | { status: 202; accept: { follower: RemoteActor; activity: Record<string, unknown> } }
  | { status: 400 | 401; error: string; reason?: VerifyFailure | string };

/**
 * Decide what to do with one delivery to a community's inbox. Only a Follow
 * of this actor gets an answer; it must be signed by the actor it names.
 */
export async function handleInboxDelivery(opts: {
  actorId: string;
  path: string;
  headers: Record<string, string | undefined>;
  body: Buffer;
}): Promise<InboxOutcome> {
  let activity: Record<string, unknown>;
  try {
    const parsed = JSON.parse(opts.body.toString('utf-8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    activity = parsed as Record<string, unknown>;
  } catch {
    return { status: 400, error: 'InvalidActivity' };
  }

  // Undo of a follow, deletes, updates, anything else: nothing is stored, so
  // there is nothing to change. Acknowledged so the sender does not retry.
  if (activity.type !== 'Follow' || idOf(activity.object) !== opts.actorId) {
    return { status: 202, accept: null };
  }
  const followerId = idOf(activity.actor);
  const followId = idOf(activity.id);
  if (!followerId || !followId) return { status: 400, error: 'InvalidActivity' };

  const signature = parseSignatureHeader(opts.headers.signature);
  if (!signature) return { status: 401, error: 'SignatureRequired', reason: 'missing_signature' };
  let signer: RemoteActor;
  try {
    signer = await resolveSigner(signature.keyId);
  } catch (err) {
    return { status: 401, error: 'UnknownSigner', reason: err instanceof Error ? err.message : 'unresolvable' };
  }
  const failure = verifySignedPost({
    signature,
    path: opts.path,
    headers: opts.headers,
    body: opts.body,
    publicKeyPem: signer.publicKeyPem,
  });
  if (failure) return { status: 401, error: 'InvalidSignature', reason: failure };
  if (signer.id !== followerId) return { status: 401, error: 'InvalidSignature', reason: 'signer_is_not_the_follower' };

  return {
    status: 202,
    accept: {
      follower: signer,
      activity: { id: followId, type: 'Follow', actor: followerId, object: opts.actorId },
    },
  };
}

/** Send the signed Accept for a verified Follow to the follower's inbox. */
export async function deliverAccept(opts: {
  actorId: string;
  privateKeyPem: string;
  follower: RemoteActor;
  follow: Record<string, unknown>;
}): Promise<number> {
  const body = JSON.stringify({
    '@context': AS_CONTEXT,
    id: `${opts.actorId}#accepts/${crypto.randomUUID()}`,
    type: 'Accept',
    actor: opts.actorId,
    object: opts.follow,
  });
  const inbox = await checkOutboundUrl(opts.follower.inbox);
  const res = await fetch(inbox, {
    method: 'POST',
    headers: signedPostHeaders({ url: inbox.toString(), body, keyId: `${opts.actorId}#main-key`, privateKeyPem: opts.privateKeyPem }),
    body,
    redirect: 'error',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  await res.body?.cancel().catch(() => undefined);
  return res.status;
}
