/**
 * Pen names (pseudonyms) in the dashboard, on @open-federation/pseudonym.
 * Their 12 words exist only in this page's memory (or locked with a passkey
 * on this device); servers see did:keys and signatures.
 *
 * Two identities are in play and their credentials never mix:
 * - the person: the dashboard session (auth store, apiClient). Used only to
 *   collect passes and, for a custodial owner, to have this server sign the
 *   owner half of a proof. The signed-out pages (/pen-names) never load it.
 * - the pen name: its own session, kept in this tab's sessionStorage under
 *   its own key. Every pen-name request goes through `penCall` with that
 *   token, or with none; never with the person's.
 * Creating a pen name sends no credentials at all.
 */
import {
  fetchTokenKeys, collectTokens, currentEpoch, importTokenPublicKey, base64UrlDecode, loginWithPhrase,
  generatePseudonymPhrase, derivePseudonymKeys, buildPseudonymGenesisOp, signGenesisOp, didForSignedOp,
  createRevealBundle, publishReveal, signPresence, challengeForWord, checkPresence,
  revealLinkFragment, presenceLinkFragment, moveAccount, signOwnerJwt, tombstone,
  rememberPhraseWithPasskey, unlockPhraseWithPasskey, fetchGenesisOp, didDocKey, verifyRevealBundle,
  type CreationToken, type RememberedPhrase, type RevealBundleV2, type MoveStep, type OwnerSigner,
} from '@open-federation/pseudonym';
import { deriveCustodyKeys, signOwnerRaw } from '@open-federation/sdk/custody';
import { call, MoveError } from '@/lib/move/xrpc';
import { PEN_SESSION_KEY, forgetPenSession } from './pen-session-store';
import { buildPassFile, isExpired, keyFingerprint, passId, type Pass } from './pass-file';
import { checkOwnerKey, isPlcDid, ownerCandidates, OWNER_KEY_PROBLEM, SEALED_TO_KEY, sealNames, sealedOwner } from './own-proof';
import { assertPinnedServiceDid } from './service-pin';
import { IN_PERSON_CONTEXT, withPresenceContext } from '@/lib/verify/presence-context';

export { generatePseudonymPhrase };

/** The context a word is signed in for an in-person proof; its link names it (`c=`) for /verify. */
export const PRESENCE_CONTEXT = IN_PERSON_CONTEXT;

/** A server a pen name can live on: its address and the DID it signs logins for. */
export interface PenHome { url: string; serviceDid: string }

/** A pen name this browser knows about. Never its words. */
export interface PenNameEntry {
  did: string;
  handle: string;
  home: PenHome;
  /** Servers it moved away from, where a switched-off copy may remain. */
  formerHomes?: PenHome[];
  createdAt?: string;
}

export interface PenSession { did: string; handle: string; home: PenHome; accessJwt: string; refreshJwt: string }

const trim = (u: string) => u.replace(/\/+$/, '');

// ---------------------------------------------------------------- storage ----

/**
 * Which list a pen name is kept in: the person's DID on the account page, or
 * SIGNED_OUT_SCOPE on the signed-out pages, which know no account.
 */
const LIST_KEY = (scope: string) => `of.penNames.list.${scope}`;
export const SIGNED_OUT_SCOPE = 'signed-out';
const PASSES_KEY = (ownerDid: string) => `of.penNames.passes.${ownerDid}`;
const REMEMBERED_KEY = (penDid: string) => `of.penNames.remembered.${penDid}`;
/** Per tab: closing the tab signs the pen name out. Not the person's session key. */
const SESSION_KEY = PEN_SESSION_KEY;

function read<T>(storage: () => Storage, key: string): T | null {
  try { const raw = storage().getItem(key); return raw ? JSON.parse(raw) as T : null; } catch { return null; }
}
function write(storage: () => Storage, key: string, value: unknown): void {
  try { storage().setItem(key, JSON.stringify(value)); } catch { /* storage unavailable: works for this page only */ }
}
function remove(storage: () => Storage, key: string): void {
  try { storage().removeItem(key); } catch { /* nothing to remove */ }
}
const local = () => localStorage;
const tab = () => sessionStorage;

export function loadPenNames(scope: string): PenNameEntry[] {
  return read<PenNameEntry[]>(local, LIST_KEY(scope)) ?? [];
}
export function savePenName(scope: string, entry: PenNameEntry): PenNameEntry[] {
  const list = loadPenNames(scope).filter((e) => e.did !== entry.did);
  const next = [...list, entry];
  write(local, LIST_KEY(scope), next);
  return next;
}
export function forgetPenName(scope: string, did: string): PenNameEntry[] {
  const next = loadPenNames(scope).filter((e) => e.did !== did);
  write(local, LIST_KEY(scope), next);
  forgetPenPasskey(did);
  remove(tab, SEALED_TO_KEY(did));
  const s = loadPenSession();
  if (s?.did === did) forgetPenSession();
  return next;
}

