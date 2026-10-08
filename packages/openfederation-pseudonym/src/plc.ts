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
