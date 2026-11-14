/**
 * The proof that names the person's account, made on the signed-out pages
 * by an owner who holds their own keys (Assisted or Self). Pure functions,
 * no network, so the checks made before anything is signed can be tested on
 * their own.
 *
 * Three things must agree before the person's half is signed:
 * - the account: the sealed note (commitment) in the pen name's first public
 *   entry must name it. The note's opener (salt) comes from the pen name's own
 *   12 words, so it is never stored and never missing once they are typed.
 * - the account's own key: its DID document must publish an
 *   `openfederation_owner` key. Custodial accounts have none; their server
 *   signs their half, from the account page.
 * - the person's 12 words: the owner key they derive must be that key.
 */
import { commitmentsIn, computeCommitment } from '@open-federation/pseudonym';

const PLC_DID = /^did:plc:[a-z2-7]{24}$/;

/** Whether text is a did:plc, the only kind a pen name can be sealed to here. */
export function isPlcDid(text: string): boolean {
  return PLC_DID.test(text.trim());
}

/**
 * Whether the pen name's first public entry carries exactly one sealed note,
 * and it names `ownerDid` with this opener (the verifier's own rule).
 */
export function sealNames(alsoKnownAs: readonly string[] | undefined, ownerDid: string, saltHex: string): boolean {
  const notes = commitmentsIn(alsoKnownAs ?? []);
  if (notes.length !== 1) return false;
  try { return notes[0] === computeCommitment(ownerDid.trim(), saltHex); } catch { return false; }
}

export type OwnerKeyCheck =
  /** The words hold the key the account publishes: the person can sign. */
  | 'ok'
  /** The account publishes no key of its own: Custodial (its server signs), or from a server that does not give one. */
  | 'no-owner-key'
  /** The account has its own key, and these words do not hold it. */
  | 'other-key';

/** Compare the owner key the person's words derive with the one the account's DID document publishes. */
export function checkOwnerKey(published: string | null | undefined, derived: string): OwnerKeyCheck {
  if (!published) return 'no-owner-key';
  return published === derived ? 'ok' : 'other-key';
}

/** What to tell the person when the check is not 'ok'. */
export const OWNER_KEY_PROBLEM: Record<Exclude<OwnerKeyCheck, 'ok'>, string> = {
  'no-owner-key': 'This account has no key of its own in the public directory, so these words cannot sign for it. If your account is Custodial, this server holds its key and signs your half: make this proof on your account’s Pen names page, signed in.',
  'other-key': 'These 12 words do not hold this account’s key. Check that they are your own account’s words (not the pen name’s), in order. Nothing was signed. If your account is Custodial, this server signs your half instead: make this proof on your account’s Pen names page, signed in.',
};

/** The few parts of browser storage read here. */
export interface StorageLike {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
}

const LIST_PREFIX = 'of.penNames.list.';
const ACCOUNT_KEYS = ['of.penNames.list.', 'of.penNames.passes.', 'of.penNames.collected.'];
/** Where the dashboard keeps the person's sign-in (lib/signed-out-area); only its `did` is read. */
const AUTH_KEY = 'openfed-auth';
/** This tab only: which account a pen name created in this tab was sealed to. */
export const SEALED_TO_KEY = (penDid: string) => `of.penNames.sealedTo.${penDid}`;

function readJson(storage: StorageLike, key: string): unknown {
  try { const raw = storage.getItem(key); return raw ? JSON.parse(raw) : null; } catch { return null; }
}

/**
 * Accounts this browser already knows, best first: the one this tab created
 * the pen name for; an account whose own list holds the pen name; accounts
 * that kept passes or a pen-name list here; the account signed in to the
 * dashboard in this browser. Only DIDs are read, never a session. Each is
 * still checked against the sealed note before it is offered.
 */
export function ownerCandidates(penDid: string, tab: StorageLike | null, local: StorageLike | null): string[] {
  const out: string[] = [];
  const add = (d: unknown) => { if (typeof d === 'string' && isPlcDid(d) && d !== penDid && !out.includes(d)) out.push(d); };
  // Stored as JSON (a quoted string) by the pen-name storage; a bare DID is accepted too.
  if (tab) add(readJson(tab, SEALED_TO_KEY(penDid)) ?? tab.getItem(SEALED_TO_KEY(penDid)));
  if (local) {
    const keys: string[] = [];
    for (let i = 0; i < local.length; i++) { const k = local.key(i); if (k) keys.push(k); }
    for (const k of keys) {
      if (!k.startsWith(LIST_PREFIX)) continue;
      const list = readJson(local, k);
      if (Array.isArray(list) && list.some((e) => (e as { did?: unknown })?.did === penDid)) add(k.slice(LIST_PREFIX.length));
    }
    for (const k of keys) {
      const prefix = ACCOUNT_KEYS.find((p) => k.startsWith(p));
      if (prefix) add(k.slice(prefix.length));
    }
    add((readJson(local, AUTH_KEY) as { state?: { did?: unknown } } | null)?.state?.did);
  }
  return out;
}

/** The first known account the pen name is sealed to, or null. */
export function sealedOwner(candidates: readonly string[], alsoKnownAs: readonly string[] | undefined, saltHex: string): string | null {
  return candidates.find((d) => sealNames(alsoKnownAs, d, saltHex)) ?? null;
}
