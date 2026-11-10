/**
 * Author signatures on records a member wrote but the community stores.
 *
 * In a private community, members' forum content, votes and objections are
 * kept in the community's own repository (only members can read it) instead of
 * in each member's public repository. The repository's commit is signed by the
 * community, so on its own it would only show that the community says a member
 * wrote something. Each such record therefore names its `author` and carries
 * `authorSig`: the author's own signature over the CID of the record without
 * the signature. Anyone holding the record and the author's signing key can
 * check it, with no help from this server.
 *
 * Pure: no database, no network. The offline governance verifier uses this
 * with keys from DID documents the caller supplies; the server uses it with
 * the key history it reads from the PLC directory.
 */
import { cidForRecord } from '@atproto/repo';
import { verifySignature } from '@atproto/crypto';

export interface AuthorSignature {
  /** did:key of the key that signed: the author's atproto signing key at the time. */
  key: string;
  /** base64url signature over the CID of the record without `authorSig`. */
  sig: string;
}

/** The record as the author signed it: everything except `authorSig`. */
export function withoutAuthorSignature(record: Record<string, unknown>): Record<string, unknown> {
  const { authorSig: _authorSig, ...rest } = record;
  return rest;
}

/** The record's `author`, when it has one that is a DID. */
export function recordAuthor(record: Record<string, unknown> | null | undefined): string | null {
  const author = record?.author;
  return typeof author === 'string' && author.startsWith('did:') ? author : null;
}

function bytesFromBase64Url(value: string): Uint8Array {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * True when `authorSig` is a signature over this record by one of
 * `authorKeys` (the keys the author's DID holds, or has held, as its atproto
 * signing key). False for a missing or malformed signature, a changed record,
 * or a key the author never had.
 */
export async function authorSignatureValid(
  record: Record<string, unknown>,
  authorKeys: readonly string[],
): Promise<boolean> {
  const authorSig = record.authorSig as Partial<AuthorSignature> | undefined;
  if (!recordAuthor(record) || !authorSig || typeof authorSig.key !== 'string' || typeof authorSig.sig !== 'string') {
    return false;
  }
  if (!authorKeys.includes(authorSig.key)) return false;
  try {
    const cid = await cidForRecord(withoutAuthorSignature(record));
    return await verifySignature(authorSig.key, cid.bytes, bytesFromBase64Url(authorSig.sig));
  } catch {
    return false;
  }
}