export function loadPenPasskey(penDid: string): RememberedPhrase | null {
  return read<RememberedPhrase>(local, REMEMBERED_KEY(penDid));
}
export function forgetPenPasskey(penDid: string): void {
  remove(local, REMEMBERED_KEY(penDid));
}

export function loadPenSession(): PenSession | null {
  return read<PenSession>(tab, SESSION_KEY);
}
export function savePenSession(s: PenSession): void {
  write(tab, SESSION_KEY, s);
}
export { forgetPenSession };

// ------------------------------------------------------------------ server ----

export interface ServerFacts {
  url: string;
  serviceDid: string;
  /** The endpoint DID documents name for this server. */
  serviceUrl: string;
  handleDomains: string[];
  plcUrl: string;
  pseudonymsEnabled: boolean;
}

/**
 * What a pen name needs to know about a server. The address is the one this
 * dashboard was built for (or the one the person typed), so the service DID
 * read from it is the one the login is signed for.
 */
export async function serverFacts(rawUrl: string): Promise<ServerFacts> {
  const url = trim(rawUrl);
  const described = await call<{ did: string; availableUserDomains?: string[] }>(url, 'com.atproto.server.describeServer');
  const config = await call<{ serviceUrl?: string; plcDirectoryUrl?: string; identity?: { pseudonymsEnabled?: boolean } }>(
    url, 'net.openfederation.server.getPublicConfig');
  if (!config.plcDirectoryUrl) throw new MoveError('This server does not say which public directory it uses');
  assertPinnedServiceDid(url, described.did);
  return {
    url, serviceDid: described.did, serviceUrl: config.serviceUrl ?? url,
    handleDomains: described.availableUserDomains ?? [], plcUrl: trim(config.plcDirectoryUrl),
    pseudonymsEnabled: config.identity?.pseudonymsEnabled !== false,
  };
}

// ------------------------------------------------------------------ passes ----

/**
 * Passes are collected automatically, as a fixed batch: the first time each
 * month the person is signed in to the dashboard, it collects the full batch
 * the server hands out, whether or not any were used. Every account does the
 * same, so collecting says nothing. (Never a top-up of "the number used":
 * that would tell the server how many pen names a person made, and when.)
 * There is nothing to delete on the server: passes expire with the monthly
 * key rotation, and expired ones are dropped here without a word.
 */
interface StoredPasses { tokens: Pass[] }
interface CollectMark {
  /** The month whose batch is settled for this account in this browser. */
  epoch: string;
  /** 'here': collected by this browser; 'elsewhere': the server says another browser or app collected it. */
  where: 'here' | 'elsewhere';
  at: string;
  count?: number;
}
interface CollectFailure { epoch: string; at: string; message: string }

const MARK_KEY = (ownerDid: string) => `of.penNames.collected.${ownerDid}`;
const FAIL_KEY = (ownerDid: string) => `of.penNames.collectFailed.${ownerDid}`;
/** After a failed attempt, wait this long before the next automatic one (each attempt counts against the server's limits). */
const RETRY_AFTER_MS = 60 * 60 * 1000;

/** Passes that can still be spent here. Expired ones are dropped from storage as a side effect. */
export function loadPasses(ownerDid: string): Pass[] {
  const all = read<StoredPasses>(local, PASSES_KEY(ownerDid))?.tokens ?? [];
  const live = all.filter((t) => !isExpired(t));
  if (live.length !== all.length) write(local, PASSES_KEY(ownerDid), { tokens: live });
  return live;
}
function savePasses(ownerDid: string, tokens: Pass[]): void {
  write(local, PASSES_KEY(ownerDid), { tokens });
}
/** Remove passes from this browser (after they were saved to a file or printed), by their ids. */
export function removePasses(ownerDid: string, ids: string[]): Pass[] {
  const drop = new Set(ids);
  const next = loadPasses(ownerDid).filter((t) => !drop.has(passId(t)));
  savePasses(ownerDid, next);
  announcePasses();
  return next;
}

export interface PassesStatus {
  passes: Pass[];
  /** This month's batch: collected here, collected elsewhere, or not yet. */
  thisMonth: 'here' | 'elsewhere' | 'not-yet';
  collectedAt: string | null;
  lastFailure: CollectFailure | null;
}

export function passesStatus(ownerDid: string): PassesStatus {
  const mark = read<CollectMark>(local, MARK_KEY(ownerDid));
  const fail = read<CollectFailure>(local, FAIL_KEY(ownerDid));
  const epoch = currentEpoch();
  const settled = mark?.epoch === epoch ? mark : null;
  const passes = loadPasses(ownerDid);
  // Passes collected before collection was automatic carry no mark.
  const collectedBefore = !settled && passes.some((t) => t.epoch === epoch);
  return {
    passes,
    thisMonth: settled ? settled.where : collectedBefore ? 'here' : 'not-yet',
    collectedAt: settled?.at ?? null,
    lastFailure: fail?.epoch === epoch ? fail : null,
  };
}

