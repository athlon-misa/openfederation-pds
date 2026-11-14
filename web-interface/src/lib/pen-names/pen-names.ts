/**
 * Pen names (pseudonyms) in the dashboard, on @open-federation/pseudonym.
 * Their 12 words exist only in this page's memory (or locked with a passkey
 * on this device); servers see did:keys and signatures.
 *
 * Two identities are in play and their credentials never mix:
 * - the person: the dashboard session (auth store, apiClient). Used only to
 *   collect passes and, for a custodial owner, to have this server sign the
 *   owner half of a proof.
 * - the pen name: its own session, kept in this tab's sessionStorage under
 *   its own key. Every pen-name request goes through `penCall` with that
 *   token, or with none; never with the person's.
 * Creating a pen name sends no credentials at all.
 */
import {
  fetchTokenKeys, collectTokens, currentEpoch, previousEpoch, loginWithPhrase,
  generatePseudonymPhrase, derivePseudonymKeys, buildPseudonymGenesisOp, signGenesisOp, didForSignedOp,
  createRevealBundle, publishReveal, signPresence, challengeForWord, checkPresence,
  revealLinkFragment, presenceLinkFragment, moveAccount, signOwnerJwt, tombstone,
  rememberPhraseWithPasskey, unlockPhraseWithPasskey,
  type CreationToken, type RememberedPhrase, type RevealBundleV2, type MoveStep, type OwnerSigner,
} from '@open-federation/pseudonym';
import { deriveCustodyKeys, signOwnerRaw } from '@open-federation/sdk/custody';
import { call, MoveError } from '@/lib/move/xrpc';
import { PEN_SESSION_KEY, forgetPenSession } from './pen-session-store';

export { generatePseudonymPhrase };

/** The words a presence proof is signed over; /verify uses the same context. */
export const PRESENCE_CONTEXT = 'OpenNewsrooms stage challenge';

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

const LIST_KEY = (ownerDid: string) => `of.penNames.list.${ownerDid}`;
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

export function loadPenNames(ownerDid: string): PenNameEntry[] {
  return read<PenNameEntry[]>(local, LIST_KEY(ownerDid)) ?? [];
}
export function savePenName(ownerDid: string, entry: PenNameEntry): PenNameEntry[] {
  const list = loadPenNames(ownerDid).filter((e) => e.did !== entry.did);
  const next = [...list, entry];
  write(local, LIST_KEY(ownerDid), next);
  return next;
}
export function forgetPenName(ownerDid: string, did: string): PenNameEntry[] {
  const next = loadPenNames(ownerDid).filter((e) => e.did !== did);
  write(local, LIST_KEY(ownerDid), next);
  forgetPenPasskey(did);
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
  return {
    url, serviceDid: described.did, serviceUrl: config.serviceUrl ?? url,
    handleDomains: described.availableUserDomains ?? [], plcUrl: trim(config.plcDirectoryUrl),
    pseudonymsEnabled: config.identity?.pseudonymsEnabled !== false,
  };
}

// ------------------------------------------------------------------ passes ----

interface StoredPasses { tokens: CreationToken[] }

/** Passes that can still be spent: this month's and last month's. */
export function loadPasses(ownerDid: string): CreationToken[] {
  const epochs = new Set([currentEpoch(), previousEpoch(currentEpoch())]);
  return (read<StoredPasses>(local, PASSES_KEY(ownerDid))?.tokens ?? []).filter((t) => epochs.has(t.epoch));
}
function savePasses(ownerDid: string, tokens: CreationToken[]): void {
  write(local, PASSES_KEY(ownerDid), { tokens });
}
export function hasThisMonthsPasses(ownerDid: string): boolean {
  return loadPasses(ownerDid).some((t) => t.epoch === currentEpoch());
}

/** Collect this month's passes, signed in as the person. The server signs them blind. */
export async function collectPasses(p: { pdsUrl: string; ownerDid: string; ownerAccessJwt: string; count: number }): Promise<number> {
  const keys = await fetchTokenKeys(p.pdsUrl); // no credentials
  let tokens: CreationToken[];
  try {
    try {
      tokens = await collectTokens({ pdsUrl: p.pdsUrl, accessJwt: p.ownerAccessJwt, keys, count: p.count });
    } catch (e) {
      // The server sets how many passes a month (PSEUDONYM_TOKENS_PER_EPOCH) and says so when the count is wrong.
      const want = /must be (\d+) base64url/.exec((e as Error).message);
      if (!want || Number(want[1]) === p.count) throw e;
      tokens = await collectTokens({ pdsUrl: p.pdsUrl, accessJwt: p.ownerAccessJwt, keys, count: Number(want[1]) });
    }
  } catch (e) {
    const msg = (e as Error).message;
    if (/AlreadyCollected/.test(msg)) throw new MoveError('You already collected this month’s passes, maybe in another browser or app. They are kept there. New passes come next month.', 'AlreadyCollected');
    if (/KeyMismatch/.test(msg)) throw new MoveError('The passes did not match this server’s published key, so they were thrown away. A server that marks passes could follow them; do not create a pen name here until this is explained.', 'KeyMismatch');
    if (/WrongEpoch|No published key/.test(msg)) throw new MoveError('This server has no key for this month yet. Try again later.');
    throw new MoveError(msg);
  }
  savePasses(p.ownerDid, [...loadPasses(p.ownerDid), ...tokens]);
  return loadPasses(p.ownerDid).length;
}

