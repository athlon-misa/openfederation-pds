/**
 * Changing custody modes (ADR-003, decision 5). One PLC update per change.
 *
 *   towards the person (custodial → assisted / self): the PDS signs with its
 *     key, after the user proves they hold the new rotation and owner keys;
 *   towards the PDS (self → assisted / custodial, assisted → custodial) and
 *     assisted → self: the user signs with their rotation key and submits to
 *     PLC; the PDS only checks PLC holds exactly the prepared operation.
 *
 * A password alone therefore never hands the identity to the PDS. The mode
 * in the database changes only once PLC shows the result.
 */
import { Secp256k1Keypair } from '@atproto/crypto';
import { getPlcLog } from './plc-client.js';
import { getShare } from '../vault/vault-store.js';
import { combineShares } from '../vault/shamir.js';
import { cidForPlcOp, type PlcUpdateOp } from '../../packages/openfederation-pseudonym/src/plc.js';
import type { CustodyMode } from './custody-policy.js';

export class CustodyChangeError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) { super(message); }
}

export type SignedOp = PlcUpdateOp & { sig: string };

/** What the client signs to prove it holds the new keys. */
export function possessionText(did: string, operationCid: string): string {
  return `OpenFederation Custody Change v1\ndid: ${did}\noperation: ${operationCid}`;
}

/** CID of an operation without its signature: the id the client and server agree on. */
export function unsignedCid(op: PlcUpdateOp | SignedOp): string {
  const { sig: _sig, ...unsigned } = op as SignedOp;
  return cidForPlcOp(unsigned);
}

/** The rotation key this PDS holds for the account (shares 2 + 3), as a did:key; null if none. */
export async function heldRotationDidKey(did: string): Promise<string | null> {
  const [a, b] = await Promise.all([getShare(did, 2), getShare(did, 3)]);
  if (!a || !b) return null;
  const key = combineShares([a, b]);
  try { return (await Secp256k1Keypair.import(key)).did(); } finally { key.fill(0); }
}

export interface ChangeInputs {
  /** Towards the person: the user's new keys. */
  userRotationDidKey?: string;
  ownerDidKey?: string;
  /** Towards the PDS, when it needs a new key: the key it reserved at prepare. */
  pdsRotationDidKey?: string;
}

export interface Plan {
  op: PlcUpdateOp;
  cid: string;
  signer: 'pds' | 'user';
  /** A PDS key that must come out of the reservations (finalize stores it as shares). */
  newPdsKey: string | null;
  /** Shares to delete once PLC shows the change (target self). */
  dropShares: boolean;
}

const DID_KEY = /^did:key:zQ3s[1-9A-HJ-NP-Za-km-z]+$/;
const OWNER_DID_KEY = /^did:key:z(Q3s|Dn)[1-9A-HJ-NP-Za-km-z]+$/;

/** The next operation after `previous` that takes the account from `from` to `to`. */
export function planChange(previous: SignedOp, from: CustodyMode, to: CustodyMode, held: string | null, inputs: ChangeInputs): Plan {
  if (from === to) throw new CustodyChangeError(400, 'InvalidRequest', `The account is already ${to}`);
  const vm = { ...previous.verificationMethods };
  let rotationKeys: string[];
  let signer: Plan['signer'];
  let newPdsKey: string | null = null;

  if (from === 'custodial') {
    // Towards the person: new user keys, the PDS signs.
    if (!inputs.userRotationDidKey || !DID_KEY.test(inputs.userRotationDidKey)) throw new CustodyChangeError(400, 'InvalidRequest', 'userRotationDidKey (secp256k1 did:key) is required');
    if (!inputs.ownerDidKey || !OWNER_DID_KEY.test(inputs.ownerDidKey)) throw new CustodyChangeError(400, 'InvalidRequest', 'ownerDidKey (secp256k1 or P-256 did:key) is required');
    if (!held) throw new CustodyChangeError(409, 'NotCustodial', 'This server holds no rotation key for the account');
    rotationKeys = to === 'assisted' ? [inputs.userRotationDidKey, held] : [inputs.userRotationDidKey];
    vm.openfederation_owner = inputs.ownerDidKey;
    signer = 'pds';
  } else {
    // The user's key is the first rotation key; they sign.
    const userKey = previous.rotationKeys[0];
    signer = 'user';
    if (to === 'self') {
      rotationKeys = [userKey];
    } else {
      let pdsKey = held;
      if (!pdsKey) {
        if (!inputs.pdsRotationDidKey || !DID_KEY.test(inputs.pdsRotationDidKey)) throw new CustodyChangeError(400, 'InvalidRequest', 'pdsRotationDidKey from prepareCustodyChange is required');
        pdsKey = inputs.pdsRotationDidKey;
        newPdsKey = pdsKey;
      }
      rotationKeys = to === 'assisted' ? [userKey, pdsKey] : [pdsKey];
      if (to === 'custodial') delete vm.openfederation_owner;
    }
  }

  const op: PlcUpdateOp = {
    type: 'plc_operation',
    prev: cidForPlcOp(previous),
    rotationKeys,
    verificationMethods: vm,
    alsoKnownAs: [...previous.alsoKnownAs],
    services: { ...previous.services },
  };
  return { op, cid: cidForPlcOp(op), signer, newPdsKey, dropShares: to === 'self' };
}

export async function plcHistory(did: string): Promise<SignedOp[]> {
  const log = (await getPlcLog(did)) as SignedOp[] | null;
  if (!log || log.length === 0) throw new CustodyChangeError(409, 'InvalidRequest', 'The DID has no PLC history');
  return log;
}

/** Keep a rotation key as vault shares 2 and 3 (the key itself is never stored), inside the caller's transaction. */
export async function storeRotationKeyShares(client: import('pg').PoolClient, did: string, keyBytes: Buffer): Promise<void> {
  const { splitSecret } = await import('../vault/shamir.js');
  const { encryptKeyBytes } = await import('../auth/encryption.js');
  const crypto = await import('node:crypto');
  const shares = splitSecret(keyBytes, 3, 2);
  for (const index of [2, 3]) {
    await client.query(
      `INSERT INTO vault_shares (id, user_did, share_index, encrypted_share, share_holder, recovery_tier)
       VALUES ($1, $2, $3, $4, 'vault', 1)
       ON CONFLICT (user_did, share_index) DO UPDATE SET encrypted_share = EXCLUDED.encrypted_share,
         share_holder = 'vault', escrow_provider_did = NULL, recovery_tier = 1, updated_at = CURRENT_TIMESTAMP`,
      [crypto.randomUUID(), did, index, await encryptKeyBytes(Buffer.from(shares[index - 1], 'utf-8'), 'vault.share')]);
  }
}
