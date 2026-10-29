/**
 * did:plc genesis operation for a pseudonym. The owner key is the only
 * rotation key, and the commitment rides in alsoKnownAs. A did:plc is the
 * hash of its signed genesis op, so the commitment is part of the DID.
 */
import * as dagCbor from '@ipld/dag-cbor';
import { sha256 } from '@noble/hashes/sha2';
import { computeCommitment, commitmentUrn } from './formats.js';
import { signBytes } from './keys.js';

export interface PlcGenesisOp {
  type: 'plc_operation';
  prev: null;
  rotationKeys: string[];
  verificationMethods: { atproto: string };
  alsoKnownAs: string[];
  services: { atproto_pds: { type: 'AtprotoPersonalDataServer'; endpoint: string } };
}

export interface SignedPlcGenesisOp extends PlcGenesisOp {
  sig: string;
}

export function buildPseudonymGenesisOp(p: {
  ownerDidKey: string; signingDidKey: string; handle: string; pdsEndpoint: string; ownerDid: string; commitmentSaltHex: string;
}): PlcGenesisOp {
  return {
    type: 'plc_operation',
    prev: null,
    rotationKeys: [p.ownerDidKey],
    verificationMethods: { atproto: p.signingDidKey },
    alsoKnownAs: [`at://${p.handle}`, commitmentUrn(computeCommitment(p.ownerDid, p.commitmentSaltHex))],
    services: { atproto_pds: { type: 'AtprotoPersonalDataServer', endpoint: p.pdsEndpoint } },
  };
}

export function signGenesisOp(op: PlcGenesisOp, ownerPrivateKey: Uint8Array): SignedPlcGenesisOp {
  return { ...op, sig: signBytes(ownerPrivateKey, dagCbor.encode(op)) };
}

const B32 = 'abcdefghijklmnopqrstuvwxyz234567';
function base32Lower(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += B32[(value >>> bits) & 0x1f];
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 0x1f];
  return out;
}

export function didForSignedOp(op: SignedPlcGenesisOp): string {
  return `did:plc:${base32Lower(sha256(dagCbor.encode(op))).slice(0, 24)}`;
}

/** Any did:plc operation after genesis. `prev` is the CID of the operation before it. */
export interface PlcUpdateOp {
  type: 'plc_operation';
  prev: string;
  rotationKeys: string[];
  verificationMethods: Record<string, string>;
  alsoKnownAs: string[];
  services: { atproto_pds: { type: 'AtprotoPersonalDataServer'; endpoint: string } };
}

/** CIDv1 (dag-cbor, sha-256, base32) of a signed operation, as PLC uses for `prev`. */
export function cidForPlcOp(signedOp: object): string {
  const hash = sha256(dagCbor.encode(signedOp));
  const bytes = new Uint8Array(4 + hash.length);
  bytes.set([0x01, 0x71, 0x12, 0x20]);
  bytes.set(hash, 4);
  return `b${base32Lower(bytes)}`;
}

/**
 * Move a pseudonym to another PDS: same rotation key and commitment, with the
 * new PDS's endpoint and repo signing key, and optionally the handle it has
 * there (the `at://` entry is replaced; the commitment entry is kept). The
 * pseudonym's own key signs it, so no server has to agree.
 */
export function buildMoveOp(p: {
  previous: SignedPlcGenesisOp | (PlcUpdateOp & { sig: string });
  signingDidKey: string;
  pdsEndpoint: string;
  handle?: string;
}): PlcUpdateOp {
  const alsoKnownAs = p.handle
    ? [`at://${p.handle}`, ...p.previous.alsoKnownAs.filter((a) => !a.startsWith('at://'))]
    : [...p.previous.alsoKnownAs];
  return {
    type: 'plc_operation',
    prev: cidForPlcOp(p.previous),
    rotationKeys: [...p.previous.rotationKeys],
    verificationMethods: { ...p.previous.verificationMethods, atproto: p.signingDidKey },
    alsoKnownAs,
    services: { atproto_pds: { type: 'AtprotoPersonalDataServer', endpoint: p.pdsEndpoint } },
  };
}

export function signPlcOp(op: PlcUpdateOp, privateKey: Uint8Array): PlcUpdateOp & { sig: string } {
  return { ...op, sig: signBytes(privateKey, dagCbor.encode(op)) };
}