/** How many passes the server hands out per month (the server decides; the count must match). */
export const PASSES_PER_MONTH_DEFAULT = 20;

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

/**
 * Create a pen name from words the person has already written down. Sends
 * no credentials: the server learns only that a valid pass was spent.
 */
export async function createPenName(p: {
  server: ServerFacts; ownerDid: string; phrase: string; handle: string; onStep: (s: CreateStep) => void;
}): Promise<PenNameEntry> {
  const tokens = loadPasses(p.ownerDid);
  const token = tokens[0];
  if (!token) throw new MoveError('No passes left. Collect this month’s passes first.');

  p.onStep('keys');
  const keys = derivePseudonymKeys(p.phrase);
  const { signingKey } = await call<{ signingKey: string }>(p.server.url, 'com.atproto.server.reserveSigningKey', { body: {} });
  const signed = signGenesisOp(buildPseudonymGenesisOp({
    ownerDidKey: keys.ownerDidKey, signingDidKey: signingKey, handle: p.handle,
    pdsEndpoint: p.server.serviceUrl, ownerDid: p.ownerDid, commitmentSaltHex: keys.commitmentSaltHex,
  }), keys.ownerPrivateKey);
  const did = didForSignedOp(signed);

  p.onStep('directory');
  const plc = await fetch(`${p.server.plcUrl}/${did}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(signed) })
    .catch(() => { throw new MoveError('Could not reach the public directory. Nothing was created.'); });
  if (!plc.ok) throw new MoveError(`The public directory refused the new pen name (${plc.status}). Nothing was created.`);

  p.onStep('account');
  let created: { did: string; handle: string };
  try {
    created = await call<{ did: string; handle: string }>(p.server.url, 'net.openfederation.pseudonym.createAccount', { body: { did, token } });
  } catch (e) {
    const code = (e as MoveError).code;
    if (code === 'TokenSpent' || code === 'InvalidToken') savePasses(p.ownerDid, tokens.slice(1));
    throw e;
  }
  if (created.did !== did) throw new MoveError(`The server opened ${created.did}, not ${did}`);
  savePasses(p.ownerDid, tokens.slice(1));
  const entry: PenNameEntry = { did, handle: created.handle, home: { url: p.server.url, serviceDid: p.server.serviceDid }, createdAt: new Date().toISOString() };
  savePenName(p.ownerDid, entry);
  return entry;
}

// ----------------------------------------------------------------- session ----

/** An OpenFederation server may answer with only the handle's first label; the full handle adds its domain. */
async function fullHandle(home: string, handle: string): Promise<string> {
  if (handle.includes('.')) return handle;
  const described = await call<{ availableUserDomains?: string[] }>(home, 'com.atproto.server.describeServer').catch(() => null);
  const domain = described?.availableUserDomains?.[0];
  return domain ? `${handle}${domain}` : handle;
}

/** Sign in as a pen name with its words. The login is signed for `home.serviceDid` only. */
export async function signInPenName(home: PenHome, phrase: string): Promise<PenSession> {
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
  if (s) await call(s.home.url, 'com.atproto.server.deleteSession', { jwt: s.refreshJwt, body: {} }).catch(() => undefined);
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

export function proofLink(origin: string, bundle: RevealBundleV2): string {
  return `${origin}/verify#${revealLinkFragment(bundle)}`;
}

/** Put the proof in both accounts' files, for anyone to read. Each account's token goes only to its own repository. */
export async function publishProof(p: { ownerPdsUrl: string; bundle: RevealBundleV2; ownerAccessJwt: string }): Promise<void> {
  const s = loadPenSession();
  if (!s) throw new MoveError('Sign in as the pen name first.');
  if (trim(s.home.url) !== trim(p.ownerPdsUrl)) throw new MoveError('The pen name lives on another server; publish from an app that signs in to both.');
  await publishReveal({ pdsUrl: p.ownerPdsUrl, bundle: p.bundle, pseudonymAccessJwt: s.accessJwt, ownerAccessJwt: p.ownerAccessJwt });
}

/** An in-person proof: the pen name's words sign a word someone says. */
export async function inPersonProof(p: { origin: string; plcUrl: string; penPhrase: string; penDid: string; word: string }): Promise<{ link: string; valid: boolean }> {
  const challenge = challengeForWord(p.word, PRESENCE_CONTEXT);
  const { signature } = signPresence({ phrase: p.penPhrase, pseudonymDid: p.penDid, challenge });
  const checked = await checkPresence({ plcUrl: p.plcUrl, pseudonymDid: p.penDid, challenge, signature });
  return { link: `${p.origin}/verify#${presenceLinkFragment({ pseudonymDid: p.penDid, word: p.word, signature })}`, valid: checked.valid };
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
  ownerDid: string; entry: PenNameEntry; phrase: string; plcUrl: string; target: PenHome; newHandle: string; onStep: (s: MoveStep) => void;
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
  savePenName(p.ownerDid, entry);
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
export async function endPenName(p: { ownerDid: string; entry: PenNameEntry; phrase: string; plcUrl: string; onStep: (s: EndStep) => void }): Promise<{ leftovers: string[] }> {
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
  forgetPenName(p.ownerDid, p.entry.did);
  return { leftovers };
}