/** Screens listening for pass changes (collection runs in the background, from any dashboard page). */
export const PASSES_CHANGED = 'of-pen-passes-changed';
function announcePasses(): void {
  try { window.dispatchEvent(new Event(PASSES_CHANGED)); } catch { /* no window */ }
}

/** How many passes the server hands out per month, until it says otherwise (PSEUDONYM_TOKENS_PER_EPOCH). */
export const PASSES_PER_MONTH_DEFAULT = 20;

let collecting: Promise<PassesStatus> | null = null;

/**
 * Collect this month's full batch if this browser has not settled it yet.
 * Safe to call on every page: it does nothing once the month is settled,
 * waits an hour after a failure (unless `force`), and runs once at a time
 * across tabs. The blinding and unblinding happen here; the server signs
 * passes it cannot see.
 */
export function autoCollectPasses(p: { pdsUrl: string; ownerDid: string; ownerAccessJwt: string; force?: boolean }): Promise<PassesStatus> {
  collecting ??= withCollectLock(() => collectOnce(p)).finally(() => { collecting = null; });
  return collecting;
}

function withCollectLock<T>(fn: () => Promise<T>): Promise<T> {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  return locks ? (locks.request('of-pen-collect', fn) as Promise<T>) : fn();
}

async function collectOnce(p: { pdsUrl: string; ownerDid: string; ownerAccessJwt: string; force?: boolean }): Promise<PassesStatus> {
  const epoch = currentEpoch();
  const before = passesStatus(p.ownerDid);
  if (before.thisMonth !== 'not-yet') return before;
  if (!p.force && before.lastFailure && Date.now() - Date.parse(before.lastFailure.at) < RETRY_AFTER_MS) return before;
  const lastCount = read<CollectMark>(local, MARK_KEY(p.ownerDid))?.count;
  try {
    const { tokens, key } = await collectBatch({ ...p, count: lastCount ?? PASSES_PER_MONTH_DEFAULT });
    savePasses(p.ownerDid, [...loadPasses(p.ownerDid), ...tokens.map((t) => ({ ...t, ...(key ? { key } : {}) }))]);
    write(local, MARK_KEY(p.ownerDid), { epoch, where: 'here', at: new Date().toISOString(), count: tokens.length } satisfies CollectMark);
    remove(local, FAIL_KEY(p.ownerDid));
  } catch (e) {
    if ((e as MoveError).code === 'AlreadyCollected') {
      write(local, MARK_KEY(p.ownerDid), { epoch, where: 'elsewhere', at: new Date().toISOString(), ...(lastCount ? { count: lastCount } : {}) } satisfies CollectMark);
      remove(local, FAIL_KEY(p.ownerDid));
    } else {
      write(local, FAIL_KEY(p.ownerDid), { epoch, at: new Date().toISOString(), message: (e as Error).message } satisfies CollectFailure);
    }
  }
  announcePasses();
  return passesStatus(p.ownerDid);
}

async function collectBatch(p: { pdsUrl: string; ownerAccessJwt: string; count: number }): Promise<{ tokens: CreationToken[]; key: string }> {
  // The month keys are fetched without credentials, as everyone sees them.
  const keys = await fetchTokenKeys(p.pdsUrl).catch(() => { throw new MoveError('Could not reach this server for its pass key. Passes will be collected later.'); });
  const published = keys.find((k) => k.epoch === currentEpoch());
  const key = published ? keyFingerprint(published.publicKey) : '';
  try {
    try {
      return { tokens: await collectTokens({ pdsUrl: p.pdsUrl, accessJwt: p.ownerAccessJwt, keys, count: p.count }), key };
    } catch (e) {
      // The server sets the batch size and says so when the count is wrong; every account gets the same full batch.
      const want = /must be (\d+) base64url/.exec((e as Error).message);
      if (!want || Number(want[1]) === p.count) throw e;
      return { tokens: await collectTokens({ pdsUrl: p.pdsUrl, accessJwt: p.ownerAccessJwt, keys, count: Number(want[1]) }), key };
    }
  } catch (e) {
    const msg = (e as Error).message;
    if (/AlreadyCollected|already collected/.test(msg)) throw new MoveError('This month’s passes were already collected for your account, in another browser or app. They are kept there; save them to a file there to use them elsewhere. New passes come next month.', 'AlreadyCollected');
    if (/KeyMismatch/.test(msg)) throw new MoveError('The passes did not match this server’s published key, so they were thrown away. A server that marks passes could follow them; do not create a pen name here until this is explained.', 'KeyMismatch');
    if (/WrongEpoch|No published key/.test(msg)) throw new MoveError('This server has no pass key for this month yet. Passes will be collected later.');
    if (/Only local accounts/.test(msg)) throw new MoveError('Only accounts made on this server can collect passes here.', 'Forbidden');
    throw new MoveError(msg);
  }
}

/**
 * Check loaded passes against this server's published month keys, fetched
 * without credentials: a pass signed with a key nobody else sees could mark
 * whoever uses it. Returns the passes that check out.
 */
