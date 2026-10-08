/**
 * Canonical pseudonym formats: every signed text, the commitment and the
 * token epoch. Single source of truth: the PDS imports this file by relative
 * path, so client and verifier can never disagree about bytes. Depends only
 * on @noble/hashes; keep it that way.
 */
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';

export const COMMITMENT_URN_PREFIX = 'urn:openfederation:pseudonym-commitment:v1:';
const HEX64 = /^[0-9a-f]{64}$/;
const DID = /^did:[a-z]+:[A-Za-z0-9._:%-]+$/;

function assertDid(value: string, field: string): void {
  if (!DID.test(value)) throw new Error(`Invalid ${field}`);
}

export function computeCommitment(ownerDid: string, saltHex: string): string {
  assertDid(ownerDid, 'ownerDid');
  if (!HEX64.test(saltHex)) throw new Error('Invalid salt');
  return bytesToHex(sha256(utf8ToBytes(['OpenFederation Pseudonym Commitment v1', ownerDid, saltHex].join('\n'))));
}

export function commitmentUrn(commitmentHex: string): string {
  if (!HEX64.test(commitmentHex)) throw new Error('Invalid commitment');
  return COMMITMENT_URN_PREFIX + commitmentHex;
}

export function commitmentsIn(alsoKnownAs: readonly string[]): string[] {
  return alsoKnownAs
    .filter((a) => a.startsWith(COMMITMENT_URN_PREFIX))
    .map((a) => a.slice(COMMITMENT_URN_PREFIX.length))
    .filter((h) => HEX64.test(h));
}

export function buildLinkStatement(p: { pseudonymDid: string; ownerDid: string; issuedAt: string }): string {
  assertDid(p.pseudonymDid, 'pseudonymDid');
  assertDid(p.ownerDid, 'ownerDid');
  if (Number.isNaN(Date.parse(p.issuedAt)) || new Date(p.issuedAt).toISOString() !== p.issuedAt) {
    throw new Error('Invalid issuedAt');
  }
  return ['OpenFederation Pseudonym Link v1', `pseudonym: ${p.pseudonymDid}`, `owner: ${p.ownerDid}`, `issued: ${p.issuedAt}`].join('\n');
}

export function parseLinkStatement(text: string): { pseudonymDid: string; ownerDid: string; issuedAt: string } | null {
  const m = /^OpenFederation Pseudonym Link v1\npseudonym: (\S+)\nowner: (\S+)\nissued: (\S+)$/.exec(text);
  if (!m) return null;
  const parsed = { pseudonymDid: m[1], ownerDid: m[2], issuedAt: m[3] };
  try {
    return buildLinkStatement(parsed) === text ? parsed : null;
  } catch {
    return null;
  }
}

export function buildLoginMessage(p: { serviceDid: string; challenge: string }): string {
  assertDid(p.serviceDid, 'serviceDid');
  if (!HEX64.test(p.challenge)) throw new Error('Invalid challenge');
  return ['OpenFederation Pseudonym Login v1', `service: ${p.serviceDid}`, `challenge: ${p.challenge}`].join('\n');
}

export function buildPresenceMessage(p: { pseudonymDid: string; challenge: string }): string {
  assertDid(p.pseudonymDid, 'pseudonymDid');
  if (!HEX64.test(p.challenge)) throw new Error('Invalid challenge');
  return ['OpenFederation Pseudonym Presence v1', `pseudonym: ${p.pseudonymDid}`, `challenge: ${p.challenge}`].join('\n');
}

export function base64UrlEncode(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlDecode(s: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error('Invalid base64url');
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export function currentEpoch(now: Date = new Date()): string {
  return now.toISOString().slice(0, 7);
}

export function previousEpoch(epoch: string): string {
  const [y, m] = epoch.split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}