export async function checkPassesAgainstServer(pdsUrl: string, passes: Pass[]): Promise<{ good: Pass[]; bad: number; retired: number }> {
  const keys = await fetchTokenKeys(pdsUrl);
  const imported = new Map<string, CryptoKey>();
  for (const k of keys) imported.set(k.epoch, await importTokenPublicKey(k.publicKey));
  const good: Pass[] = [];
  let bad = 0;
  let retired = 0;
  for (const t of passes) {
    const key = imported.get(t.epoch);
    if (!key) { retired++; continue; }
    const ok = await crypto.subtle.verify({ name: 'RSA-PSS', saltLength: 48 }, key,
      base64UrlDecode(t.signature) as BufferSource, base64UrlDecode(t.prepared) as BufferSource).catch(() => false);
    if (ok) good.push(t); else bad++;
  }
  return { good, bad, retired };
}

/** The passes as a file to save. */
export function passFileBlob(p: { server: string; owner: string; passes: Pass[] }): Blob {
  return new Blob([JSON.stringify(buildPassFile(p), null, 2)], { type: 'application/json' });
}

// ------------------------------------------------------------------ create ----

export type CreateStep = 'keys' | 'directory' | 'account';
export const CREATE_STEPS: { id: CreateStep; label: string }[] = [
  { id: 'keys', label: 'Make the pen name’s keys from its 12 words (on this device)' },
  { id: 'directory', label: 'Register it in the public directory' },
  { id: 'account', label: 'Open its account on this server with one pass' },
];

/** Whether a handle is already taken on this server. */
export async function handleTaken(pdsUrl: string, handle: string): Promise<boolean> {
  const res = await fetch(`${pdsUrl}/xrpc/com.atproto.identity.resolveHandle?${new URLSearchParams({ handle })}`).catch(() => null);
  return !!res?.ok;
}

/** The pass was refused. `did` is already in the public directory; a retry with another pass reuses it. */
export class PassRefused extends MoveError {
  constructor(message: string, code: string, readonly did: string) { super(message, code); }
}

/**
 * Create a pen name from words the person has already written down, with
 * one pass. Sends no credentials: the server learns only that a valid pass
 * was spent. `ownerDid` is sealed (hidden) into the pen name's public entry
 * so it can later be proven to belong to that account; no request names it.
 * When the pass is refused, throws PassRefused; call again with another pass
 * and `existingDid` to finish the same pen name.
 */
export async function createPenName(p: {
  server: ServerFacts; ownerDid: string; phrase: string; handle: string; pass: Pass; scope: string;
  existingDid?: string; onStep: (s: CreateStep) => void;
}): Promise<PenNameEntry> {
  let did = p.existingDid;
  if (!did) {
    p.onStep('keys');
    const keys = derivePseudonymKeys(p.phrase);
    const { signingKey } = await call<{ signingKey: string }>(p.server.url, 'com.atproto.server.reserveSigningKey', { body: {} });
    const signed = signGenesisOp(buildPseudonymGenesisOp({
      ownerDidKey: keys.ownerDidKey, signingDidKey: signingKey, handle: p.handle,
      pdsEndpoint: p.server.serviceUrl, ownerDid: p.ownerDid, commitmentSaltHex: keys.commitmentSaltHex,
    }), keys.ownerPrivateKey);
    did = didForSignedOp(signed);

    p.onStep('directory');
    const plc = await fetch(`${p.server.plcUrl}/${did}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(signed) })
      .catch(() => { throw new MoveError('Could not reach the public directory. Nothing was created.'); });
    if (!plc.ok) throw new MoveError(`The public directory refused the new pen name (${plc.status}). Nothing was created.`);
  }

  p.onStep('account');
  let created: { did: string; handle: string };
  const token: CreationToken = { epoch: p.pass.epoch, prepared: p.pass.prepared, signature: p.pass.signature };
  try {
    created = await call<{ did: string; handle: string }>(p.server.url, 'net.openfederation.pseudonym.createAccount', { body: { did, token } });
  } catch (e) {
    const code = (e as MoveError).code;
    if (code === 'TokenSpent') throw new PassRefused('This pass was already used.', code, did);
    if (code === 'InvalidToken') throw new PassRefused('This server did not accept this pass (it may have expired).', code, did);
    throw e;
  }
  if (created.did !== did) throw new MoveError(`The server opened ${created.did}, not ${did}`);
  const entry: PenNameEntry = { did, handle: created.handle, home: { url: p.server.url, serviceDid: p.server.serviceDid }, createdAt: new Date().toISOString() };
  savePenName(p.scope, entry);
  // This tab only, for the proof that names the account: closing the tab forgets it.
  write(tab, SEALED_TO_KEY(did), p.ownerDid);
  return entry;
}

// ----------------------------------------------------------------- session ----

/**
 * The handle as the server gave it. Servers return it in full (#411), so this
 * asks nothing; an older server answers with the name only, completed here
 * with its handle domain.
 */
async function fullHandle(home: string, handle: string): Promise<string> {
  if (handle.includes('.')) return handle;
  const described = await call<{ availableUserDomains?: string[] }>(home, 'com.atproto.server.describeServer').catch(() => null);
  const domain = described?.availableUserDomains?.[0];
  return domain ? `${handle}${domain}` : handle;
}

/** Sign in as a pen name with its words. The login is signed for `home.serviceDid` only. */
export async function signInPenName(home: PenHome, phrase: string): Promise<PenSession> {
  // A home saved before the DID was pinned (or with another one) signs nothing for this address.
  assertPinnedServiceDid(home.url, home.serviceDid);
  try {
    const s = await loginWithPhrase({ pdsUrl: home.url, phrase, expectedServiceDid: home.serviceDid });
    const handle = await fullHandle(home.url, s.handle);
    const session = { did: s.did, handle, home, accessJwt: s.accessJwt, refreshJwt: s.refreshJwt };
    savePenSession(session);
    return session;
  } catch (e) {
    const msg = (e as Error).message;
    if (/InvalidPhrase/.test(msg)) throw new MoveError('These are not 12 valid words. Check the spelling and order.');
    if (/Unauthorized/.test(msg)) throw new MoveError('No pen name on this server signs in with these words.');
    if (/AccountNotActive/.test(msg)) throw new MoveError('This pen name is switched off on this server (it moved, or was ended).');
    if (/refusing to sign/.test(msg)) throw new MoveError('The server asked to sign a login for a different server. Refused.');
    throw new MoveError(msg);
  }
}

/**
 * A request as the pen name, with its own token only. Refreshes the pen
 * name's session once when its access token has expired.
 */
export async function penCall<T>(nsid: string, opts: { body?: unknown; query?: Record<string, string>; raw?: BodyInit; contentType?: string } = {}): Promise<T> {
  const s = loadPenSession();
  if (!s) throw new MoveError('You are not signed in as a pen name in this tab.');
  try {
    return await call<T>(s.home.url, nsid, { ...opts, jwt: s.accessJwt });
  } catch (e) {
    if (!(e instanceof MoveError) || !/^(Unauthorized|ExpiredToken|InvalidToken|AuthRequired|AuthMissing)$/.test(e.code ?? '')) throw e;
    const fresh = await call<{ accessJwt: string; refreshJwt: string }>(s.home.url, 'com.atproto.server.refreshSession', { jwt: s.refreshJwt, body: {} })
      .catch(() => { forgetPenSession(); throw new MoveError('The pen name’s session ended. Sign in as it again.'); });
    savePenSession({ ...s, accessJwt: fresh.accessJwt, refreshJwt: fresh.refreshJwt });
    return call<T>(s.home.url, nsid, { ...opts, jwt: fresh.accessJwt });
  }
}

export async function signOutPenName(): Promise<void> {
  const s = loadPenSession();
  forgetPenSession();
  // The refresh token as the bearer (AT Protocol) and in the body: servers before #412 read only the body.
  if (s) await call(s.home.url, 'com.atproto.server.deleteSession', { jwt: s.refreshJwt, body: { refreshJwt: s.refreshJwt } }).catch(() => undefined);
}

/** Lock the pen name's words on this device with a passkey. The name shown in password managers is neutral. */
export async function rememberPenWithPasskey(penDid: string, phrase: string): Promise<void> {
  const blob = await rememberPhraseWithPasskey({ phrase, rpName: 'OpenFederation', userName: 'Pen name' });
  write(local, REMEMBERED_KEY(penDid), blob);
}

export async function unlockPenWithPasskey(penDid: string): Promise<string> {
  const stored = loadPenPasskey(penDid);
  if (!stored) throw new MoveError('No passkey is set up for this pen name on this device.');
  return unlockPhraseWithPasskey(stored);
}

/** Throws unless these words control this pen name now. */
export async function assertPenWords(plcUrl: string, did: string, phrase: string): Promise<void> {
  let ownerDidKey: string;
  try { ownerDidKey = derivePseudonymKeys(phrase).ownerDidKey; } catch { throw new MoveError('These are not 12 valid words. Check the spelling and order.'); }
  const res = await fetch(`${plcUrl}/${did}/data`).catch(() => null);
  if (!res?.ok) throw new MoveError('Could not read the pen name from the public directory.');
  const data = await res.json() as { rotationKeys?: string[] };
  if (!data.rotationKeys?.includes(ownerDidKey)) throw new MoveError('These 12 words do not belong to this pen name.');
}

// ----------------------------------------------------------------- publish ----

export async function sha256Hex(text: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** An authorship claim: the fingerprint of a text, with its title and link. The text itself stays here. */
export async function publishClaim(p: { title: string; url?: string; text: string }): Promise<{ uri: string; contentHash: string }> {
  const s = loadPenSession();
  if (!s) throw new MoveError('Sign in as the pen name first.');
  const contentHash = await sha256Hex(p.text);
  const now = new Date().toISOString();
  const out = await penCall<{ uri: string }>('com.atproto.repo.createRecord', {
    body: {
      repo: s.did, collection: 'net.openfederation.authorship.claim',
      record: {
        $type: 'net.openfederation.authorship.claim', contentHash,
        ...(p.title ? { title: p.title } : {}), ...(p.url ? { url: p.url } : {}), publishedAt: now, createdAt: now,
      },
    },
  });
  return { uri: out.uri, contentHash };
}

export interface RepoFile { collection: string; rkey: string; value: Record<string, unknown> }

/** Every record in an account's repository, read as anyone can (no credentials). */
export async function listFiles(home: string, did: string): Promise<RepoFile[]> {
  const { collections } = await call<{ collections: string[] }>(home, 'com.atproto.repo.describeRepo', { query: { repo: did } });
  const files: RepoFile[] = [];
  for (const collection of collections) {
    let cursor: string | undefined;
    do {
      const page = await call<{ records: { uri: string; value: Record<string, unknown> }[]; cursor?: string }>(home, 'com.atproto.repo.listRecords', {
        query: { repo: did, collection, limit: '100', ...(cursor ? { cursor } : {}) },
      });
      for (const r of page.records) files.push({ collection, rkey: r.uri.split('/').pop() ?? '', value: r.value });
      cursor = page.records.length ? page.cursor : undefined;
    } while (cursor);
  }
  return files;
}

/** The whole repository as one signed file (CAR), as anyone can download it. */
export async function downloadBackup(home: string, did: string): Promise<Blob> {
  const res = await fetch(`${home}/xrpc/com.atproto.sync.getRepo?${new URLSearchParams({ did })}`).catch(() => null);
  if (!res?.ok) throw new MoveError('The server did not hand out the backup.');
  return new Blob([await res.arrayBuffer()], { type: 'application/vnd.ipld.car' });
}

// ------------------------------------------------------------------- prove ----

/**
 * Who signs the person's half of a proof: their own key (assisted or self,
 * from their identity words) or this server, with the key it holds (custodial).
 */
export function ownerSignerFromWords(identityPhrase: string): OwnerSigner {
  const keys = deriveCustodyKeys(identityPhrase);
  return async (statement) => ({ signingKey: keys.ownerDidKey, signature: signOwnerRaw(keys.ownerPrivateKey, statement) });
}

export async function makeProof(p: {
  ownerPdsUrl: string; plcUrl: string; penPhrase: string; penDid: string; ownerDid: string; ownerAccessJwt: string; ownerSigner?: OwnerSigner;
}): Promise<RevealBundleV2> {
  try {
    return await createRevealBundle({
      pdsUrl: p.ownerPdsUrl, plcUrl: p.plcUrl, phrase: p.penPhrase, pseudonymDid: p.penDid,
      ownerDid: p.ownerDid, ownerAccessJwt: p.ownerAccessJwt, ...(p.ownerSigner ? { ownerSigner: p.ownerSigner } : {}),
    });
  } catch (e) {
    const msg = (e as Error).message;
    if (/signLink failed/.test(msg)) throw new MoveError(`This server would not sign your half of the proof (${msg.replace(/^.*signLink failed /, '')}).`);
    throw new MoveError(msg);
  }
}

// The same proof on the signed-out pages, for an owner who holds their own
// keys (Assisted or Self): their 12 words sign their half on this device, so
// no session of their account is needed or sent. Only the public directory is
// read (lib/pen-names/own-proof.ts has the checks).

/** The pen name's first public entry, and the opener of its sealed note (from its own 12 words). */
async function penSeal(plcUrl: string, penDid: string, penPhrase: string): Promise<{ names: string[]; opener: string }> {
  const opener = derivePseudonymKeys(penPhrase).commitmentSaltHex;
  const genesis = await fetchGenesisOp(penDid, { plcUrl }).catch(() => null);
  if (!genesis) throw new MoveError('Could not read the pen name from the public directory.');
  return { names: (genesis as { alsoKnownAs?: string[] }).alsoKnownAs ?? [], opener };
}

/** The account this browser knows that the pen name is sealed to, or null. Reads storage and the directory only. */
export async function suggestOwner(plcUrl: string, penDid: string, penPhrase: string): Promise<string | null> {
  const safe = (s: () => Storage) => { try { return s(); } catch { return null; } };
  const candidates = ownerCandidates(penDid, safe(tab), safe(local));
  if (!candidates.length) return null;
  const seal = await penSeal(plcUrl, penDid, penPhrase).catch(() => null);
  return seal ? sealedOwner(candidates, seal.names, seal.opener) : null;
}

/** The owner key an account publishes in the public directory, or null. */
async function publishedOwnerKey(plcUrl: string, ownerDid: string): Promise<string | null> {
  const res = await fetch(`${plcUrl}/${ownerDid}`, { headers: { Accept: 'application/json' } }).catch(() => null);
  if (res?.status === 404) throw new MoveError('There is no account with this DID in the public directory.');
  if (!res?.ok) throw new MoveError('Could not read your account from the public directory.');
  return didDocKey(await res.json() as Record<string, unknown>, 'openfederation_owner');
}

/**
 * Throws, in plain words, unless the pen name is sealed to `ownerDid` and
 * that account publishes a key of its own (Assisted or Self).
 */
export async function checkOwnAccount(p: { plcUrl: string; penDid: string; penPhrase: string; ownerDid: string }): Promise<void> {
  const ownerDid = p.ownerDid.trim();
  if (!isPlcDid(ownerDid)) throw new MoveError('That is not an account’s DID. It starts with did:plc: and is 32 characters long; it is on your account page and in your pass file.');
  const { names, opener } = await penSeal(p.plcUrl, p.penDid, p.penPhrase);
  if (!sealNames(names, ownerDid, opener)) throw new MoveError('The sealed note in the pen name’s public entry does not name this account. Check the DID: it must be the account whose passes made this pen name.');
  if (!await publishedOwnerKey(p.plcUrl, ownerDid)) throw new MoveError(OWNER_KEY_PROBLEM['no-owner-key']);
}

/** Throws, in plain words, unless these words hold the key `ownerDid` publishes. */
export async function assertOwnWords(plcUrl: string, ownerDid: string, identityPhrase: string): Promise<void> {
  let derived: string;
  try { derived = deriveCustodyKeys(identityPhrase).ownerDidKey; } catch { throw new MoveError('These are not 12 valid words. Check the spelling and order.'); }
  const check = checkOwnerKey(await publishedOwnerKey(plcUrl, ownerDid.trim()), derived);
  if (check !== 'ok') throw new MoveError(OWNER_KEY_PROBLEM[check]);
}

/**
 * Make the proof with the person's own 12 words, checked again first, then
 * check the result as /verify will. No request carries any credentials.
 */
export async function makeOwnProof(p: { plcUrl: string; penPhrase: string; penDid: string; ownerDid: string; identityPhrase: string }): Promise<RevealBundleV2> {
  const ownerDid = p.ownerDid.trim();
  await checkOwnAccount({ ...p, ownerDid });
  await assertOwnWords(p.plcUrl, ownerDid, p.identityPhrase);
  let bundle: RevealBundleV2;
  try {
    // With ownerSigner the owner's server is never asked: no address, no token.
    bundle = await createRevealBundle({
      pdsUrl: '', ownerAccessJwt: '', plcUrl: p.plcUrl, phrase: p.penPhrase, pseudonymDid: p.penDid,
      ownerDid, ownerSigner: ownerSignerFromWords(p.identityPhrase),
    });
  } catch (e) { throw new MoveError((e as Error).message); }
  const verdict = await verifyRevealBundle(bundle, { online: true, plcUrl: p.plcUrl });
  if (!verdict.valid || verdict.ownerAttestation !== 'person') {
    const failed = verdict.checks.filter((c) => !c.ok).map((c) => c.detail ?? c.name).join('; ');
    throw new MoveError(`The proof did not check out against the public directory, so it is not shown (${failed || 'not signed by the person'}).`);
  }
  return bundle;
}

export function proofLink(origin: string, bundle: RevealBundleV2): string {
  return `${origin}/verify#${revealLinkFragment(bundle)}`;
}

/**
 * The record publishReveal writes, for a pen name on another server than the
 * account (@open-federation/pseudonym 0.3.1 writes both halves at one server;
 * from 0.4, `publishReveal({ pseudonymPdsUrl })` and `revealLinkRecord` do this).
 */
export function proofRecord(b: RevealBundleV2, createdAt: string = new Date().toISOString()): Record<string, unknown> {
  return {
    $type: 'net.openfederation.pseudonym.link',
    statement: b.statement, pseudonymSig: b.pseudonym.sig,
    ownerSig: b.owner.signature.format === 'raw' ? b.owner.signature.sig : b.owner.signature.signature,
    ownerSigningKey: b.owner.signingKey, commitmentSalt: b.commitmentSalt,
    genesisOp: b.pseudonym.genesisOp, createdAt,
    ownerKeyRef: b.owner.keyRef, ownerSignature: b.owner.signature,
  };
}

/**
 * Put the proof in both accounts' files, for anyone to read: the same record
 * in each, written at each account's own server with its own token only. The
 * pen name may live on another server than the account.
 */
export async function publishProof(p: { ownerPdsUrl: string; bundle: RevealBundleV2; ownerAccessJwt: string }): Promise<void> {
  const s = loadPenSession();
  if (!s) throw new MoveError('Sign in as the pen name first.');
  if (s.did !== p.bundle.pseudonym.did) throw new MoveError('You are signed in as another pen name in this tab.');
  if (trim(s.home.url) === trim(p.ownerPdsUrl)) {
    await publishReveal({ pdsUrl: p.ownerPdsUrl, bundle: p.bundle, pseudonymAccessJwt: s.accessJwt, ownerAccessJwt: p.ownerAccessJwt });
    return;
  }
  const record = proofRecord(p.bundle);
  const collection = 'net.openfederation.pseudonym.link';
  await penCall('com.atproto.repo.createRecord', { body: { repo: s.did, collection, record } });
  await call(p.ownerPdsUrl, 'com.atproto.repo.createRecord', { jwt: p.ownerAccessJwt, body: { repo: p.bundle.owner.did, collection, record } })
    .catch((e: Error) => { throw new MoveError(`The proof is in ${s.handle}'s files, but your server did not add it to yours (${e.message}). Publish again to add it there.`); });
}

/** An in-person proof: the pen name's words sign a word someone says. */
export async function inPersonProof(p: { origin: string; plcUrl: string; penPhrase: string; penDid: string; word: string }): Promise<{ link: string; valid: boolean }> {
  const challenge = challengeForWord(p.word, PRESENCE_CONTEXT);
  const { signature } = signPresence({ phrase: p.penPhrase, pseudonymDid: p.penDid, challenge });
  const checked = await checkPresence({ plcUrl: p.plcUrl, pseudonymDid: p.penDid, challenge, signature });
  const fragment = withPresenceContext(presenceLinkFragment({ pseudonymDid: p.penDid, word: p.word, signature }), PRESENCE_CONTEXT);
  return { link: `${p.origin}/verify#${fragment}`, valid: checked.valid };
}

// -------------------------------------------------------------------- move ----

export const PEN_MOVE_STEPS: { id: MoveStep; label: string }[] = [
  { id: 'open', label: 'Open the pen name at the new server (switched off)' },
  { id: 'export', label: 'Copy its files from here' },
  { id: 'import', label: 'Put them in at the new server' },
  { id: 'blobs', label: 'Copy pictures and attachments' },
  { id: 'check', label: 'Check the new server has everything' },
  { id: 'point', label: 'Point the pen name at the new server (cannot be undone from here)' },
  { id: 'activate', label: 'Switch it on there and sign in' },
  { id: 'retire', label: 'Switch off the old copy' },
];

export async function movePenName(p: {
  scope: string; entry: PenNameEntry; phrase: string; plcUrl: string; target: PenHome; newHandle: string; onStep: (s: MoveStep) => void;
}): Promise<PenNameEntry> {
  const session = await moveAccount({
    oldPdsUrl: p.entry.home.url, oldServiceDid: p.entry.home.serviceDid,
    newPdsUrl: p.target.url, newServiceDid: p.target.serviceDid,
    plcUrl: p.plcUrl, phrase: p.phrase, did: p.entry.did, newHandle: p.newHandle,
    onStep: (s) => p.onStep(s),
  });
  const handle = await fullHandle(p.target.url, session.handle);
  const entry: PenNameEntry = {
    ...p.entry, handle, home: p.target,
    formerHomes: [...(p.entry.formerHomes ?? []).filter((h) => trim(h.url) !== trim(p.target.url)), p.entry.home],
  };
  savePenName(p.scope, entry);
  savePenSession({ did: session.did, handle, home: p.target, accessJwt: session.accessJwt, refreshJwt: session.refreshJwt });
  return entry;
}

// --------------------------------------------------------------------- end ----

export type EndStep = 'check' | 'delete' | 'former' | 'tombstone';
export const END_STEPS: { id: EndStep; label: string }[] = [
  { id: 'check', label: 'Check the 12 words control this pen name' },
  { id: 'delete', label: 'Delete its account and files on its server' },
  { id: 'former', label: 'Delete copies left on servers it moved away from' },
  { id: 'tombstone', label: 'Retire it for good in the public directory' },
];

async function deleteAt(home: PenHome, did: string, phrase: string): Promise<void> {
  const jwt = signOwnerJwt({ phrase, did, aud: home.serviceDid, lxm: 'com.atproto.server.deleteAccount' });
  await call(home.url, 'com.atproto.server.deleteAccount', { jwt, body: { did } });
}

/**
 * End a pen name: delete its accounts (the servers check the owner key
 * against the directory, so this comes first), then tombstone its DID with
 * its words. Copies on former servers are deleted where they still exist.
 */
export async function endPenName(p: { scope: string; entry: PenNameEntry; phrase: string; plcUrl: string; onStep: (s: EndStep) => void }): Promise<{ leftovers: string[] }> {
  p.onStep('check');
  await assertPenWords(p.plcUrl, p.entry.did, p.phrase);
  p.onStep('delete');
  await deleteAt(p.entry.home, p.entry.did, p.phrase);
  p.onStep('former');
  const leftovers: string[] = [];
  for (const h of p.entry.formerHomes ?? []) {
    try { await deleteAt(h, p.entry.did, p.phrase); } catch (e) {
      // Already gone there (cleaned up, or deleted earlier): the server no longer knows the DID and asks for a password instead.
      if ((e as MoveError).code !== 'InvalidRequest') leftovers.push(h.url);
    }
  }
  p.onStep('tombstone');
  await tombstone({ plcUrl: p.plcUrl, did: p.entry.did, phrase: p.phrase });
  forgetPenName(p.scope, p.entry.did);
  return { leftovers };
}
